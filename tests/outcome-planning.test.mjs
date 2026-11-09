import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {FirstSteps} from '../src/first-steps.mjs';
import {sha} from '../src/vault.mjs';
import {emptyTimetable,timetableMarkdown,TIMETABLE_PATH} from '../mobile/web/timetable.js';
import {taskLine} from '../src/task-meta.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-first-step-'));let calls=0;
 const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),backups:join(dir,'backups'),projects:[],ollamaClient:{model:'fixture',status:async()=>({online:false}),chat:async()=>{calls++;throw Error('No model call expected');}},workflowOptions:{pollMs:60000}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await app.workflows.close();app.calendar.close();app.recurring.stop();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 const clock={now:new Date(2026,9,26,8)};app.dayPlanning.now=()=>clock.now;
 await app.vault.save('20 Projects/First step.md','# First step project\n\nOpen the lecture exercise. <img src=x>',null);
 await app.vault.addTask('Study discrete mathematics',{planDate:'2026-10-26',duration:30,project:'20 Projects/First step.md'});
 const task=(await app.vault.tasks()).find(t=>t.text==='Study discrete mathematics'),focus=app.dayPlanning.dailyFocus,steps=app.dayPlanning.firstSteps;
 const choose=async(action='focus')=>{const r=await focus.report(),row=r.rows.find(r=>r.taskId===task.id);return focus.decide({requestId:randomUUID(),taskId:task.id,date:r.date,timezone:r.timezone,revision:r.revision,contextRevision:row.contextRevision,action});};
 await choose();return {app,clock,task,focus,steps,choose,get calls(){return calls;}};
}
const input=async(f,extra={})=>({requestId:randomUUID(),taskId:f.task.id,revision:(await f.steps.report(f.task.id)).revision,text:'Open my notes and solve question one.',mode:'manual',acknowledge:true,...extra});
const execution=async f=>({requestId:randomUUID(),taskId:f.task.id,revision:(await f.steps.report(f.task.id)).revision,acknowledge:true});

