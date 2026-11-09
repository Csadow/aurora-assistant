import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {taskLine} from '../src/task-meta.mjs';
import {workloadFollow} from '../src/workload-follow.mjs';
import {workloadPlanHTML} from '../public/workload-follow.js';
import {workloadContext,createWorkload,validateWorkload} from '../public/week-workload-draft.js';
import {TIMETABLE_PATH,emptyTimetable,timetableMarkdown} from '../mobile/web/timetable.js';

const date='2098-05-12';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-workload-follow-'));let calls=0;
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],ollamaClient:{status:async()=>({online:false}),chat:async()=>{calls++;throw Error('No inference expected');}},workflowOptions:{pollMs:60000}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await app.workflows.close();app.calendar.close();app.recurring.stop();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 const day=app.dayPlanning,clock={now:new Date(2098,4,12,8)},history=day.dailyFocus.history;day.now=()=>clock.now;history.now=()=>clock.now.toISOString();const cal={enabled:false,complete:true,revision:'off',events:[],warnings:[]};day.calendar={context:async()=>cal,fresh:async()=>cal};
 const tt=await app.vault.read(TIMETABLE_PATH).catch(()=>null);await app.vault.save(TIMETABLE_PATH,timetableMarkdown(emptyTimetable()),tt?.revision||null);
 const ids=[randomUUID(),randomUUID(),randomUUID()];for(let i=0;i<3;i++)await app.vault.save('40 Tasks/Workload follow '+i+'.md','- [ ] '+taskLine('Workload '+i+' <img src=x>',{duration:30,due:date},ids[i]),null);
 const r=await day.weekCapacity(date),draft=createWorkload({version:1,date,timezone:r.timezone,start:'09:00',end:'12:00',gap:10,rows:r.rows.filter(r=>ids.includes(r.taskId)).map(r=>({...r,selected:true}))});draft.selection.rows.find(r=>r.taskId===ids[2]).selected=false;
 const daily=await day.nextDay(date),input={requestId:randomUUID(),date,today:date,timezone:r.timezone,start:'09:00',end:'12:00',gap:10,origin:'week-workload',selected:daily.rows.filter(r=>ids.slice(0,2).includes(r.taskId)).map(r=>({taskId:r.taskId,contextRevision:r.contextRevision})),workloadSource:workloadContext(draft)};
 const report=(input={})=>workloadFollow(day,input),snapshot=async()=>({notes:await app.vault.list(),history:await history.read(),focus:await day.dailyFocus.read(),steps:await day.firstSteps.read(),sessions:await day.focusSessions.read(),proposals:await app.store.list('proposals'),workflows:await app.store.list('workflows')});
 return {app,day,clock,history,ids,draft,input,report,snapshot,get calls(){return calls;}};
}
test('workload previews durably bind original shortlist, excluded work and exact replay without claiming a save',async t=>{
 const f=await fixture(t),p=await f.day.nextDayPreview(f.input),before=await f.snapshot(),r=await f.report({proposalId:p.id}),a=r.plans[0];assert.equal(a.recorded,0);assert.equal(a.reservedMinutes,0);assert.equal(a.rows.length,3);assert.equal(a.rows[2].selection,'excluded');assert.equal(a.rows[2].proposed,null);assert.deepEqual(a.context,f.input.workloadSource);assert.deepEqual(await f.snapshot(),before);assert.equal(f.calls,0);
 const changed=structuredClone(f.input);changed.workloadSource.rows[2].task.duration=40;await assert.rejects(f.day.nextDayPreview(changed),/another preview/);f.clock.now=new Date(2098,4,22,8);assert.equal((await f.day.nextDayPreview(f.input)).id,p.id);assert.equal((await f.report({proposalId:p.id})).plans[0].context.date,date);
});
test('partial save, dismissal and later excluded-task edit keep receipts and original deadlines separate',async t=>{
 const f=await fixture(t),p=await f.day.nextDayPreview(f.input),save=f.app.vault.save.bind(f.app.vault);let n=0;f.app.vault.save=async(...a)=>{if(++n===2)throw Error('Interrupted second note');return save(...a);};await assert.rejects(f.day.decide(p.id,'accept'),/Saved 1 of 2/);f.app.vault.save=save;let a=(await f.report({proposalId:p.id})).plans[0];assert.equal(a.recorded,1);assert.equal(a.reservedMinutes,30);assert.equal(a.savedNotes,1);assert.equal(a.rows[1].saved,null);assert.equal(a.rows[1].current.planDate,null);await f.day.decide(p.id,'dismiss');
 for(const id of [f.ids[0],f.ids[2]]){const task=(await f.app.vault.tasks()).find(t=>t.id===id);await f.app.vault.scheduleTask({...task,planDate:'2098-05-14',startTime:'13:00',duration:45,due:'2098-05-15'});}
 const before=await f.snapshot();a=(await f.report({proposalId:p.id})).plans[0];assert.equal(a.status,'dismissed');assert.equal(a.recorded,1);assert.equal(a.rows[0].saved.after.startTime,'09:00');assert.equal(a.rows[0].saved.after.due,date);assert(a.rows[0].changedSinceSave);assert(a.rows[2].changedSinceRetained);assert.equal(a.rows[2].retained.due,date);assert.equal(a.rows[2].current.due,'2098-05-15');assert.equal(a.rows[2].saved,null);assert.deepEqual(await f.snapshot(),before);
});
test('completed slots and elapsed time never imply completion; saved-day entry links the workload origin',async t=>{
 const f=await fixture(t),p=await f.day.nextDayPreview(f.input);await f.day.decide(p.id,'accept');f.clock.now=new Date(2098,4,12,18);let a=(await f.report()).plans[0];assert.equal(a.recorded,2);assert(a.rows[0].elapsed);assert.equal(a.rows[0].current.done,false);let note=await f.app.vault.read(a.rows[0].current.path);await f.app.vault.save(note.path,note.content.replace('- [ ]','- [x]'),note.revision);a=(await f.report()).plans[0];assert.equal(a.rows[0].current.done,true);assert.equal(a.rows[0].saved.after.done,false);assert.equal((await f.day.savedPlans(date)).plans[0].origin,'week-workload');
});
test('history pending or unavailable stays distinct from zero saved changes and reading never reconciles',async t=>{
 const f=await fixture(t),p=await f.day.nextDayPreview(f.input),committed=f.history.committed.bind(f.history);f.history.committed=async()=>{throw Error('Lost history reply');};await assert.rejects(f.day.decide(p.id,'accept'));f.history.committed=committed;const before=await f.snapshot();let r=await f.report();assert.equal(r.plans[0].recorded,0);assert(r.warnings.some(w=>w.includes('reconciliation')));assert.deepEqual(await f.snapshot(),before);await f.history.report();r=await f.report();assert.equal(r.plans[0].recorded,1);assert.equal(r.plans[0].rows[0].saved.source,'recovered_save');
 const read=f.history.read;f.history.read=async()=>{throw Error('History offline');};r=await f.report();assert.equal(r.plans[0].recorded,null);assert.equal(r.plans[0].reservedMinutes,null);assert(r.plans[0].rows[0].current);f.history.read=read;
});
test('missing, duplicate, damaged and unavailable current tasks preserve retained context and receipts',async t=>{
 const f=await fixture(t),p=await f.day.nextDayPreview(f.input);await f.day.decide(p.id,'accept');await f.app.vault.save('40 Tasks/Duplicate.md','- [ ] '+taskLine('Duplicate',{},f.ids[0]),null);let a=(await f.report()).plans[0];assert.match(a.rows[0].issue,/Duplicate/);assert(a.rows[0].saved);let note=await f.app.vault.read(a.rows[2].current.path);await f.app.vault.trash(note.path,note.revision);a=(await f.report()).plans[0];assert.match(a.rows[2].issue,/completion is unknown/);assert.equal(a.rows[2].retained.due,date);note=await f.app.vault.read(a.rows[1].current.path);await f.app.vault.save(note.path,note.content.replace('"duration":30','"duration":0'),note.revision);a=(await f.report()).plans[0];assert.match(a.rows[1].issue,/metadata needs repair/);
 f.app.vault.tasks=async()=>{throw Error('Notes offline');};a=(await f.report()).plans[0];assert.equal(a.recorded,2);assert(a.rows.every(r=>r.current===null&&r.issue.includes('unavailable')));
});
test('held selected work differs from excluded work, and older previews explicitly lack a full shortlist',async t=>{
 const f=await fixture(t),p=await f.day.nextDayPreview({...f.input,end:'09:40'});let a=(await f.report()).plans[0];assert.equal(a.rows[1].selection,'selected');assert(a.rows[1].held);assert.equal(a.rows[2].selection,'excluded');assert.equal(a.rows[2].held,null);const legacy={...f.input,requestId:randomUUID()};delete legacy.workloadSource;const old=await f.day.nextDayPreview(legacy);a=(await f.report({proposalId:old.id})).plans[0];assert(a.legacy);assert.equal(a.rows.length,2);assert(a.rows.every(r=>r.selection==='unknown'));
});
test('validation rejects malformed or unrelated context; damaged saved records remain visible and pagination is bounded',async t=>{
 const f=await fixture(t);for(const change of [s=>s.rows.push(s.rows[0]),s=>s.selectedIds.push(randomUUID()),s=>s.rows[0].task.id=randomUUID(),s=>s.rows[0].task.duration=0,s=>s.date='bad',s=>s.start='29:00']){const i=structuredClone(f.input);change(i.workloadSource);await assert.rejects(f.day.nextDayPreview(i),/context/);}await assert.rejects(f.day.nextDayPreview({...f.input,origin:'week-capacity'}),/workload planning source/);
 const p=await f.day.nextDayPreview(f.input),raw=await f.app.store.get('proposals',p.id);for(let i=0;i<11;i++)await f.app.store.put('proposals',{...raw,id:randomUUID()});assert.equal((await f.report()).plans.length,10);assert.equal((await f.report({offset:10})).plans.length,2);await f.app.store.put('proposals',{...raw,workloadSource:{bad:true}});assert((await f.report({proposalId:p.id})).plans[0].error);for(const i of [{offset:-1},{offset:0.1},{proposalId:'bad'}])await assert.rejects(f.report(i));
});
test('workload context in a local pending draft cannot be silently replaced and read-only API serves the new module',async t=>{
 const f=await fixture(t);f.draft.selection.pending=f.input;validateWorkload(f.draft);f.draft.source.rows[0].task.duration=40;assert.throws(()=>validateWorkload(f.draft),/cannot be read/);
 const p=await f.day.nextDayPreview(f.input),before=await f.snapshot();await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.app.server.address().port;assert.equal((await fetch(base+'/workload-follow.js')).status,200);const response=await fetch(base+'/api/workload-follow?proposalId='+p.id);assert.equal(response.status,200);assert.equal((await response.json()).plans[0].id,p.id);assert.equal((await fetch(base+'/api/workload-follow?offset=-1')).status,400);assert.equal((await fetch(base+'/api/workload-follow',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);assert.deepEqual(await f.snapshot(),before);assert.equal(f.calls,0);
});
test('rendering escapes every task source and distinguishes unavailable receipts, exclusion and current state',async t=>{
 const f=await fixture(t);await f.day.nextDayPreview(f.input);const e=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');let r=await f.report(),html=workloadPlanHTML(r.plans[0],r,e);assert(!html.includes('<img'));assert(html.includes('Excluded from revised workload'));assert(html.includes('Proposed slot:'));assert(html.includes('No changed-task receipt'));
 f.history.read=async()=>{throw Error('History offline');};r=await f.report();html=workloadPlanHTML(r.plans[0],r,e);assert(html.includes('Recorded saves unavailable'));assert(!html.includes('0 of 2'));assert(html.includes('Successful saves cannot be determined'));
});
test('a lost save acknowledgement is read as an actual receipt without retrying writes or requiring current note equality',async t=>{
 const f=await fixture(t),p=await f.day.nextDayPreview(f.input),put=f.app.store.put.bind(f.app.store);let interrupted=false;f.app.store.put=async(kind,value)=>{if(kind==='proposals'&&value.id===p.id&&value.saved.length===1&&!interrupted){interrupted=true;throw Error('Lost proposal acknowledgement');}return put(kind,value);};await assert.rejects(f.day.decide(p.id,'accept'));f.app.store.put=put;let a=(await f.report({proposalId:p.id})).plans[0];assert.equal(a.status,'pending');assert.equal(a.savedNotes,0);assert.equal(a.recorded,1);assert.equal(a.rows[1].saved,null);const task=(await f.app.vault.tasks()).find(t=>t.id===f.ids[0]);await f.app.vault.scheduleTask({...task,duration:45});const before=await f.snapshot();a=(await f.report({proposalId:p.id})).plans[0];assert.equal(a.rows[0].saved.after.duration,30);assert.equal(a.rows[0].current.duration,45);assert(a.rows[0].changedSinceSave);assert.deepEqual(await f.snapshot(),before);
});
