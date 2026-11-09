import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {PlanFollowThrough} from '../src/plan-follow-through.mjs';
import {emptyTimetable,timetableMarkdown,TIMETABLE_PATH} from '../mobile/web/timetable.js';
import {taskLine} from '../src/task-meta.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-first-step-'));let calls=0;
 const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),backups:join(dir,'backups'),projects:[],ollamaClient:{model:'fixture',status:async()=>({online:false}),chat:async()=>{calls++;throw Error('No model call expected');}},workflowOptions:{pollMs:60000}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await app.workflows.close();app.calendar.close();app.recurring.stop();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 const clock={now:new Date(2026,9,26,8)};app.dayPlanning.now=()=>clock.now;app.vault.taskHistory.now=()=>clock.now.toISOString();
 await app.vault.save('20 Projects/First step.md','# First step project\n\nOpen the lecture exercise. <img src=x>',null);
 await app.vault.addTask('Study discrete mathematics',{planDate:'2026-10-26',duration:30,project:'20 Projects/First step.md'});
 const task=(await app.vault.tasks()).find(t=>t.text==='Study discrete mathematics'),focus=app.dayPlanning.dailyFocus,steps=app.dayPlanning.firstSteps;
 const choose=async(action='focus')=>{const r=await focus.report(),row=r.rows.find(r=>r.taskId===task.id);return focus.decide({requestId:randomUUID(),taskId:task.id,date:r.date,timezone:r.timezone,revision:r.revision,contextRevision:row.contextRevision,action});};
 await choose();return {app,clock,task,focus,steps,choose,get calls(){return calls;}};
}
const input=async(f,extra={})=>({requestId:randomUUID(),taskId:f.task.id,revision:(await f.steps.report(f.task.id)).revision,text:'Open my notes and solve question one.',mode:'manual',acknowledge:true,...extra});

