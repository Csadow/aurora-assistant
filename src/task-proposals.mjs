import {calendarBlocks} from './calendar-time.mjs';
import {taskGraph,taskRef,validateTaskLinks} from '../mobile/web/task-links.js';
import {randomUUID} from 'node:crypto';
import {AppError,markdown,sha} from './vault.mjs';
import {schedule,taskLine,tasksIn} from './task-meta.mjs';
import {currentTask,taskSignature,minutes,clock} from '../mobile/web/planner-core.js';
import {readTimetable,classesForDay,TIMETABLE_PATH} from '../mobile/web/timetable.js';
const fields=['text','due','remindAt','planDate','startTime','duration','priority','project','parent','dependsOn'];
const targetPath='40 Tasks/Tasks.md';
const same=(a,b)=>taskSignature(a)===taskSignature(b);
export class TaskProposals {
  constructor({vault,store}){Object.assign(this,{vault,store});this.queue=Promise.resolve();}
  exclusive(fn){const work=this.queue.then(fn);this.queue=work.catch(()=>{});return work;}
  async note(path){try{return await this.vault.read(path);}catch(e){if(e.status!==404)throw e;return {path,revision:null,content:markdown('Tasks','## Tasks',{kind:'tasks',status:'confirmed'})};}}
  context(notes,after,before,timezone,calendar){
    const conflicts=[],warnings=[];
    const all=tasksIn(notes),isOriginal=t=>before&&t.path===before.path&&(before.id?t.id===before.id:t.line===before.line),graph=taskGraph([...all.filter(t=>!isOriginal(t)),after]),state=graph.states.get(taskRef(after));
    validateTaskLinks([...all.filter(t=>!isOriginal(t)),after],after,notes,{changed:['project','parent','dependsOn'].some(k=>JSON.stringify(before?.[k]??null)!==JSON.stringify(after[k]??null))});
    const linkLabels=Object.fromEntries(all.filter(t=>t.id&&graph.one(t.id)).map(t=>[t.id,t.text]));
    const projectRevision=after.project?notes.find(n=>n.path===after.project)?.revision||'missing':null;
    const links=after.dependsOn?.length||after.parent?all.map(t=>[t.id,t.text,t.done,t.parent||null,t.dependsOn||[],!!t.scheduleError]):null;
    if(state?.blocked)warnings.push(...state.reasons);
    if(!after.planDate||!after.startTime)return {hash:links||projectRevision?sha(JSON.stringify(['unscheduled',links,projectRevision])):sha('unscheduled'),conflicts,warnings,linkLabels};
    if(state?.blocked)conflicts.push({kind:'dependency',title:state.reasons.join('; '),time:'Not ready'});
    const date=after.planDate,start=minutes(after.startTime),end=start+after.duration;
    if(calendar?.enabled){if(!calendar.complete||date<calendar.from||date>=calendar.to)throw new AppError('Google Calendar is incomplete for this date. Refresh before proposing a timed task.',409);for(const b of calendarBlocks(calendar.events,date,timezone))if(start<b.end&&end>b.start)conflicts.push({kind:'calendar',title:b.title,time:clock(b.start)+'–'+clock(b.end)});}
    const isTarget=t=>before&&t.path===before.path&&(before.id?t.id===before.id:t.line===before.line);
    const peers=tasksIn(notes).filter(t=>!t.done&&!isTarget(t));
    if(peers.some(t=>t.scheduleError))throw new AppError('Repair invalid task metadata before proposing a timed task.');
    const tasks=peers.filter(t=>t.planDate===date&&t.startTime).map(t=>({path:t.path,line:t.line,id:t.id,text:t.text,startTime:t.startTime,duration:t.duration}));
    const note=notes.find(n=>n.path===TIMETABLE_PATH),timetable=readTimetable(note),day=classesForDay(timetable,date);
    if(day.unknown)throw new AppError('Class times for this day are incomplete. Update the timetable first.');
    if((timetable.classes.length||timetable.availability)&&timetable.timezone!==timezone)throw new AppError('The class and desktop timezones differ. Review the timetable timezone first.');
    for(const t of tasks)if(start<minutes(t.startTime)+t.duration&&end>minutes(t.startTime))conflicts.push({kind:'task',title:t.text,time:t.startTime+'–'+clock(minutes(t.startTime)+t.duration)});
    for(const c of day.classes)if(start<minutes(c.end)&&end>minutes(c.start))conflicts.push({kind:'class',title:c.title,time:c.start+'–'+c.end});
    for(const [a,b] of day.busy.slice(day.classes.length))if(start<b&&end>a)conflicts.push({kind:'travel',title:'Travel',time:clock(a)+'–'+clock(b)});
    for(const [a,b] of day.unavailable)if(start<b&&end>a)conflicts.push({kind:'availability',title:'Outside your available hours',time:clock(a)+'–'+clock(b)});
    if(day.classes.length&&!timetable.travelConfirmed)warnings.push('Travel time is not configured; check that you have enough time to get to and from class.');
    if(timetable.classes.length&&!timetable.until)warnings.push('Trimester end is not set.');
    return {hash:sha(JSON.stringify({date,tasks,...(calendar?.enabled?{calendar:calendar.revision}:{}),...(links?{links}:{}),...(projectRevision?{projectRevision}:{}),timetable:note?.revision||null,timezone})),conflicts,warnings,linkLabels};
  }
  async propose(input,conversation,{update=false,proposalId=null,origin=null}={}){
    let before=null,path=targetPath;
    const changes=update?input.changes:input;
    if(!changes||typeof changes!=='object'||Array.isArray(changes)||update&&(!Object.keys(changes).length||Object.keys(changes).some(k=>!fields.includes(k))))throw new AppError('Choose task fields to change.');
    const notes=await this.vault.list();
    if(update){
      path=input.path;await this.vault.safe(path);
      const note=notes.find(n=>n.path===path);if(!note||note.revision!==input.revision)throw new AppError('The task note changed. List tasks again before proposing an update.',409);
      before=tasksIn([note]).find(t=>t.line===input.line);if(!before||before.done||before.scheduleError)throw new AppError('Choose an open task with valid metadata from list_tasks.');
    }
    const text=changes.text??before?.text,meta=schedule({...before,...changes});taskLine(text,meta);
    const after={path,id:before?.id||randomUUID(),text:text.trim(),done:false,...meta};
    if(before&&same(before,after))throw new AppError('This task already has those values.');
    const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone,context=this.context(notes,after,before,timezone,after.planDate&&after.startTime?await this.calendar?.fresh(after.planDate):undefined);
    const record={kind:update?'task_update':'task',conversation,title:after.text,text:after.text,...meta,...(origin==='desktop_capture'?{origin}:{}),review:{version:1,path,before,after,timezone,contextHash:context.hash,conflicts:context.conflicts,warnings:context.warnings,linkLabels:context.linkLabels}};
    const p=proposalId?await this.store.put('proposals',{...record,id:proposalId,status:'pending',created:new Date().toISOString()}):await this.store.proposal(record);
    return this.public(p);
  }
  public(p){const {intent,...value}=p;return value;}
  decide(id,action,{allowConflicts=false,origin=null}={}){return this.exclusive(async()=>{
    let p=await this.store.get('proposals',id);if(p.review?.version!==1)throw new AppError('This task review is unavailable.');
    if(!['accept','dismiss'].includes(action))throw new AppError('Invalid proposal action.');
    if(origin==='desktop_capture'&&p.kind==='task'&&!p.origin){p.origin=origin;await this.store.put('proposals',p);}
    if(p.status!=='pending'){if(action==='accept'&&p.status==='accepted')return this.public(p);throw new AppError('This proposal was already handled.',409);}
    const r=p.review;
    const existing=await this.note(r.path);
    if(p.intent){
      const matches=tasksIn([existing]).filter(t=>t.id===r.after.id);
      if(matches.length===1&&same(matches[0],r.after)){p.status='accepted';p.acceptedAt=new Date().toISOString();p.acceptedRecovered=true;await this.store.put('proposals',p);return this.public(p);}
      if(existing.revision!==p.intent.revision)throw new AppError('A previous save could not be reconciled. Inspect the task note before creating another proposal.',409);
    }
    if(action==='dismiss'){p.status='dismissed';return this.public(await this.store.put('proposals',p));}
    if(r.conflicts.length&&allowConflicts!==true&&!p.intent)throw new AppError('Review the overlaps and explicitly allow them before saving.',409);
    const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    if(timezone!==r.timezone)throw new AppError('The desktop timezone changed. Ask for a fresh task review.',409);
    if(r.after.planDate&&r.after.startTime)await this.calendar?.fresh(r.after.planDate);
    const verify=async()=>{
      const notes=await this.vault.list();
      if(this.context(notes,r.after,r.before,timezone,await this.calendar?.context({includeLinked:true})).hash!==r.contextHash)throw new AppError('The schedule changed since this review. Ask Aurora for a fresh proposal.',409);
      if(r.before)currentTask(tasksIn(notes),r.before);
    };
    await verify();
    if(!p.intent){
      let content;
      if(r.before){const task=currentTask(tasksIn([existing]),r.before),lines=existing.content.split('\n');lines[task.line]=lines[task.line].replace(/^(\s*[-*] )\[[ xX]\] .+$/,(_,prefix)=>prefix+'[ ] '+taskLine(r.after.text,r.after,r.after.id));content=lines.join('\n');}
      else{if(tasksIn([existing]).some(t=>t.id===r.after.id))throw new AppError('This task ID already exists. Inspect the task note.',409);content=existing.content.trimEnd()+'\n- [ ] '+taskLine(r.after.text,r.after,r.after.id)+'\n';}
      p.intent={revision:existing.revision,content};await this.store.put('proposals',p);
    }
    await this.vault.save(r.path,p.intent.content,p.intent.revision,{taskSource:{kind:p.kind,proposalId:p.id},beforeCommit:async()=>{const note=await this.note(r.path);if(note.revision!==p.intent.revision)throw new AppError('The task note changed during saving. Inspect it before retrying.',409);await verify();}});
    p.status='accepted';p.acceptedAt=new Date().toISOString();p.acceptedRecovered=false;await this.store.put('proposals',p);return this.public(p);
  });}
}
