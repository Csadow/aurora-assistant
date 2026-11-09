import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomic,AppError,sha} from './vault.mjs';
import {taskLine,validDate} from './task-meta.mjs';
import {GoogleOAuth} from './google-oauth.mjs';
import {calendarSyncStatus} from './calendar-sync-status.mjs';
import {localZone,dateParts,shiftDate,taskSlot,eventSlot,eventBody,calendarBlocks,validateEventTime} from './calendar-time.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const stamp=t=>t?sha(JSON.stringify(Object.fromEntries(Object.entries(t).filter(([k])=>!['revision','line'].includes(k)).sort(([a],[b])=>a.localeCompare(b))))):null;
const ref=(calendar,id)=>`/calendars/${encodeURIComponent(calendar)}/events${id?'/'+encodeURIComponent(id):''}`;
const empty=()=>({version:1,calendars:[],selected:[],target:null,account:null,links:[],cache:null,review:null,error:null});
const eventCopy=e=>e&&Object.fromEntries(['id','etag','status','summary','start','end','location','transparency','eventType','recurrence','recurringEventId','attendees','extendedProperties'].filter(k=>e[k]!==undefined).map(k=>[k,k==='attendees'?e.attendees.map(a=>({self:!!a.self,responseStatus:a.responseStatus})):e[k]]));
const remoteStamp=e=>e?.status==='cancelled'?null:e?.etag||null;
const remoteLive=e=>e&&e.status!=='cancelled'?e:null;
export class GoogleCalendar {
 constructor({data,vault,fetchImpl,oauth,now=()=>Date.now()}){Object.assign(this,{vault,now});this.file=join(data,'google-calendar-state.json');this.oauth=oauth||new GoogleOAuth({data,fetchImpl,now});this.state=empty();this.queue=Promise.resolve();}
 async init(){await this.oauth.init();try{this.state=JSON.parse(await readFile(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
 serial(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
 async save(){await atomic(this.file,JSON.stringify(this.state));}
 start(){this.timer=setInterval(()=>{if(this.oauth.status().connected)this.refresh().catch(()=>{});},300000);this.timer.unref();if(this.oauth.status().connected)this.refresh().catch(()=>{});}
 close(){clearInterval(this.timer);this.oauth.close();}
 configure(document){return this.serial(()=>this.oauth.configure(document));}
 connect(){return this.serial(()=>this.oauth.connect());}
 disconnect(){return this.serial(async()=>{await this.oauth.disconnect();this.state=empty();await this.save();return this.status();});}
 syncStatus(tasks){return calendarSyncStatus(this.state,tasks,{connected:this.oauth.status().connected,now:this.now(),timezone:localZone()});}
 async summary(){return this.syncStatus(await this.vault.tasks());}
 async status(){
  const tasks=await this.vault.tasks(),counts=new Map();for(const t of tasks)if(t.id)counts.set(t.id,(counts.get(t.id)||0)+1);
  return {...this.oauth.status(),sync:this.syncStatus(tasks),error:this.oauth.error||this.state.error,calendars:this.state.calendars,selected:this.state.selected,target:this.state.target,account:this.state.account,lastSync:this.state.cache?.at||null,range:this.state.cache?{from:this.state.cache.from,to:this.state.cache.to}:null,timezone:localZone(),links:this.state.links.map(l=>({taskId:l.taskId,calendarId:l.calendarId,eventId:l.eventId,title:tasks.find(t=>t.id===l.taskId)?.text||l.base?.title||'Missing task'})),tasks:tasks.filter(t=>t.id&&counts.get(t.id)===1&&!t.scheduleError&&!t.done&&t.planDate&&!this.state.links.some(l=>l.taskId===t.id)),events:(this.state.cache?.events||[]).map(e=>{let reason=null;try{eventSlot(e);}catch(x){reason=x.message;}return {calendarId:e.calendarId,id:e.id,title:e.summary||'Busy',start:e.start,end:e.end,readOnly:reason||(!this.writable(e.calendarId)?'This calendar is read-only.':null),linked:this.state.links.some(l=>l.calendarId===e.calendarId&&l.eventId===e.id)};}),review:this.publicReview()};
 }
 writable(id){return ['owner','writer'].includes(this.state.calendars.find(c=>c.id===id)?.accessRole);}
 async pages(path){
  const items=[],seen=new Set();let token;
  do{const p=path+(token?(path.includes('?')?'&':'?')+'pageToken='+encodeURIComponent(token):''),r=await this.oauth.request(p);if(!Array.isArray(r.items))throw new AppError('Google returned an incomplete calendar list.',502);items.push(...r.items);token=r.nextPageToken;if(token&&(seen.has(token)||seen.size>=40)||items.length>10000)throw new AppError('Calendar result is too large or incomplete. Select fewer calendars.',413);seen.add(token);}while(token);
  return items;
 }
 refresh(){return this.serial(()=>this.refreshNow());}
 async refreshNow(){
  if(!this.oauth.status().connected)return this.status();
  try{
   const calendars=(await this.pages('/users/me/calendarList?maxResults=250')).filter(c=>c.accessRole!=='freeBusyReader').map(c=>({id:c.id,title:c.summary||c.id,accessRole:c.accessRole,primary:!!c.primary,timeZone:c.timeZone}));
   const account=calendars.find(c=>c.primary)?.id;if(!account)throw new AppError('Google did not return your primary calendar.',502);
   if(this.state.account&&account!==this.state.account)throw new AppError('The Google account changed. Disconnect before linking a different account.',409);
   const selected=this.state.account?this.state.selected:[account],target=this.state.account?this.state.target:account;
   if(selected.some(id=>!calendars.some(c=>c.id===id)))throw new AppError('A selected Google calendar is no longer available. Update your calendar selection.',409);
   const today=dateParts(this.now()).date,from=shiftDate(today,-7),to=shiftDate(today,91),events=[];
   // A complete bounded refresh handles recurring instances, edits, deletions and
   // moving events across the window without mixing syncToken query semantics.
   for(const id of selected){const query=new URLSearchParams({singleEvents:'true',maxResults:'2500',timeMin:from+'T00:00:00Z',timeMax:shiftDate(to,1)+'T00:00:00Z',timeZone:localZone()});for(const e of await this.pages(ref(id)+'?'+query)){validateEventTime(e);events.push({...eventCopy(e),calendarId:id});}if(events.length>20000)throw new AppError('Too many events for a complete download. Select fewer calendars.',413);}
   // Only an explicit GET/404 can establish deletion. A linked event may simply
   // have moved outside the bounded list window. Publish all observations together.
   const linked=[];
   for(const l of this.state.links){const e=events.find(e=>e.calendarId===l.calendarId&&e.id===l.eventId);const event=e?remoteLive(e):await this.remote(l.calendarId,l.eventId);if(event)validateEventTime(event);linked.push({calendarId:l.calendarId,eventId:l.eventId,event});}
   this.state.calendars=calendars;this.state.account=account;this.state.selected=selected;this.state.target=target;this.state.cache={at:this.now(),from:shiftDate(from,1),to,events,linked};this.state.error=null;await this.save();return this.status();
  }catch(e){this.state.error=e.status?e.message:'Calendar refresh failed. Your last downloaded events are still available.';await this.save();throw e;}
 }
 select({selected,target}){return this.serial(async()=>{
  if(!Array.isArray(selected)||!selected.length||selected.length>8||new Set(selected).size!==selected.length||selected.some(id=>!this.state.calendars.some(c=>c.id===id))||!selected.includes(target)||!this.writable(target))throw new AppError('Select up to eight calendars and a writable destination among them.');
  if(this.state.links.some(l=>!selected.includes(l.calendarId)))throw new AppError('Unlink tasks from a calendar before hiding it.');
  if(this.state.review?.items.some(i=>i.intent&&!i.done))throw new AppError('Finish or reconcile the interrupted review before changing calendars.');
  this.state.selected=selected;this.state.target=target;this.state.review=null;this.state.cache=null;await this.save();return this.refreshNow();
 });}
 async context({includeLinked=false}={}){
  if(!this.oauth.status().connected)return {enabled:false,events:[],revision:'off',warnings:[],complete:true};
  const c=this.state.cache,tasks=await this.vault.tasks();
  const events=(c?.events||[]).filter(e=>{
   if(includeLinked)return true;
   const link=this.state.links.find(l=>l.calendarId===e.calendarId&&l.eventId===e.id),t=link&&tasks.find(t=>t.id===link.taskId);
   // Suppress a duplicate only while both copies represent the same busy block.
   if(!t||t.done||!t.startTime)return true;try{return !same(eventSlot(e),taskSlot(t));}catch{return true;}
  });
  const warnings=[];if(this.state.error)warnings.push(this.state.error);if(!c||this.now()-c.at>900000)warnings.push('Google Calendar is stale. Refresh before relying on available time.');
  return {enabled:true,events,from:c?.from,to:c?.to,revision:sha(JSON.stringify([this.state.selected,c?.events])),complete:!!c&&!warnings.length,warnings,lastSync:c?.at||null};
 }
 async day(date,{fresh=false}={}){if(!validDate(date))throw new AppError('Choose a valid calendar date.');const c=fresh?await this.fresh(date):await this.context();return {...c,events:undefined,blocks:calendarBlocks(c.events,date),complete:c.complete&&(!c.enabled||date>=c.from&&date<c.to)};}
 async fresh(date){if(!validDate(date))throw new AppError('Choose a valid calendar date.');await this.refresh();const c=await this.context({includeLinked:true});if(c.enabled&&(!c.complete||date<c.from||date>=c.to))throw new AppError('Refresh Google Calendar and plan within its downloaded date range.',409);return c;}
 async guardSchedule(data){
  if(!this.oauth.status().connected||!data.requireReady)return;
  const c=await this.fresh(data.planDate);if(data.calendarRevision&&data.calendarRevision!==c.revision)throw new AppError('Google Calendar changed. Suggest a fresh schedule.',409);
  if(data.startTime){const start=Number(data.startTime.slice(0,2))*60+Number(data.startTime.slice(3));if(calendarBlocks(c.events,data.planDate).some(b=>start<b.end&&start+data.duration>b.start))throw new AppError('This block overlaps Google Calendar. Suggest a fresh schedule.',409);}
 }
 findTask(tasks,id){const matches=tasks.filter(t=>t.id===id);if(matches.length>1)throw new AppError('A linked task ID occurs more than once. Repair the duplicate before syncing.',409);const t=matches[0]||null;if(t?.scheduleError)throw new AppError('Repair the linked task metadata before syncing.',409);return t;}
 async remote(calendarId,eventId){return remoteLive(eventCopy(await this.oauth.request(ref(calendarId,eventId),{allowMissing:true})));}
 publicReview(){const r=this.state.review;if(!r)return null;return {id:r.id,created:r.created,timezone:r.timezone,items:r.items.map(i=>({key:i.key,taskId:i.link.taskId,title:i.local?.text||i.remote?.summary||i.link?.base?.title||'Task',kind:i.kind,local:taskSlot(i.local),google:i.remote?eventSlot(i.remote,r.timezone):null,allowed:i.intent?[i.intent.direction]:i.allowed,done:!!i.done,uncertain:!!i.intent&&!i.done,error:i.error||null})),warnings:r.warnings||[]};}
 preview({taskIds=[],eventRefs=[],focusTask=null,reviewId=null}={}){return this.serial(async()=>{
  if(!Array.isArray(taskIds)||!Array.isArray(eventRefs)||taskIds.length+eventRefs.length>50||new Set(taskIds).size!==taskIds.length)throw new AppError('Choose up to fifty tasks or events.');
  if(focusTask){
   if(typeof focusTask!=='object'||typeof focusTask.id!=='string'||!focusTask.id||taskIds.length||eventRefs.length)throw new AppError('Choose one current planner task.');
   if((this.state.review?.id||null)!==reviewId||this.state.review?.items.some(i=>!i.done))throw new AppError('A saved sync review needs attention. Finish or discard it before reviewing this task.',409);
  }
  if(this.state.review?.items.some(i=>i.intent&&!i.done))throw new AppError('An interrupted sync needs reconciliation. Retry its reviewed changes first.',409);
  await this.refreshNow();if(!this.oauth.status().connected)throw new AppError('Connect Google Calendar first.');
  const tasks=await this.vault.tasks(),items=[],warnings=[];
  if(focusTask){const current=this.findTask(tasks,focusTask.id);if(!current||stamp(current)!==stamp(focusTask))throw new AppError('This planner task changed. Refresh tasks and open its calendar review again.',409);if(!this.state.links.some(l=>l.taskId===current.id))taskIds=[current.id];}
  const add=(kind,local,remote,link,allowed)=>{items.push({key:randomUUID(),kind,local:local&&structuredClone(local),remote:remote&&structuredClone(remote),link:structuredClone(link),allowed,localStamp:stamp(local),etag:remoteStamp(remote)});};
  for(const link of this.state.links){
   if(focusTask&&link.taskId!==focusTask.id)continue;
   try{
    const local=this.findTask(tasks,link.taskId),remote=await this.remote(link.calendarId,link.eventId),l=taskSlot(local),r=eventSlot(remote);
    const lc=!same(l,link.base),rc=!same(r,link.base);
    if(!lc&&!rc)continue;
    let allowed=lc&&rc&&!same(l,r)?['google','aurora']:lc?['aurora']:['google'];
    if(!local&&r)allowed=allowed.filter(x=>x!=='google'); // Never silently recreate a removed to-do.
    if(!this.writable(link.calendarId))allowed=allowed.filter(x=>x!=='aurora');
    if(!allowed.length){warnings.push('Cannot sync '+(link.base?.title||'task')+': calendar is read-only or the task was removed. Unlink it to stop tracking.');continue;}
    add(same(l,r)?'agree':lc&&rc?'conflict':lc?'to_google':'to_aurora',local,remote,link,allowed);
   }catch(e){if([401,503,502].includes(e.status))throw e;warnings.push((link.base?.title||'Linked event')+': '+e.message);}
  }
  for(const id of taskIds){
   if(this.state.links.some(l=>l.taskId===id))throw new AppError('This task is already linked. Refresh the selection.',409);
   const task=this.findTask(tasks,id);if(!task||task.done||!taskSlot(task))throw new AppError('Choose a current, scheduled, unfinished task.',409);eventBody(taskSlot(task));
   if(!this.writable(this.state.target))throw new AppError('Choose a writable destination calendar.');
   const link={taskId:id,calendarId:this.state.target,eventId:randomUUID().replaceAll('-',''),base:null};add('create_google',task,null,link,['aurora']);
  }
  const seen=new Set();for(const r of eventRefs){
   if(!r||typeof r.calendarId!=='string'||typeof r.id!=='string'||!this.state.selected.includes(r.calendarId)||!this.writable(r.calendarId)||seen.has(r.calendarId+'\n'+r.id)||this.state.links.some(l=>l.calendarId===r.calendarId&&l.eventId===r.id))throw new AppError('Choose distinct, unlinked personal events from a writable selected calendar.');seen.add(r.calendarId+'\n'+r.id);
   const remote=await this.remote(r.calendarId,r.id);if(!remote)throw new AppError('This event was deleted. Refresh the calendar.',409);eventSlot(remote);
   add('create_aurora',null,remote,{taskId:randomUUID(),calendarId:r.calendarId,eventId:r.id,base:null},['google']);
  }
  this.state.review={id:randomUUID(),created:this.now(),timezone:localZone(),items,warnings};await this.save();return this.publicReview();
 });}
 unlink(taskId){return this.serial(async()=>{if(this.state.review?.items.some(i=>i.intent&&!i.done))throw new AppError('Reconcile the interrupted sync first.');this.state.links=this.state.links.filter(l=>l.taskId!==taskId);this.state.review=null;await this.save();return this.status();});}
 discard(id,acknowledgeUncertain=false){return this.serial(async()=>{
  const r=this.state.review;if(r?.id!==id)throw new AppError('Review changed.',409);
  const pending=r.items.filter(i=>i.intent&&!i.done);
  if(pending.length&&!acknowledgeUncertain)throw new AppError('Reconcile the interrupted sync, or explicitly end it without undoing saved changes.');
  // Preserve the original baseline so the next review detects partial effects.
  // New pairs are retained only if both copies now exist; no remote writes here.
  for(const i of pending){const local=this.findTask(await this.vault.tasks(),i.link.taskId),remote=await this.remote(i.link.calendarId,i.link.eventId);if(local&&remote&&!this.state.links.some(l=>l.taskId===i.link.taskId))this.state.links.push({...i.link});}
  await atomic(join(this.file+'-history',r.id+'.json'),JSON.stringify({...r,ended:this.now(),acknowledgeUncertain}));
  this.state.review=null;await this.save();return this.status();
 });}
 apply({id,choices}){return this.serial(async()=>{
  await this.refreshNow();
  const r=this.state.review;if(!r||r.id!==id||r.timezone!==localZone())throw new AppError('The review or timezone changed. Prepare a fresh review.',409);
  if(!Array.isArray(choices)||!choices.length||choices.length>100||new Set(choices.map(c=>c.key)).size!==choices.length)throw new AppError('Choose changes to apply.');
  const chosen=choices.map(c=>{const i=r.items.find(i=>i.key===c.key);if(!i||!i.allowed.includes(c.direction)||i.intent&&i.intent.direction!==c.direction)throw new AppError('Choose a direction offered by this review.');return {i,direction:c.direction};});
  for(const {i,direction} of chosen){if(i.done)continue;
   try{await this.applyItem(r,i,direction);i.done=true;i.error=null;await this.save();}
   catch(e){i.error=e.status?e.message:'Sync was interrupted. Retry the same review to reconcile saved changes.';await this.save();throw new AppError(i.error+' Already applied changes are retained.',e.status||503);}
  }
  await this.refreshNow().catch(()=>{});return this.publicReview();
 });}
 async applyItem(review,item,direction){
  let local=this.findTask(await this.vault.tasks(),item.link.taskId),remote=await this.remote(item.link.calendarId,item.link.eventId);
  if(!item.intent){
   if(this.now()-review.created>900000||stamp(local)!==item.localStamp||remoteStamp(remote)!==item.etag)throw new AppError('A task or Google event changed, or this review expired. Prepare a fresh review.',409);
   const desired=direction==='aurora'?taskSlot(local):eventSlot(remote),intent={direction,desired,localStamp:stamp(local),etag:remoteStamp(remote),beforeRemote:remote,phase:'prepared'};
   if(direction==='aurora'){
    if(!this.writable(item.link.calendarId))throw new AppError('The destination calendar is read-only.');
    if(desired)intent.body={...eventBody(desired),...(remote?{}:{id:item.link.eventId,extendedProperties:{private:{auroraTask:item.link.taskId}}})};
   }else{
    const path=local?.path||'40 Tasks/Google Calendar.md';let note;try{note=await this.vault.read(path);}catch(e){if(e.status!==404)throw e;note={content:'# Google Calendar tasks\n',revision:null};}
    const lines=note.content.split('\n');
    if(local){const metadata={...local,planDate:desired?.date||null,startTime:desired?.time||null,duration:desired?.duration??local.duration};lines[local.line]=lines[local.line].replace(/^(\s*[-*] \[[ xX]\] ).+$/,(_,prefix)=>prefix+taskLine(desired?.title||local.text,metadata,local.id));}
    else if(desired){lines.push('- [ ] '+taskLine(desired.title,{planDate:desired.date,startTime:desired.time,duration:desired.duration??30},item.link.taskId));}
    intent.note={path,revision:note.revision,content:lines.join('\n')};
   }
   item.intent=intent;await this.save();
  }
  const intent=item.intent;await this.save();
  if(direction==='aurora'){
   const matches=same(eventSlot(remote),intent.desired);
   // A lost reply is reconciled by the stable event ID and intended fields.
   const owned=remote?.extendedProperties?.private?.auroraTask===item.link.taskId;
   const created=item.kind==='create_google';
   if(!matches||created&&remote&&!owned){
    if(this.now()-review.created>900000)throw new AppError('This review expired. End it and prepare a fresh review before another write.',409);
    if(stamp(local)!==intent.localStamp||remoteStamp(remote)!==intent.etag)throw new AppError('Sync changed while interrupted. No further write was made; unlink this task or resolve the current event before retrying.',409);
    if(intent.desired){
     await this.oauth.request(ref(item.link.calendarId,remote?item.link.eventId:null),{method:remote?'PATCH':'POST',etag:remote?.etag,body:intent.body});
    }else if(remote)await this.oauth.request(ref(item.link.calendarId,item.link.eventId),{method:'DELETE',etag:remote.etag});
    remote=await this.remote(item.link.calendarId,item.link.eventId);
   }
   if(!same(eventSlot(remote),intent.desired))throw new AppError('Google read-back differs from the approved change. Refresh and reconcile before continuing.',409);
  }else{
   const n=intent.note;let current;try{current=await this.vault.read(n.path);}catch(e){if(e.status!==404)throw e;current={revision:null};}
   if(current.revision!==sha(n.content)){
    if(this.now()-review.created>900000)throw new AppError('This review expired. End it and prepare a fresh review before another write.',409);
    if(current.revision!==n.revision||stamp(local)!==intent.localStamp||remoteStamp(remote)!==intent.etag)throw new AppError('A task note or Google event changed during sync. No further write was made.',409);
    await this.vault.save(n.path,n.content,n.revision,{taskSource:{kind:'google_calendar',reviewId:review.id},beforeCommit:async()=>{if(remoteStamp(await this.remote(item.link.calendarId,item.link.eventId))!==intent.etag)throw new AppError('The Google event changed during saving.',409);}});
   }
  }
  this.state.links=this.state.links.filter(l=>l.taskId!==item.link.taskId);
  if(intent.desired)this.state.links.push({...item.link,base:intent.desired});
 }
}
