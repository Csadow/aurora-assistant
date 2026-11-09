import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Vault} from '../src/vault.mjs';
import {Store} from '../src/store.mjs';
import {GoogleCalendar} from '../src/google-calendar.mjs';
import {GoogleOAuth,GOOGLE_SCOPES} from '../src/google-oauth.mjs';
import {eventBody,eventSlot,calendarBlocks,dateParts,localZone} from '../src/calendar-time.mjs';
import {buildWeek} from '../src/weekly-planner.mjs';
import {DayPlanning} from '../src/day-planning.mjs';
import {googleFixture} from './fixtures/google-calendar.mjs';
import {TaskProposals} from '../src/task-proposals.mjs';
import {Assistant} from '../src/assistant.mjs';

const slot={title:'Write report',date:'2026-10-26',time:'10:00',duration:30};
const client={installed:{client_id:'fixture.apps.googleusercontent.com',client_secret:'fixture-secret'}};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-google-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data'));await vault.init();await store.init();
 const google=googleFixture(),clock={value:new Date(2026,9,26,8).getTime()},opts={data:join(dir,'data'),vault,fetchImpl:google.fetchImpl,now:()=>clock.value};
 const calendar=new GoogleCalendar(opts);await calendar.init();t.after(()=>calendar.close());
 await calendar.configure(client);calendar.oauth.value.tokens={access_token:'private-access',refresh_token:'private-refresh',expiresAt:clock.value+3600000};await calendar.oauth.save();
 const add=async(text=slot.title,changes={})=>{await vault.addTask(text,{planDate:slot.date,startTime:slot.time,duration:slot.duration,...changes});return (await vault.tasks()).at(-1);};
 const apply=(review,direction)=>calendar.apply({id:review.id,choices:review.items.filter(i=>!i.done).map(i=>({key:i.key,direction:direction||i.allowed[0]}))});
 const link=async()=>{const task=await add(),p=await calendar.preview({taskIds:[task.id]});await apply(p);return {task,event:google.events.values().next().value};};
 return {dir,vault,store,calendar,google,clock,opts,add,apply,link};
}
test('two-way create, Google edit, Aurora edit and remote deletion preserve task identity and metadata',async t=>{
 const f=await fixture(t),task=await f.add('Report',{due:'2026-10-27',remindAt:'2026-10-26T11:00:00Z'});
 const before=await f.vault.tasks(),preview=await f.calendar.preview({taskIds:[task.id]});assert.deepEqual(await f.vault.tasks(),before);assert.equal(f.google.writes().length,0);
 await f.apply(preview);assert.equal(f.google.events.size,1);let e=[...f.google.events.values()][0];assert.equal(e.extendedProperties.private.auroraTask,task.id);
 f.google.put({...e,...eventBody({...slot,title:'Changed in Google',time:'12:00',duration:45})},e.id);
 let p=await f.calendar.preview();assert.equal(p.items[0].kind,'to_aurora');await f.apply(p);
 let current=(await f.vault.tasks())[0];assert.equal(current.text,'Changed in Google');assert.equal(current.startTime,'12:00');assert.equal(current.duration,45);assert.equal(current.id,task.id);assert.equal(current.due,task.due);assert.equal(current.remindAt,task.remindAt);assert.equal(current.done,false);
 await f.vault.scheduleTask({...current,text:'Changed in Aurora',startTime:'13:00'});await f.apply(await f.calendar.preview());assert.equal(f.google.events.get(e.id).summary,'Changed in Aurora');
 f.google.events.delete(e.id);p=await f.calendar.preview();assert.equal(p.items[0].google,null);await f.apply(p);current=(await f.vault.tasks())[0];assert.equal(current.planDate,null);assert.equal(current.done,false);assert.equal(current.id,task.id);assert.equal(f.calendar.state.links.length,0);
});
test('local unschedule deletes only its linked Google block; local to-do stays',async t=>{
 const f=await fixture(t),{task,event}=await f.link();await f.vault.scheduleTask({...task,planDate:null,startTime:null});const p=await f.calendar.preview();assert.equal(p.items[0].local,null);await f.apply(p);assert(!f.google.events.has(event.id));assert.equal((await f.vault.tasks()).length,1);assert.equal(f.google.writes().filter(c=>c.method==='DELETE').length,1);await f.apply(p);assert.equal(f.google.writes().filter(c=>c.method==='DELETE').length,1);
});
test('two-sided changes require an explicit resolution and preserve the unchosen fields',async t=>{
 const f=await fixture(t),{task,event}=await f.link();await f.vault.scheduleTask({...task,text:'Local version'});f.google.put({...event,summary:'Google version',description:'private unrelated field'},event.id);let p=await f.calendar.preview();assert.equal(p.items[0].kind,'conflict');assert.deepEqual(p.items[0].allowed,['google','aurora']);await f.apply(p,'aurora');assert.equal(f.google.events.get(event.id).summary,'Local version');assert.equal(f.google.events.get(event.id).description,'private unrelated field');assert.equal(f.google.writes().at(-1).body.description,undefined);
});
test('stale local or Google changes reject before mutation; cancelled reviews do nothing',async t=>{
 const f=await fixture(t),task=await f.add(),p=await f.calendar.preview({taskIds:[task.id]});await f.vault.scheduleTask({...task,text:'New local edit'});await assert.rejects(f.apply(p),/changed/);assert.equal(f.google.writes().length,0);await f.calendar.discard(p.id);
 const q=await f.calendar.preview({taskIds:[task.id]});f.clock.value+=900001;await assert.rejects(f.apply(q),/expired/);assert.equal(f.google.writes().length,0);await f.calendar.discard(q.id);
});
test('If-Match prevents a last-moment remote overwrite',async t=>{
 const f=await fixture(t),{task,event}=await f.link();await f.vault.scheduleTask({...task,text:'Local update'});const p=await f.calendar.preview();f.google.state.beforeWrite=()=>{f.google.put({...f.google.events.get(event.id),summary:'Concurrent remote edit'},event.id);f.google.state.beforeWrite=null;};await assert.rejects(f.apply(p),/changed/);assert.equal(f.google.events.get(event.id).summary,'Concurrent remote edit');await f.calendar.discard(p.id,true);assert.equal((await f.calendar.preview()).items[0].kind,'conflict');
});
for(const method of ['POST','PATCH','DELETE'])test('lost '+method+' reply reconciles after restart without repeating the remote write',async t=>{
 const f=await fixture(t);let p;
 if(method==='POST'){const task=await f.add();p=await f.calendar.preview({taskIds:[task.id]});}
 else{const {task}=await f.link();await f.vault.scheduleTask({...task,...(method==='PATCH'?{text:'New title'}:{planDate:null,startTime:null})});p=await f.calendar.preview();}
 f.google.state.loseReply=method;await assert.rejects(f.apply(p),/may have finished/);const count=f.google.writes().length;
 const restarted=new GoogleCalendar(f.opts);await restarted.init();t.after(()=>restarted.close());const result=await restarted.apply({id:p.id,choices:p.items.map(i=>({key:i.key,direction:'aurora'}))});assert(result.items.every(i=>i.done));assert.equal(f.google.writes().length,count);assert.equal(f.google.events.size,method==='DELETE'?0:1);
});
test('Google import creates a stable Markdown task; interrupted note receipt reconciles after restart',async t=>{
 const f=await fixture(t),event=f.google.put(eventBody(slot)),p=await f.calendar.preview({eventRefs:[{calendarId:f.google.calendar,id:event.id}]}),save=f.vault.save.bind(f.vault);let fail=true;
 f.vault.save=async(...args)=>{const out=await save(...args);if(fail){fail=false;throw Error('lost file receipt');}return out;};await assert.rejects(f.apply(p),/interrupted/);assert.equal((await f.vault.tasks()).length,1);f.vault.save=save;
 const restarted=new GoogleCalendar(f.opts);await restarted.init();await restarted.apply({id:p.id,choices:p.items.map(i=>({key:i.key,direction:'google'}))});assert.equal((await f.vault.tasks()).length,1);assert.equal(restarted.state.links.length,1);assert.equal(f.google.writes().length,0);
});
test('batch imports sharing a note preserve both tasks and do not overwrite other note content',async t=>{
 const f=await fixture(t),a=f.google.put(eventBody(slot)),b=f.google.put(eventBody({...slot,title:'Second task',time:'14:00'}));const p=await f.calendar.preview({eventRefs:[a,b].map(e=>({calendarId:f.google.calendar,id:e.id}))});await f.apply(p);assert.deepEqual((await f.vault.tasks()).map(t=>t.text).sort(),['Second task','Write report']);assert.equal(f.calendar.state.links.length,2);
});
test('refresh paginates, removes deleted instances and preserves cache when offline',async t=>{
 const f=await fixture(t),a=f.google.put(eventBody(slot));f.google.put(eventBody({...slot,title:'Later',time:'14:00'}));f.google.state.pages=true;await f.calendar.refresh();assert.equal((await f.calendar.context()).events.length,2);f.google.events.delete(a.id);await f.calendar.refresh();assert.equal((await f.calendar.context()).events.length,1);const cached=structuredClone(f.calendar.state.cache);f.google.state.offline=true;await assert.rejects(f.calendar.refresh());assert.deepEqual(f.calendar.state.cache,cached);const c=await f.calendar.context();assert.equal(c.complete,false);assert(c.warnings.length);await assert.rejects(f.calendar.fresh(slot.date));
});
test('recurrences and guests reserve time but cannot be imported for write-back',async t=>{
 const f=await fixture(t),rec=f.google.put({...eventBody(slot),recurringEventId:'series'}),meeting=f.google.put({...eventBody(slot),attendees:[{self:true,responseStatus:'accepted'}]});await f.calendar.refresh();assert.equal(calendarBlocks((await f.calendar.context()).events,slot.date).length,2);for(const e of [rec,meeting])await assert.rejects(f.calendar.preview({eventRefs:[{calendarId:f.google.calendar,id:e.id}]}),/read-only/);assert.equal(f.google.writes().length,0);
});
test('all-day exclusive end, multi-day clipping, timezone conversion, declined and transparent events',()=>{
 const events=[{id:'all',summary:'Holiday',start:{date:'2026-10-26'},end:{date:'2026-10-28'}},{id:'timed',start:{dateTime:'2026-10-25T23:00:00Z'},end:{dateTime:'2026-10-26T01:30:00Z'}},{id:'free',transparency:'transparent',...eventBody(slot)},{id:'declined',attendees:[{self:true,responseStatus:'declined'}],...eventBody(slot)}];
 const b=calendarBlocks(events,'2026-10-26','Asia/Atyrau');assert.equal(b.length,2);assert.deepEqual([b[0].start,b[0].end],[0,1440]);assert.deepEqual([b[1].start,b[1].end],[240,390]);assert.equal(calendarBlocks(events,'2026-10-28','Asia/Atyrau').length,0);assert.throws(()=>eventSlot(events[0]),/single-day/);assert.deepEqual(eventSlot(eventBody(slot)),slot);
});
test('calendar appears in briefing and week; replan reserves it and rejects changed calendar at apply',async t=>{
 const f=await fixture(t);f.google.put(eventBody({...slot,time:'08:00',duration:120}));await f.calendar.refresh();const task=await f.add('Missed',{startTime:'06:00'}),day=new DayPlanning({vault:f.vault,store:f.store,calendar:f.calendar,now:()=>new Date(f.clock.value)});assert((await day.briefing()).day.blocks.some(b=>b.kind==='calendar'));const week=buildWeek(await f.vault.list(),{date:slot.date,timezone:localZone(),now:new Date(f.clock.value),calendar:await f.calendar.context()});assert(week.days[0].blocks.some(b=>b.kind==='calendar'));
 const p=await day.preview({selected:[task],end:'18:00'});assert(p.changes[0].after.startTime>='10:00');f.google.put(eventBody({...slot,time:'10:00',duration:120}));await assert.rejects(day.decide(p.id,'accept'),/Google Calendar changed/);assert.equal((await f.vault.tasks())[0].startTime,'06:00');
});
test('matching timed links are not double counted; changed events remain visible as conflicts',async t=>{
 const f=await fixture(t),{event}=await f.link();assert.equal((await f.calendar.context()).events.length,0);assert.equal((await f.calendar.fresh(slot.date)).events.length,1,'schedule suggestions must reserve linked Google blocks until remote sync actually moves them');f.google.put({...event,...eventBody({...slot,time:'11:00'})},event.id);await f.calendar.refresh();assert.equal((await f.calendar.context()).events.length,1);
});
test('API status and persisted secrets have distinct visibility; disconnect leaves calendar and vault intact',async t=>{
 const f=await fixture(t);await f.link();const s=JSON.stringify(await f.calendar.status());assert(!s.includes('private-access'));assert(!s.includes('private-refresh'));assert(!s.includes('fixture-secret'));assert.equal((await stat(f.calendar.oauth.file)).mode&0o777,0o600);assert.equal((await stat(f.calendar.file)).mode&0o777,0o600);const before=await f.vault.tasks(),count=f.google.events.size;await f.calendar.disconnect();assert.equal((await f.calendar.status()).connected,false);assert.deepEqual(await f.vault.tasks(),before);assert.equal(f.google.events.size,count);assert(!((await readFile(f.calendar.oauth.file,'utf8')).includes('private-refresh')));
});
test('readonly destination, duplicate imports, duplicate task IDs and invalid times are rejected',async t=>{
 const f=await fixture(t);await f.calendar.refresh();await assert.rejects(f.calendar.select({selected:[f.google.other],target:f.google.other}),/writable/);const e=f.google.put(eventBody(slot)),r={calendarId:f.google.calendar,id:e.id};await assert.rejects(f.calendar.preview({eventRefs:[r,r]}),/distinct/);const task=await f.add(),note=await f.vault.read(task.path);await f.vault.save('40 Tasks/Duplicate.md',note.content,null);await assert.rejects(f.calendar.preview({taskIds:[task.id]}),/more than once/);assert.throws(()=>eventSlot({...eventBody(slot),end:{dateTime:new Date('2026-10-28T10:00:00Z').toISOString()}}),/Overnight/);
});
test('OAuth loopback validates state, uses PKCE, consumes callback once and keeps tokens private',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-oauth-'));t.after(()=>rm(dir,{recursive:true,force:true}));let exchanges=0,fields;
 const oauth=new GoogleOAuth({data:dir,fetchImpl:async(url,opts)=>{assert.equal(url,'https://oauth2.googleapis.com/token');exchanges++;fields=opts.body;return Response.json({access_token:'secret-access',refresh_token:'secret-refresh',expires_in:3600,scope:GOOGLE_SCOPES.join(' ')});}});t.after(()=>oauth.close());await oauth.init();await oauth.configure(client);const {url}=await oauth.connect(),u=new URL(url),callback=new URL(u.searchParams.get('redirect_uri'));assert.equal(callback.hostname,'127.0.0.1');assert.equal(u.searchParams.get('code_challenge_method'),'S256');callback.search=new URLSearchParams({code:'fixture-code',state:'wrong'});assert.equal((await fetch(callback)).status,400);assert.equal(exchanges,0);callback.searchParams.set('state',u.searchParams.get('state'));assert.equal((await fetch(callback)).status,200);assert.equal(exchanges,1);assert(fields.get('code_verifier').length>=43);assert.equal(oauth.status().connected,true);assert(!JSON.stringify(oauth.status()).includes('secret'));await assert.rejects(fetch(callback));
});
test('OAuth refresh preserves refresh token; partial grants and redirected credential requests are rejected',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-oauth-'));t.after(()=>rm(dir,{recursive:true,force:true}));let partial=false,calls=0;
 const oauth=new GoogleOAuth({data:dir,fetchImpl:async(url,opts)=>{calls++;assert.equal(opts.redirect,'error');return Response.json({access_token:'new-token',expires_in:3600,scope:partial?GOOGLE_SCOPES[0]:GOOGLE_SCOPES.join(' ')});}});await oauth.configure(client);oauth.value.tokens={refresh_token:'keep',expiresAt:0};assert.deepEqual(await Promise.all([oauth.access(),oauth.access()]),['new-token','new-token']);assert.equal(calls,1);assert.equal(oauth.value.tokens.refresh_token,'keep');partial=true;oauth.value.tokens.expiresAt=0;await assert.rejects(oauth.access(),/permissions/);
});