const outcomeInput=async(f,extra={})=>{const r=await f.steps.outcomes.report(f.task.id,extra.cardSequence);return {requestId:randomUUID(),taskId:f.task.id,cardSequence:r.card.sequence,revision:r.revision,kind:'blocked',note:'Need clarification on the first exercise.',acknowledge:true,...extra};};
const prepared=async t=>{const f=await fixture(t);await f.steps.save(await input(f));return f;};
const setup=async t=>{const f=await prepared(t);await f.steps.outcomes.record(await outcomeInput(f));return f;};
const planInput=async(f,ids=[f.task.id])=>{const r=await f.app.dayPlanning.outcomePlan('2026-10-27');return {requestId:randomUUID(),date:r.date,today:r.today,timezone:r.timezone,outcomeMode:true,selected:r.rows.filter(r=>ids.includes(r.taskId)).map(r=>({taskId:r.taskId,contextRevision:r.contextRevision})),start:'09:00',end:'18:00',gap:10};};
const preview=async(f,extra={})=>f.app.dayPlanning.nextDayPreview({...await planInput(f),...extra});
const updateTask=async(f,extra)=>f.app.vault.scheduleTask({...((await f.app.vault.tasks()).find(t=>t.id===f.task.id)),...extra});
const ready=async(t,{save=true,...extra}={})=>{const f=await setup(t),p=await preview(f,extra);if(save)await f.app.dayPlanning.decide(p.id,'accept');f.clock.now=new Date(2026,9,27,8);return {...f,p,follow:f.app.dayPlanning.followThrough};};
const choice=async f=>{const r=await f.follow.report(f.p.id),row=r.rows[0];return {requestId:randomUUID(),proposalId:f.p.id,taskId:f.task.id,date:r.date,timezone:r.timezone,revision:row.revision,focusRevision:r.focusRevision,contextRevision:row.contextRevision};};
const adjustment=async f=>{const r=await f.follow.report(f.p.id),c=await f.app.dayPlanning.candidates();return {requestId:randomUUID(),date:r.date,timezone:r.timezone,selected:c.tasks.filter(t=>t.id===f.task.id),start:'00:00',end:'18:00',gap:10,followThrough:{proposalId:f.p.id,taskId:f.task.id,revision:r.rows[0].revision}};};
test('follow-through is read only and distinguishes recorded saves, previews, held tasks and dismissal',async t=>{
 for(const kind of ['saved','unrecorded','held','dismissed']){
  const f=await ready(t,{save:kind==='saved',...(kind==='held'?{start:'09:00',end:'09:10'}:{})});if(kind==='dismissed')await f.app.dayPlanning.decide(f.p.id,'dismiss');
  const notes=await f.app.vault.list(),focus=await f.focus.read(),state=await f.steps.read(),history=await f.app.vault.taskHistory.read(),r=await f.follow.report();
  assert.equal(r.rows.length,1);assert.equal(r.rows[0].evidence,kind);assert.equal(!!r.rows[0].receipt,kind==='saved');assert.equal(r.rows[0].selectedSource.outcomes[0].note,'Need clarification on the first exercise.');assert.equal(r.counts.unrecorded,kind==='saved'?0:1);
  assert.deepEqual(await f.app.vault.list(),notes);assert.deepEqual(await f.focus.read(),focus);assert.deepEqual(await f.steps.read(),state);assert.deepEqual(await f.app.vault.taskHistory.read(),history);assert.equal(f.calls,0);
 }
});
test('future plans appear on their day and remain available as observations after days away',async t=>{
 const f=await setup(t),p=await preview(f),follow=f.app.dayPlanning.followThrough;assert.equal((await follow.report()).rows.length,0);await assert.rejects(follow.report(p.id),/future/);
 f.clock.now=new Date(2026,9,30,8);const row=(await follow.report(p.id)).rows[0];assert.equal(row.plannedDate,'2026-10-27');assert.equal(row.timing,'untimed');assert.equal(row.canAdjust,false);assert.equal(row.current.planDate,'2026-10-26');
});
test('changed, missing, duplicate and completed tasks never become inferred completions',async t=>{
 for(const kind of ['changed','missing','duplicate','complete','elapsed','future']){
  const f=await ready(t);
  if(kind==='changed')await updateTask(f,{text:'Changed wording',duration:40});
  if(kind==='future')await updateTask(f,{planDate:'2026-10-29'});
  if(kind==='missing'){const n=await f.app.vault.read(f.task.path);await f.app.vault.trash(n.path,n.revision);}
  if(kind==='duplicate')await f.app.vault.save('40 Tasks/Duplicate.md','- [ ] '+taskLine('Duplicate',{},f.task.id),null);
  if(kind==='complete'){const task=(await f.app.vault.tasks()).find(t=>t.id===f.task.id);await f.app.vault.toggleTask(task.path,task.line,task.revision,true);}
  if(kind==='elapsed')f.clock.now=new Date(2026,9,27,18);
  const r=(await f.follow.report()).rows[0];assert.equal(r.evidence,'saved');assert.equal(r.original.done,false);
  if(['missing','duplicate'].includes(kind)){assert.equal(r.current,null);assert(r.identityIssue);assert(!r.canFocus&&!r.canAdjust);}
  else if(kind==='complete'){assert(r.current.done);assert(!r.canFocus&&!r.canAdjust);}
  else {assert.equal(r.current.done,false);assert(r.needsAttention);}
  if(kind==='elapsed')assert.equal(r.timing,'elapsed');if(kind==='future')assert.equal(r.canAdjust,false);
 }
});
test('current outcomes, steps and project context are compared with the immutable original selection',async t=>{
 for(const kind of ['outcome','step','project']){
  const f=await ready(t),before=(await f.follow.report()).rows[0];
  if(kind==='outcome')await f.steps.outcomes.record(await outcomeInput(f,{kind:'done',note:'Later report'}));
  if(kind==='step'){await f.choose();await f.steps.save(await input(f,{text:'New step'}));}
  if(kind==='project'){const n=await f.app.vault.read(f.task.project);await f.app.vault.save(n.path,n.content+'\nChanged project',n.revision);}
  const after=(await f.follow.report()).rows[0];assert.deepEqual(after.selectedSource,before.selectedSource);assert.notEqual(after.revision,before.revision);assert(after[kind+'Changed']);assert.equal(after.current.done,false);
 }
});
test('unreadable step history preserves saved evidence but disables new choices and adjustments',async t=>{
 const f=await ready(t),i=await choice(f);await writeFile(f.steps.path,'broken');const r=(await f.follow.report()).rows[0];assert.equal(r.evidence,'saved');assert.match(r.sourceError,/cannot be read/);assert(!r.canFocus&&!r.canAdjust);await assert.rejects(f.follow.choose(i),/changed/);assert.equal(await readFile(f.steps.path,'utf8'),'broken');
});
test('focus is explicit, source-labelled and separate from scheduling, reports and execution',async t=>{
 const f=await ready(t,{save:false}),notes=await f.app.vault.list(),state=await f.steps.read(),i=await choice(f);assert.equal((await f.follow.status(i)).recorded,false);await f.follow.choose(i);const r=await f.follow.status(i);assert(r.recorded);assert.equal(r.focus.rows.find(r=>r.taskId===f.task.id).choice.source.kind,'plan_follow_through');assert.deepEqual(await f.app.vault.list(),notes);assert.deepEqual(await f.steps.read(),state);assert.equal((await f.app.store.list('workflows')).length,0);
});
test('focus rejects stale source, date, timezone, focus and task revisions',async t=>{
 const f=await ready(t),i=await choice(f);
 for(const patch of [{revision:'old'},{date:'2026-10-28'},{timezone:'wrong'},{focusRevision:'old'},{contextRevision:'old'}])await assert.rejects(f.follow.choose({...i,...patch}));
 await f.steps.outcomes.record(await outcomeInput(f,{note:'New report'}));await assert.rejects(f.follow.choose(i),/changed/);assert.equal((await f.follow.status(i)).recorded,false);
});
test('source changes at the focus file commit boundary prevent stale choices',async t=>{
 const f=await ready(t),i=await choice(f),source=f.follow.source.bind(f.follow);let count=0;
 f.follow.source=async(...args)=>{if(++count===2){const n=await f.app.vault.read(f.task.project);await writeFile(join(f.app.vault.root,n.path),n.content+'\nExternal project edit');}return source(...args);};
 await assert.rejects(f.follow.choose(i),/changed/);assert.equal((await f.follow.status(i)).recorded,false);
});
test('concurrent and lost focus replies recover across restart and days without overwriting a later choice',async t=>{
 const f=await ready(t),i=await choice(f),both=await Promise.all([f.follow.choose(i),f.follow.choose(i)]);assert(both[1].alreadySaved);await f.choose('off');const before=await f.focus.read();f.clock.now=new Date(2026,9,29,8);await rm(f.app.store.file('proposals',f.p.id));const restarted=new PlanFollowThrough({planner:f.app.dayPlanning});assert((await restarted.status(i)).recorded);assert((await restarted.choose(i)).alreadySaved);assert.deepEqual(await f.focus.read(),before);await assert.rejects(restarted.choose({...i,revision:'different'}),/another choice/);
});
test('adjustment selects exactly one reviewed task and preserves all other drafts and task scope',async t=>{
 const f=await ready(t),day=f.app.dayPlanning;await f.app.vault.addTask('Unselected work',{planDate:'2026-10-27',startTime:'11:00',duration:30});const before=await f.app.vault.tasks(),state=await f.steps.read(),focus=await f.focus.read(),i=await adjustment(f);
 for(const patch of [{selected:[]},{selected:(await day.candidates()).tasks},{checkin:{id:randomUUID(),revision:'x'}},{requestId:undefined}])await assert.rejects(day.preview({...i,...patch}));
 const p=await day.preview(i);assert.equal(p.changes.length,1);assert.equal(p.followThrough.snapshot.taskId,f.task.id);await day.decide(p.id,'accept');const after=await f.app.vault.tasks();assert.equal(after.find(t=>t.text==='Unselected work').startTime,'11:00');const a=after.find(t=>t.id===f.task.id),b=before.find(t=>t.id===f.task.id);for(const k of ['text','done','planDate','duration','project','due','reminder'])assert.equal(a[k],b[k]);assert.deepEqual(await f.steps.read(),state);assert.deepEqual(await f.focus.read(),focus);
});
test('adjustments respect classes and calendar commitments',async t=>{
 const f=await ready(t),day=f.app.dayPlanning,tt=emptyTimetable();tt.timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;tt.classes=[{id:randomUUID(),title:'Class',day:2,start:'08:00',end:'10:00',location:''}];await f.app.vault.save(TIMETABLE_PATH,timetableMarkdown(tt),null);const c={enabled:true,complete:true,revision:'one',from:'2026-10-01',to:'2026-11-01',events:[{id:'busy',start:{dateTime:new Date(2026,9,27,10).toISOString()},end:{dateTime:new Date(2026,9,27,11).toISOString()}}]};day.calendar={fresh:async()=>c,context:async()=>c};const p=await day.preview(await adjustment(f));assert.equal(p.changes[0].after.startTime,'11:10');
});
test('outcome and attempt changes block adjustment previews and unsaved commits',async t=>{
 for(const kind of ['outcome','attempt']){
  const f=await ready(t),day=f.app.dayPlanning,i=await adjustment(f),p=await day.preview(i);
  if(kind==='outcome')await f.steps.outcomes.record(await outcomeInput(f,{note:'New outcome'}));else day.execution=async()=>[{taskId:f.task.id,id:'active',status:'running',executionRevision:'2'}];
  await assert.rejects(day.preview({...i,requestId:randomUUID()}),/changed/);await assert.rejects(day.decide(p.id,'accept'),/changed/);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).startTime,'09:00');
 }
});
test('adjustments revalidate source at the note replacement boundary',async t=>{
 const f=await ready(t),day=f.app.dayPlanning,p=await day.preview(await adjustment(f)),save=f.app.vault.save.bind(f.app.vault);f.app.vault.save=async(...args)=>{const s=await f.steps.read();s.outcomes[0].note='External edit at replacement';await writeFile(f.steps.path,JSON.stringify(s));return save(...args);};await assert.rejects(day.decide(p.id,'accept'),/changed/);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).startTime,'09:00');
});
test('exact adjustment previews and fully written notes recover after days and newer outcomes',async t=>{
 const f=await ready(t),day=f.app.dayPlanning,i=await adjustment(f),both=await Promise.all([day.preview(i),day.preview(i)]);assert.equal(both[0].id,both[1].id);const p=both[0],put=f.app.store.put.bind(f.app.store);let fail=true;f.app.store.put=async(k,r)=>{if(r.id===p.id&&r.saved?.length&&fail){fail=false;throw Error('Lost receipt');}return put(k,r);};await assert.rejects(day.decide(p.id,'accept'),/Lost receipt/);f.app.store.put=put;await f.steps.outcomes.record(await outcomeInput(f,{kind:'done',note:'Later report'}));f.clock.now=new Date(2026,9,30,8);const notes=await f.app.vault.list(),state=await f.steps.read();assert.equal((await day.preview(i)).id,p.id);assert.equal((await day.decide(p.id,'accept')).status,'accepted');assert.deepEqual(await f.app.vault.list(),notes);assert.deepEqual(await f.steps.read(),state);await updateTask(f,{text:'New wording'});await day.decide(p.id,'accept');assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).text,'New wording');
});
test('follow-through endpoints require authenticated writes and expose briefing and desktop module',async t=>{
 const f=await ready(t);await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+f.app.server.address().port,b=await(await fetch(url+'/api/bootstrap')).json(),i=await choice(f);
 for(const path of ['choose','status']){assert.equal((await fetch(url+'/api/plan-follow-through/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(i)})).status,403);assert.equal((await fetch(url+'/api/plan-follow-through/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':b.token},body:JSON.stringify(i)})).status,200);}
 assert.equal((await(await fetch(url+'/api/plan-follow-through')).json()).rows[0].evidence,'saved');assert.equal((await(await fetch(url+'/api/briefing')).json()).followThrough.counts.selections,1);assert.equal((await fetch(url+'/plan-follow-through.js')).status,200);assert.equal(f.calls,0);
});
