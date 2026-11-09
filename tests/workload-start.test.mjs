import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {taskLine} from '../src/task-meta.mjs';
import {workloadFollow} from '../src/workload-follow.mjs';
import {workloadNextReport,assessWorkloadNext} from '../src/workload-next.mjs';
import {workloadStart} from '../src/workload-start.mjs';
import {continueDay} from '../src/continue-day.mjs';
import {workloadStartHTML,workloadStartSummary} from '../public/workload-start.js';
import {workloadContext,createWorkload} from '../public/week-workload-draft.js';
import {TIMETABLE_PATH,emptyTimetable,timetableMarkdown} from '../mobile/web/timetable.js';
const date='2098-05-12';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-workload-next-'));let calls=0;
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

async function followup(f,source,ids=f.ids.slice(0,2),target='2098-05-13',end='12:00'){
 const r=await workloadNextReport(f.day,{proposalId:source.id,date:target}),a=await assessWorkloadNext(f.day,{date:r.date,today:r.today,timezone:r.timezone,start:'09:00',end,gap:10,workloadFrom:{proposalId:r.source.proposalId,revision:r.source.revision},selected:r.rows.filter(r=>ids.includes(r.taskId)).map(r=>({taskId:r.taskId,contextRevision:r.contextRevision}))});
 return f.day.nextDayPreview({...a.days[0].preview,requestId:randomUUID()});
}
const read=(f,input={})=>workloadStart(f.day,input);
test('only actual future follow-up receipts enter the matching daily start and briefing; repeated reads never choose focus',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),p=await followup(f,source);
 assert.equal((await read(f,{date:p.targetDate})).total,0);await f.day.decide(p.id,'accept');assert.equal((await read(f)).total,0);
 f.clock.now=new Date(2098,4,13,8);const before=await f.snapshot(),r=await read(f),again=await read(f);assert.equal(r.total,1);assert.deepEqual(r,again);const plan=r.plans[0];assert.equal(plan.recorded,2);assert.equal(plan.omitted,1);assert.equal(plan.sourceChanged,false);assert.equal(plan.rows[2].selection,'omitted');assert.equal(plan.rows[2].original.selection,'excluded');assert.equal(plan.rows[2].saved,null);
 const b=await f.day.briefing(),c=await continueDay(f.day);assert.equal(b.start.workload.plans[0].id,p.id);assert.equal(c.start.workload.plans[0].id,p.id);assert.equal(c.focusTotal,0);assert.deepEqual(await f.snapshot(),before);assert.equal(f.calls,0);
});
test('partial saves expose recorded versus unrecorded rows without replaying the remaining write',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),p=await followup(f,source),save=f.app.vault.save.bind(f.app.vault);let n=0;f.app.vault.save=async(...args)=>{if(++n===2)throw Error('Interrupted fixture');return save(...args);};await assert.rejects(f.day.decide(p.id,'accept'));f.app.vault.save=save;
 const before=await f.snapshot(),r=await read(f,{date:p.targetDate}),plan=r.plans[0];assert.equal(plan.recorded,1);assert.equal(plan.unrecorded,1);assert.equal(plan.recordedMinutes,30);assert.equal(plan.status,'pending');assert.equal(plan.rows.filter(x=>x.saved).length,1);assert.deepEqual(await f.snapshot(),before);
 await f.day.decide(p.id,'dismiss');assert.equal((await read(f,{date:p.targetDate})).plans[0].status,'dismissed');
});
test('later rescheduling and completion retain both receipts; missing and duplicate tasks never imply completion',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),p=await followup(f,source);await f.day.decide(p.id,'accept');let task=(await f.app.vault.tasks()).find(x=>x.id===f.ids[0]);await f.app.vault.scheduleTask({...task,planDate:'2098-05-14',startTime:'11:00',duration:45});
 let r=await read(f,{date:p.targetDate}),row=r.plans[0].rows[0];assert.equal(row.saved.after.planDate,'2098-05-13');assert.equal(row.proposed.planDate,'2098-05-13');assert.equal(row.current.planDate,'2098-05-14');assert(row.changedSinceSave);let note=await f.app.vault.read(task.path);await f.app.vault.save(note.path,note.content.replace('- [ ]','- [x]'),note.revision);assert((await read(f,{date:p.targetDate})).plans[0].rows[0].current.done);
 await f.app.vault.save('40 Tasks/duplicate.md','- [ ] '+taskLine('duplicate',{duration:30},f.ids[1]),null);note=await f.app.vault.read((await f.app.vault.tasks()).find(x=>x.id===f.ids[2]).path);await f.app.vault.trash(note.path,note.revision);r=await read(f,{date:p.targetDate});assert.match(r.plans[0].rows[1].issue,/Duplicate/);assert.equal(r.plans[0].rows[1].current,null);assert.match(r.plans[0].rows[2].issue,/completion is unknown/);
});
test('multiple follow-ups remain distinct, including different dates and later source changes',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),p=await followup(f,source,[f.ids[0]]);await f.day.decide(p.id,'accept');f.clock.now=new Date(2098,4,12,8,1);const next=await followup(f,source,[f.ids[1]]);await f.day.decide(next.id,'accept');const other=await followup(f,source,[f.ids[2]],'2098-05-14');await f.day.decide(other.id,'accept');
 let r=await read(f,{date:p.targetDate});assert.equal(r.total,2);assert.equal(new Set(r.plans.map(x=>x.id)).size,2);assert(r.plans.every(x=>x.recorded===1&&x.omitted===2));assert.equal((await read(f,{date:'2098-05-14'})).total,1);await f.day.decide(source.id,'dismiss');r=await read(f,{date:p.targetDate});assert(r.plans.every(x=>x.sourceChanged));assert.equal(r.plans[0].rows.filter(x=>x.saved).length,1);
});
test('unavailable original history preserves follow-up receipts and marks omitted membership unknown',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),p=await followup(f,source);await f.day.decide(p.id,'accept');const list=f.app.store.list.bind(f.app.store),proposals=await list('proposals'),get=f.app.store.get.bind(f.app.store);f.app.store.list=async k=>k==='proposals'?proposals.filter(x=>x.id!==source.id):list(k);f.app.store.get=async(kind,id)=>{if(kind==='proposals'&&id===source.id)throw Error('Source missing');return get(kind,id);};let r=await read(f,{date:p.targetDate});assert.equal(r.plans[0].recorded,2);assert.equal(r.plans[0].omitted,null);assert.match(r.plans[0].sourceError,/unavailable/);assert.equal(r.plans[0].rows.length,2);f.app.store.get=get;f.app.store.list=list;
 const history=f.history.read.bind(f.history);f.history.read=async()=>{throw Error('History offline');};r=await read(f,{date:p.targetDate});assert.equal(r.sources.history,false);assert.equal(r.plans[0].recorded,null);assert.equal(r.plans[0].unrecorded,null);assert.equal(r.plans[0].sourceChanged,null);assert(r.plans[0].rows.every(x=>!x.saved));f.history.read=history;
});
test('pending and future receipts are not counted; recovered receipts retain their provenance',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),p=await followup(f,source);await f.day.decide(p.id,'accept');const history=f.history.read.bind(f.history);f.history.read=async()=>{const h=await history();return {...h,pending:{decision:{proposalId:p.id}},events:h.events.map(e=>e.decision?.proposalId===p.id?{...e,source:e.taskId===f.ids[0]?'recovered_save':e.source,recordedAt:e.taskId===f.ids[1]?'2099-01-01T00:00:00.000Z':e.recordedAt}:e)};};const r=await read(f,{date:p.targetDate});assert.equal(r.plans[0].recorded,1);assert.equal(r.plans[0].rows[0].saved.source,'recovered_save');assert(r.warnings.some(w=>w.includes('reconciliation')));assert.equal(r.plans[0].rows[1].saved,null);
});
test('legacy original membership stays bounded and malformed follow-up records do not crash the report',async t=>{
 const f=await fixture(t),input={...f.input};delete input.workloadSource;const source=await f.day.nextDayPreview(input),p=await followup(f,source,[f.ids[0]]);await f.day.decide(p.id,'accept');let r=await read(f,{date:p.targetDate});assert.equal(r.plans[0].sourceLegacy,true);assert.equal(r.plans[0].rows.length,2);assert.equal(r.plans[0].omitted,1);await f.app.store.put('proposals',{...await f.app.store.get('proposals',p.id),held:null,created:'invalid'});r=await read(f,{date:p.targetDate});assert.match(r.plans[0].error,/cannot be read/);await f.app.store.put('proposals',{...await f.app.store.get('proposals',p.id),created:null});r=await read(f,{proposalId:p.id});assert.match(r.plans[0].error,/cannot be read/);
});
test('handoff markup escapes task content, separates provenance, and links existing controls without choosing work',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),p=await followup(f,source);await f.day.decide(p.id,'accept');const r=await read(f,{date:p.targetDate}),e=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),html=workloadStartHTML(r,e),summary=workloadStartSummary(r,null,e);assert(!html.includes('<img'));assert.match(html,/&lt;img/);assert.match(html,/Original shortlist/);assert.match(html,/Follow-up proposal/);assert.match(html,/Follow-up recorded save/);assert.match(html,/Current task/);assert.match(html,/first-step/);assert.match(html,/Left out/);assert.equal((summary.match(/data-workload-start-plan=/g)||[]).length,1);
});
test('read-only endpoint validates date and IDs, serves the module and bounds large daily lists',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),p=await followup(f,source);await f.day.decide(p.id,'accept');await assert.rejects(read(f,{date:'2098-02-30'}));await assert.rejects(read(f,{proposalId:'bad'}));await assert.rejects(read(f,{offset:-1}));await assert.rejects(read(f,{proposalId:source.id}),/not an unfinished/);
 const list=f.app.store.list.bind(f.app.store),hist=f.history.read.bind(f.history),base=await f.app.store.get('proposals',p.id),events=(await hist()).events.filter(e=>e.decision?.proposalId===p.id),copies=Array.from({length:12},()=>({...base,id:randomUUID()}));f.app.store.list=async k=>k==='proposals'?[...await list(k),...copies]:list(k);f.history.read=async()=>({...await hist(),events:[...(await hist()).events,...copies.flatMap(c=>events.map(e=>({...e,decision:{...e.decision,proposalId:c.id}})))]});assert.equal((await read(f,{date:p.targetDate})).plans.length,10);assert.equal((await read(f,{date:p.targetDate,offset:10})).plans.length,3);f.app.store.list=list;f.history.read=hist;
 await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+f.app.server.address().port;assert.equal((await fetch(url+'/api/workload-start?date=bad')).status,400);assert.equal((await fetch(url+'/workload-start.js')).status,200);const report=await(await fetch(url+'/api/workload-start?proposalId='+p.id)).json();assert.equal(report.plans[0].id,p.id);assert.equal(f.calls,0);
});

test('selected work that does not fit remains held, separate from excluded work and saved slots',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),p=await followup(f,source,f.ids.slice(0,2),'2098-05-13','09:30');
 assert.equal(p.held.length,1);await f.day.decide(p.id,'accept');const r=await read(f,{date:p.targetDate}),plan=r.plans[0];assert.equal(plan.recorded,1);assert.equal(plan.held,1);assert.equal(plan.omitted,1);const held=plan.rows.find(x=>x.selection==='held');assert(held.held);assert.equal(held.saved,null);assert.equal(held.proposed,null);assert.equal(held.current.planDate,null);assert.equal(f.calls,0);
});