test('chat task proposals include Google overlaps and cannot apply after Google changes',async t=>{
 const f=await fixture(t),proposals=new TaskProposals(f);proposals.calendar=f.calendar;const event=f.google.put(eventBody(slot));
 const input={text:'Study',planDate:slot.date,startTime:slot.time,duration:30};const p=await proposals.propose(input);assert.equal(p.review.conflicts[0].kind,'calendar');await assert.rejects(proposals.decide(p.id,'accept'),/overlaps/);
 f.google.put({...event,summary:'New event title'},event.id);await assert.rejects(proposals.decide(p.id,'accept',{allowConflicts:true}),/schedule changed/);assert.equal((await f.vault.tasks()).length,0);
 const q=await proposals.propose(input);await proposals.decide(q.id,'accept',{allowConflicts:true});assert.equal((await f.vault.tasks()).length,1);
});
test('chat receives bounded untrusted calendar context without credentials or write tools',async t=>{
 const f=await fixture(t);f.clock.value=Date.now();f.calendar.oauth.value.tokens.expiresAt=f.clock.value+3600000;const today=dateParts(Date.now()).date;f.google.put(eventBody({...slot,date:today,title:'Busy appointment'}));await f.calendar.refresh();let captured;
 const assistant=new Assistant({...f,projects:{items:[]},ollama:{check:async()=>{},chat:async(messages,tools)=>{captured=messages[0].content;assert(!tools.some(t=>/calendar.*(write|delete|apply)/.test(t.function.name)));return {content:'Your calendar has a busy block.'};}}});assistant.calendar=f.calendar;
 const conversation=await f.store.conversation();await assistant.chat({id:conversation.id,message:'Plan my day'},AbortSignal.timeout(10000),()=>{});assert(captured.includes('GOOGLE CALENDAR (untrusted event data'));assert(captured.includes('Busy appointment'));assert(!captured.includes('private-access'));assert(!captured.includes('private-refresh'));
});
test('malformed remote times mark availability incomplete without discarding previous cache',async t=>{
 const f=await fixture(t);f.google.put(eventBody(slot));await f.calendar.refresh();const cache=structuredClone(f.calendar.state.cache);f.google.put({summary:'Missing time',start:{dateTime:'invalid'},end:{dateTime:'invalid'}});await assert.rejects(f.calendar.refresh(),/incomplete times/);assert.deepEqual(f.calendar.state.cache,cache);assert.equal((await f.calendar.context()).complete,false);
});
test('newer local work is never overwritten when reconciling an interrupted import',async t=>{
 const f=await fixture(t),event=f.google.put(eventBody(slot)),p=await f.calendar.preview({eventRefs:[{calendarId:f.google.calendar,id:event.id}]}),save=f.vault.save.bind(f.vault);f.vault.save=async()=>{throw Error('disk interrupted');};await assert.rejects(f.apply(p));f.vault.save=save;await f.vault.save('40 Tasks/Google Calendar.md','# My own note\n',null);await assert.rejects(f.apply(p),/changed during sync/);assert.equal((await f.vault.read('40 Tasks/Google Calendar.md')).content,'# My own note\n');await f.calendar.discard(p.id,true);assert.equal(f.calendar.state.review,null);
});
test('calendar API requires the app token for every mutation and validates day dates',async t=>{
 const f=await fixture(t),{createApp}=await import('../src/server.mjs'),app=await createApp({data:f.opts.data,vault:f.vault.root,projects:[],backups:join(f.dir,'backups'),calendarOptions:{fetchImpl:f.google.fetchImpl,now:f.opts.now},ollamaClient:{model:'fixture',status:async()=>({online:false}),chat:async()=>({content:''})}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>app.server.close(resolve)));const base='http://127.0.0.1:'+app.server.address().port,boot=await(await fetch(base+'/api/bootstrap')).json();
 for(const name of ['configure','connect','disconnect','refresh','select','preview','apply','discard','unlink','day'])assert.equal((await fetch(base+'/api/calendar/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/calendar',{headers:{Origin:'https://foreign.example'}})).status,403);assert.equal((await fetch(base+'/api/calendar/day?date=wrong')).status,400);
 const s=await(await fetch(base+'/api/calendar')).text();assert(!s.includes('private-access'));assert(!s.includes('fixture-secret'));assert.equal((await fetch(base+'/google-calendar.js')).status,200);
 const r=await fetch(base+'/api/calendar/preview',{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':boot.token},body:'{}'});assert.equal(r.status,200);assert.equal((await r.json()).items.length,0);
});

test('sync summary is local, credential-free and distinguishes both directions and conflicts',async t=>{
 const f=await fixture(t),{task,event}=await f.link();let s=await f.calendar.summary();assert.equal(s.counts.synced,1);assert.equal(s.fresh,true);
 const calls=f.google.calls.length;await f.vault.scheduleTask({...task,text:'Local changed'});s=await f.calendar.summary();assert.equal(s.counts.pending,1);assert.equal(s.links[0].status,'to_google');assert.equal(f.google.calls.length,calls);
 f.google.put({...event,summary:'Remote changed'},event.id);await f.calendar.refresh();s=await f.calendar.summary();assert.equal(s.counts.conflict,1);assert.equal(s.counts.pending,1);
 const now=(await f.vault.tasks())[0];await f.vault.scheduleTask({...now,text:task.text});s=await f.calendar.summary();assert.equal(s.links[0].status,'to_aurora');assert.equal(s.counts.conflict,0);
 assert(!JSON.stringify(s).includes('private-access'));assert(!JSON.stringify(s).includes('private-refresh'));
});
test('missing window events are checked individually; only confirmed deletion becomes a pending removal',async t=>{
 const f=await fixture(t),{event}=await f.link();
 const fetch=f.calendar.oauth.fetch;f.calendar.oauth.fetch=(url,opts)=>new URL(url).pathname.endsWith('/events')?Promise.resolve(Response.json({items:[]})):fetch(url,opts);
 f.google.put({...event,...eventBody({...slot,date:'2027-05-03'})},event.id);await f.calendar.refresh();let s=await f.calendar.summary();assert.equal(f.calendar.state.cache.events.length,0);assert.equal(s.links[0].status,'to_aurora');assert(!s.links[0].detail.includes('deleted'));
 f.google.events.delete(event.id);await f.calendar.refresh();s=await f.calendar.summary();assert.match(s.links[0].detail,/deleted/);assert.equal(f.google.writes().length,1,'reads cannot remove the local task or write to Google');assert.equal((await f.vault.tasks())[0].planDate,slot.date);
});
test('legacy cache absence remains unknown and a failed linked-event check preserves prior observations',async t=>{
 const f=await fixture(t),{event}=await f.link();delete f.calendar.state.cache.linked;f.calendar.state.cache.events=[];assert.equal((await f.calendar.summary()).links[0].status,'unknown');
 await f.calendar.refresh();const cache=structuredClone(f.calendar.state.cache),fetch=f.calendar.oauth.fetch;
 f.calendar.oauth.fetch=(url,opts)=>new URL(url).pathname.endsWith('/events')?Promise.resolve(Response.json({items:[]})):new URL(url).pathname.endsWith('/'+event.id)?Promise.resolve(Response.json({},403)):fetch(url,opts);
 await assert.rejects(f.calendar.refresh());assert.deepEqual(f.calendar.state.cache,cache);assert.equal((await f.calendar.summary()).fresh,false);assert.equal((await f.calendar.summary()).counts.synced,1);
});
test('summary reports stale, interrupted, expired, unsupported and duplicate-identity cases honestly',async t=>{
 const f=await fixture(t),{task,event}=await f.link();f.clock.value+=900001;assert.equal((await f.calendar.summary()).fresh,false);
 let current=(await f.vault.tasks())[0];await f.vault.scheduleTask({...current,text:'Changed'});const p=await f.calendar.preview();f.google.state.loseReply='PATCH';await assert.rejects(f.apply(p));assert.equal((await f.calendar.summary()).review.interrupted,1);
 f.clock.value+=900001;assert.equal((await f.calendar.summary()).review.expired,true);await f.calendar.discard(p.id,true);
 f.google.put({...f.google.events.get(event.id),attendees:[{self:true}]},event.id);await f.calendar.refresh();assert.equal((await f.calendar.summary()).counts.blocked,1);
 const note=await f.vault.read(task.path);await f.vault.save('40 Tasks/Duplicate.md',note.content,null);assert.match((await f.calendar.summary()).links[0].detail,/duplicate/);
});
test('focused planner review exports only the selected task and retains unrelated pending changes',async t=>{
 const f=await fixture(t),{task}=await f.link();await f.vault.scheduleTask({...task,text:'Unrelated pending edit'});const other=await f.add('Chosen task');
 const p=await f.calendar.preview({focusTask:other,reviewId:f.calendar.state.review.id});assert.equal(p.items.length,1);assert.equal(p.items[0].taskId,other.id);assert.equal(p.items[0].kind,'create_google');assert.equal(f.google.writes().length,1);
 await f.apply(p);assert.equal((await f.calendar.summary()).counts.pending,1);
 const current=(await f.vault.tasks()).find(t=>t.id===task.id),q=await f.calendar.preview({focusTask:current,reviewId:p.id});assert.equal(q.items.length,1);assert.equal(q.items[0].taskId,task.id);
});
test('focused review rejects stale tasks and never replaces an open or interrupted review',async t=>{
 const f=await fixture(t),task=await f.add(),p=await f.calendar.preview({taskIds:[task.id]}),saved=structuredClone(f.calendar.state.review);
 await assert.rejects(f.calendar.preview({focusTask:task,reviewId:p.id}),/saved sync review/);assert.deepEqual(f.calendar.state.review,saved);
 f.google.state.loseReply='POST';await assert.rejects(f.apply(p));const interrupted=structuredClone(f.calendar.state.review);await assert.rejects(f.calendar.preview({focusTask:task,reviewId:p.id}),/saved sync review/);assert.deepEqual(f.calendar.state.review,interrupted);
 await f.apply(p);await f.vault.scheduleTask({...task,text:'Changed since planner rendered'});await assert.rejects(f.calendar.preview({focusTask:task,reviewId:p.id}),/planner task changed/);
 const current=(await f.vault.tasks())[0];await assert.rejects(f.calendar.preview({focusTask:current,reviewId:'old-review'}),/saved sync review/);assert.equal(f.google.writes().length,1);
});
test('a focused linked review permits removal of its plan and summary agrees with the deletion review',async t=>{
 const f=await fixture(t),{task}=await f.link();await f.vault.scheduleTask({...task,planDate:null,startTime:null});const current=(await f.vault.tasks())[0],s=await f.calendar.summary();assert.equal(s.links[0].status,'to_google');assert.match(s.links[0].detail,/deletion/);
 const p=await f.calendar.preview({focusTask:current,reviewId:f.calendar.state.review.id});assert.equal(p.items.length,1);assert.equal(p.items[0].local,null);assert.equal(p.items[0].taskId,task.id);
});
test('summary survives restart and reflects unlink/disconnect without changing either copy',async t=>{
 const f=await fixture(t),{task}=await f.link();await f.vault.scheduleTask({...task,text:'Local pending'});const s=await f.calendar.summary(),restarted=new GoogleCalendar(f.opts);await restarted.init();t.after(()=>restarted.close());assert.deepEqual(await restarted.summary(),s);
 const before=await f.vault.tasks(),count=f.google.events.size;await restarted.unlink(task.id);assert.equal((await restarted.summary()).links.length,0);await restarted.disconnect();assert.equal((await restarted.summary()).connected,false);assert.deepEqual(await f.vault.tasks(),before);assert.equal(f.google.events.size,count);
});