const outcomeInput=async(f,extra={})=>{const r=await f.steps.outcomes.report(f.task.id,extra.cardSequence);return {requestId:randomUUID(),taskId:f.task.id,cardSequence:r.card.sequence,revision:r.revision,kind:'blocked',note:'Need clarification on the first exercise.',acknowledge:true,...extra};};
const prepared=async t=>{const f=await fixture(t);await f.steps.save(await input(f));return f;};
const setup=async t=>{const f=await prepared(t);await f.steps.outcomes.record(await outcomeInput(f));return f;};
const planInput=async(f,ids=[f.task.id])=>{const r=await f.app.dayPlanning.outcomePlan('2026-10-27');return {requestId:randomUUID(),date:r.date,today:r.today,timezone:r.timezone,outcomeMode:true,selected:r.rows.filter(r=>ids.includes(r.taskId)).map(r=>({taskId:r.taskId,contextRevision:r.contextRevision})),start:'09:00',end:'18:00',gap:10};};
const preview=async(f,extra={})=>f.app.dayPlanning.nextDayPreview({...await planInput(f),...extra});
const updateTask=async(f,extra)=>f.app.vault.scheduleTask({...((await f.app.vault.tasks()).find(t=>t.id===f.task.id)),...extra});
test('unfinished-step shortlist is read only, keeps exact original reports and groups distinct unresolved step versions',async t=>{
 const f=await setup(t),state=await readFile(f.steps.path,'utf8'),notes=await f.app.vault.list(),focus=await f.focus.read(),history=await f.app.vault.taskHistory.read();
 let r=await f.app.dayPlanning.outcomePlan();assert.equal(r.rows.length,1);assert.equal(r.rows[0].source.outcomes[0].note,'Need clarification on the first exercise.');assert.deepEqual(await f.app.vault.list(),notes);assert.deepEqual(await f.focus.read(),focus);assert.deepEqual(await f.app.vault.taskHistory.read(),history);assert.equal(await readFile(f.steps.path,'utf8'),state);assert.equal(f.calls,0);
 await f.steps.save(await input(f,{text:'Another exercise'}));await f.steps.outcomes.record(await outcomeInput(f,{kind:'continue'}));r=await f.app.dayPlanning.outcomePlan();assert.equal(r.rows.length,1);assert.equal(r.rows[0].source.outcomes.length,2);
 await f.steps.outcomes.record(await outcomeInput(f,{kind:'done'}));r=await f.app.dayPlanning.outcomePlan();assert.equal(r.rows[0].source.outcomes.length,1);assert.equal(r.rows[0].source.outcomes[0].cardSequence,1);
});
test('done, superseded and followed-on reports are excluded without completing or rescheduling tasks',async t=>{
 const f=await setup(t);await f.steps.outcomes.record(await outcomeInput(f,{kind:'done'}));assert.equal((await f.app.dayPlanning.outcomePlan()).rows.length,0);
 const q=await outcomeInput(f,{kind:'continue'});await f.steps.outcomes.record(q);await f.steps.save(await input(f,{sourceOutcomeId:q.requestId}));assert.equal((await f.app.dayPlanning.outcomePlan()).rows.length,0);assert.equal((await f.app.vault.tasks())[0].done,false);
});
test('missing, duplicate, completed, dependent and active tasks remain visible but cannot be selected',async t=>{
 for(const kind of ['missing','duplicate','complete','dependency','active','future']){
  const f=await setup(t);
  if(kind==='missing'){const n=await f.app.vault.read(f.task.path);await f.app.vault.trash(n.path,n.revision);}
  if(kind==='duplicate')await f.app.vault.save('40 Tasks/Duplicate.md','- [ ] '+taskLine('Duplicate',{},f.task.id),null);
  if(kind==='complete'){const n=(await f.app.vault.tasks()).find(t=>t.id===f.task.id);await f.app.vault.toggleTask(n.path,n.line,n.revision,true);}
  if(kind==='dependency'){await f.app.vault.addTask('Prerequisite');const p=(await f.app.vault.tasks()).find(t=>t.text==='Prerequisite'),current=await f.app.vault.read(f.task.path);const lines=current.content.split('\n');lines[f.task.line]='- [ ] '+taskLine(f.task.text,{duration:30,dependsOn:[p.id]},f.task.id);await f.app.vault.save(current.path,lines.join('\n'),current.revision);}
  if(kind==='active')f.app.dayPlanning.execution=async()=>[{id:'attempt',taskId:f.task.id,status:'running',detail:'Running',executionRevision:'1'}];
  if(kind==='future')await updateTask(f,{planDate:'2026-10-27',startTime:'11:00'});
  const r=await f.app.dayPlanning.outcomePlan();assert(r.rows[0].issue,kind);await assert.rejects(preview(f));
 }
});
test('selection mode, source versions, date and timezone require an explicit valid preview',async t=>{
 const f=await setup(t),i=await planInput(f),day=f.app.dayPlanning;
 for(const patch of [{outcomeMode:false},{outcomeMode:'true'},{selected:[]},{selected:[i.selected[0],i.selected[0]]},{timezone:'wrong'},{today:'2026-10-25'},{date:'2026-10-25'},{selected:[{taskId:f.task.id,contextRevision:'stale'}]}])await assert.rejects(day.nextDayPreview({...i,...patch}));
 const ordinary=await day.nextDay(i.date);await assert.rejects(day.nextDayPreview({...i,selected:[{taskId:f.task.id,contextRevision:ordinary.rows[0].contextRevision}]}));assert.equal((await f.app.store.list('proposals')).length,0);
});
test('preview preserves scope, completion, focus and original outcomes; saved times respect classes and calendar',async t=>{
 const f=await setup(t),day=f.app.dayPlanning,tt=emptyTimetable();tt.timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;tt.classes=[{id:randomUUID(),title:'Class',day:2,start:'09:00',end:'10:00',location:''}];await f.app.vault.save(TIMETABLE_PATH,timetableMarkdown(tt),null);
 const c={enabled:true,complete:true,revision:'one',from:'2026-10-01',to:'2026-11-01',events:[{id:'busy',start:{dateTime:new Date(2026,9,27,10).toISOString()},end:{dateTime:new Date(2026,9,27,11).toISOString()}}]};day.calendar={fresh:async()=>c,context:async()=>c};
 const notes=await f.app.vault.list(),focus=await f.focus.read(),outcomes=await readFile(f.steps.path,'utf8'),p=await preview(f);assert.equal(p.changes.length,1);assert.equal(p.changes[0].after.startTime,'11:10');assert.equal(p.outcomeSources[0].outcomes.length,1);assert.deepEqual(await f.app.vault.list(),notes);assert.equal((await f.app.store.list('workflows')).length,0);
 await day.decide(p.id,'accept');const current=(await f.app.vault.tasks()).find(t=>t.id===f.task.id);assert.equal(current.planDate,'2026-10-27');assert.equal(current.text,f.task.text);assert.equal(current.done,false);assert.deepEqual(await f.focus.read(),focus);assert.equal(await readFile(f.steps.path,'utf8'),outcomes);assert.equal(f.calls,0);
});
test('too-large selections retain original schedules and source reasons while existing timed work stays fixed',async t=>{
 const f=await setup(t);await updateTask(f,{duration:120});const before=await f.app.vault.tasks(),p=await preview(f,{start:'09:00',end:'10:00'});assert.equal(p.changes.length,0);assert.equal(p.held.length,1);assert.equal(p.outcomeSources.length,1);await f.app.dayPlanning.decide(p.id,'accept');assert.deepEqual(await f.app.vault.tasks(),before);
});
test('outcome, card, project and task changes invalidate selections and unsaved previews',async t=>{
 for(const kind of ['outcome','card','project','task']){
  const f=await setup(t),i=await planInput(f),p=await f.app.dayPlanning.nextDayPreview(i);
  if(kind==='outcome')await f.steps.outcomes.record(await outcomeInput(f,{kind:'continue',note:'New report'}));
  if(kind==='card')await f.steps.save(await input(f,{text:'New step'}));
  if(kind==='project'){const n=await f.app.vault.read(f.task.project);await f.app.vault.save(n.path,n.content+'\nNew project detail',n.revision);}
  if(kind==='task')await updateTask(f,{duration:45});
  await assert.rejects(f.app.dayPlanning.nextDayPreview({...i,requestId:randomUUID()}),/changed/);await assert.rejects(f.app.dayPlanning.decide(p.id,'accept'),/changed/);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).planDate,'2026-10-26');
 }
});
test('outcome changes during preview preparation prevent creation of a stale proposal',async t=>{
 const f=await setup(t),day=f.app.dayPlanning,original=day.planReviewTimes.bind(day);day.planReviewTimes=async(...args)=>{const r=await original(...args);await f.steps.outcomes.record(await outcomeInput(f,{note:'Changed during placement'}));return r;};await assert.rejects(preview(f),/outcome.*changed/);assert.equal((await f.app.store.list('proposals')).length,0);
});
test('outcome and calendar changes at the note replacement boundary prevent stale schedule writes',async t=>{
 for(const kind of ['outcome','calendar']){
  const f=await setup(t),day=f.app.dayPlanning,c={enabled:true,complete:true,revision:'one',from:'2026-10-01',to:'2026-11-01',events:[]};day.calendar={fresh:async()=>c,context:async()=>c};const p=await preview(f),original=f.app.vault.save.bind(f.app.vault);
  f.app.vault.save=async(...args)=>{if(kind==='outcome'){const s=await f.steps.read();s.outcomes[0].note='Changed at replacement';await writeFile(f.steps.path,JSON.stringify(s));}else c.revision='two';return original(...args);};await assert.rejects(day.decide(p.id,'accept'),/changed/);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).planDate,'2026-10-26');
 }
});
test('concurrent and lost preview replies recover the exact source snapshot after newer reports and midnight',async t=>{
 const f=await setup(t),day=f.app.dayPlanning,i=await planInput(f),both=await Promise.all([day.nextDayPreview(i),day.nextDayPreview(i)]);assert.equal(both[0].id,both[1].id);assert.equal((await f.app.store.list('proposals')).length,1);
 await f.steps.outcomes.record(await outcomeInput(f,{kind:'done',note:'Newer report'}));f.clock.now=new Date(2026,9,28,8);const replay=await day.nextDayPreview(i);assert.deepEqual(replay.outcomeSources,both[0].outcomeSources);await assert.rejects(day.nextDayPreview({...i,outcomeMode:undefined}),/another preview/);await assert.rejects(day.decide(replay.id,'accept'),/day or timezone/);
});
test('fully committed lost receipts recover after days away without changing newer task edits or outcome reports',async t=>{
 const f=await setup(t),day=f.app.dayPlanning,p=await preview(f),put=f.app.store.put.bind(f.app.store);let fail=true;f.app.store.put=async(k,r)=>{if(r.id===p.id&&r.saved?.length&&fail){fail=false;throw Error('Lost receipt');}return put(k,r);};await assert.rejects(day.decide(p.id,'accept'),/Lost receipt/);f.app.store.put=put;
 await f.steps.outcomes.record(await outcomeInput(f,{kind:'done',note:'Recorded later'}));f.clock.now=new Date(2026,9,29,8);const notes=await f.app.vault.list(),state=await readFile(f.steps.path,'utf8');assert.equal((await day.decide(p.id,'accept')).status,'accepted');assert.deepEqual(await f.app.vault.list(),notes);assert.equal(await readFile(f.steps.path,'utf8'),state);
 await updateTask(f,{text:'Later wording'});await day.decide(p.id,'accept');assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).text,'Later wording');
});
test('morning saved plans retain selection sources only for recorded saves, even after outcomes are superseded',async t=>{
 const f=await setup(t),day=f.app.dayPlanning;f.app.vault.taskHistory.now=()=>f.clock.now.toISOString();const p=await preview(f);f.clock.now=new Date(2026,9,27,8);assert.equal((await day.savedPlans()).plans.length,0);f.clock.now=new Date(2026,9,26,8);await day.decide(p.id,'accept');await f.steps.outcomes.record(await outcomeInput(f,{kind:'done',note:'Finished after planning'}));f.clock.now=new Date(2026,9,27,8);const saved=await day.savedPlans();assert.deepEqual(saved.plans[0].rows[0].outcomeSource,p.outcomeSources[0]);assert.equal(saved.plans[0].rows[0].current.done,false);
});
test('damaged outcome history blocks sourced planning without affecting ordinary planning',async t=>{
 const f=await setup(t);await writeFile(f.steps.path,'broken');await assert.rejects(f.app.dayPlanning.outcomePlan(),/cannot be read/);assert((await f.app.dayPlanning.nextDay()).rows.length);assert.equal(await readFile(f.steps.path,'utf8'),'broken');
});
test('partial saves retain per-task source reasons and recover remaining notes without revalidating committed outcome reports',async t=>{
 const f=await setup(t),day=f.app.dayPlanning,id=randomUUID();await f.app.vault.save('40 Tasks/Second shortlist task.md','- [ ] '+taskLine('Second shortlist task',{duration:20,planDate:'2026-10-26'},id),null);
 const r=await f.focus.report(),row=r.rows.find(r=>r.taskId===id);await f.focus.decide({requestId:randomUUID(),taskId:id,date:r.date,timezone:r.timezone,revision:r.revision,contextRevision:row.contextRevision,action:'focus'});await f.steps.save({requestId:randomUUID(),taskId:id,revision:(await f.steps.report(id)).revision,text:'Read another exercise',mode:'manual',acknowledge:true});await f.steps.outcomes.record({requestId:randomUUID(),taskId:id,cardSequence:1,revision:(await f.steps.outcomes.report(id)).revision,kind:'continue',note:'Return to this exercise',acknowledge:true});
 const p=await day.nextDayPreview(await planInput(f,[f.task.id,id])),save=f.app.vault.save.bind(f.app.vault);let count=0;f.app.vault.save=async(...a)=>{if(++count===2)throw Error('Second note interrupted');return save(...a);};await assert.rejects(day.decide(p.id,'accept'),/Saved 1 of 2/);f.app.vault.save=save;
 const first=await f.app.vault.read(f.task.path);await f.steps.outcomes.record(await outcomeInput(f,{kind:'done',note:'A newer report for the committed task'}));await day.decide(p.id,'accept');assert.equal((await f.app.vault.read(first.path)).content,first.content);assert.equal((await f.app.vault.tasks()).find(t=>t.id===id).planDate,'2026-10-27');assert.deepEqual((await f.app.store.get('proposals',p.id)).outcomeSources,p.outcomeSources);
});
test('API exposes source-labelled shortlist, authenticates preview writes and never calls a model',async t=>{
 const f=await setup(t);await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+f.app.server.address().port,b=await(await fetch(url+'/api/bootstrap')).json(),i=await planInput(f),post=auth=>fetch(url+'/api/next-day/preview',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Aster-Token':b.token}:{})},body:JSON.stringify(i)});assert.equal((await post(false)).status,403);assert.equal((await post(true)).status,200);const r=await(await fetch(url+'/api/outcome-plan')).json();assert.equal(r.rows[0].source.outcomes.length,1);assert.equal((await fetch(url+'/outcome-planning.js')).status,200);assert.equal(f.calls,0);
});
