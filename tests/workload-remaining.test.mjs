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
import {workloadRemaining} from '../src/workload-remaining.mjs';
import {workloadRemainingHTML} from '../public/workload-remaining.js';
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
const read=(f,source,input={})=>workloadRemaining(f.day,{proposalId:source.id,...input});
test('one task row joins original and repeated follow-up receipts, retaining latest placement and current reservation',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input);await f.day.decide(source.id,'accept');f.clock.now=new Date(2098,4,12,16);
 const a=await followup(f,source,[f.ids[0]]);await f.day.decide(a.id,'accept');f.clock.now=new Date(2098,4,13,16);const b=await followup(f,source,[f.ids[0]],'2098-05-14');await f.day.decide(b.id,'accept');
 const before=await f.snapshot(),r=await read(f,source);assert.equal(r.total,3);assert.equal(new Set(r.rows.map(x=>x.taskId)).size,3);const row=r.rows.find(x=>x.taskId===f.ids[0]);assert.equal(row.receiptCount,3);assert.equal(row.latest.proposalId,b.id);assert.equal(row.state,'reserved');assert.equal(row.canSelect,false);assert.equal(r.plans.length,2);assert.equal(row.current.planDate,'2098-05-14');assert.deepEqual(await f.snapshot(),before);assert.equal(f.calls,0);
});
test('unsaved, held and partial proposals remain separate from actual placements and omitted work',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),a=await followup(f,source),save=f.app.vault.save.bind(f.app.vault);let n=0;f.app.vault.save=async(...args)=>{if(++n===2)throw Error('Partial remaining fixture');return save(...args);};await assert.rejects(f.day.decide(a.id,'accept'));f.app.vault.save=save;
 const r=await read(f,source);assert.equal(r.plans[0].recorded,1);assert.equal(r.rows.find(x=>x.taskId===f.ids[0]).state,'reserved');const second=r.rows.find(x=>x.taskId===f.ids[1]);assert.equal(second.latest,null);assert.equal(second.withoutReceipt,1);assert.equal(second.state,'ready');assert.equal(r.rows.find(x=>x.taskId===f.ids[2]).proposedIn.length,0);
 await f.day.decide(a.id,'dismiss');const held=await followup(f,source,[f.ids[1],f.ids[2]],'2098-05-14','09:30');await f.day.decide(held.id,'accept');const next=await read(f,source);assert.equal(next.rows.find(x=>x.taskId===held.held[0].taskId).heldIn.length,1);assert.equal(next.rows.find(x=>x.taskId===held.held[0].taskId).state,'ready');
});
test('current edits, completion, prerequisites and live attempts determine readiness without changing historical receipts',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),a=await followup(f,source,[f.ids[0]]);await f.day.decide(a.id,'accept');let task=(await f.app.vault.tasks()).find(x=>x.id===f.ids[0]);await f.app.vault.scheduleTask({...task,planDate:'2098-05-25',startTime:'11:00',duration:45});let r=await read(f,source),row=r.rows.find(x=>x.taskId===task.id);assert(row.changedSinceLatest);assert.equal(row.latest.after.planDate,'2098-05-13');assert.equal(row.state,'reserved');assert.deepEqual(row.eligibleDates,[]);
 const note=await f.app.vault.read(task.path);await f.app.vault.save(note.path,note.content.replace('- [ ]','- [x]'),note.revision);assert.equal((await read(f,source)).rows.find(x=>x.taskId===task.id).state,'complete');
 task=(await f.app.vault.tasks()).find(x=>x.id===f.ids[1]);await f.app.vault.scheduleTask({...task,dependsOn:[f.ids[2]]});r=await read(f,source);assert.equal(r.rows.find(x=>x.taskId===task.id).state,'blocked');assert.match(r.rows.find(x=>x.taskId===task.id).detail,/Waiting/);
 f.day.execution=async()=>[{taskId:f.ids[2],id:'active',status:'running',executionRevision:'a'}];assert.equal((await read(f,source)).rows.find(x=>x.taskId===f.ids[2]).state,'blocked');
});
test('missing, duplicate and unavailable tasks remain unknown, never completed or silently removed',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),tasks=await f.app.vault.tasks(),note=await f.app.vault.read(tasks.find(x=>x.id===f.ids[0]).path);await f.app.vault.trash(note.path,note.revision);await f.app.vault.save('40 Tasks/duplicate.md','- [ ] '+taskLine('Duplicate',{duration:30},f.ids[1]),null);
 let r=await read(f,source);assert.equal(r.total,3);assert.equal(r.counts.unknown,2);assert.match(r.rows[0].detail,/completion is unknown/);assert.match(r.rows[1].detail,/Duplicate/);const tasksFn=f.app.vault.tasks;f.app.vault.tasks=async()=>{throw Error('Tasks offline');};r=await read(f,source);assert.equal(r.canPlan,false);assert.equal(r.counts.unknown,3);f.app.vault.tasks=tasksFn;
});
test('missing original membership retains known follow-up tasks and receipts but disables further planning',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),a=await followup(f,source,[f.ids[2]]);await f.day.decide(a.id,'accept');const list=f.app.store.list.bind(f.app.store),all=await list('proposals'),get=f.app.store.get.bind(f.app.store);f.app.store.list=async k=>k==='proposals'?all.filter(x=>x.id!==source.id):list(k);f.app.store.get=async(k,id)=>{if(k==='proposals'&&id===source.id)throw Error('Original missing');return get(k,id);};
 const before=await f.app.vault.list(),r=await read(f,source);assert.equal(r.sources.original,false);assert.equal(r.canPlan,false);assert.equal(r.total,1);assert.equal(r.rows[0].latest.proposalId,a.id);assert.equal(r.rows[0].state,'reserved');assert.deepEqual(await f.app.vault.list(),before);
});
test('unavailable or pending history blocks the planning entry; recovered receipts and future observations stay honest',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),a=await followup(f,source);await f.day.decide(a.id,'accept');const history=f.history.read.bind(f.history);f.history.read=async()=>{throw Error('History offline');};let r=await read(f,source);assert.equal(r.canPlan,false);assert(r.rows.every(x=>x.latest===null&&x.receiptCount===null));assert(r.plans.every(x=>x.recorded===null));
 f.history.read=async()=>{const h=await history();return {...h,pending:{decision:{proposalId:a.id}},events:h.events.map(e=>e.decision?.proposalId===a.id?{...e,source:'recovered_save',recordedAt:e.taskId===f.ids[0]?e.recordedAt:'2099-01-01T00:00:00.000Z'}:e)};};r=await read(f,source);assert.equal(r.pending,true);assert.equal(r.canPlan,false);assert.equal(r.rows[0].latest.source,'recovered_save');assert.equal(r.rows[1].latest,null);
});
test('all receipts contribute to latest placement beyond display limits, and pagination never duplicates task rows',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),a=await followup(f,source,[f.ids[0]]);await f.day.decide(a.id,'accept');const history=f.history.read.bind(f.history),h=await history(),event=h.events.find(e=>e.decision?.proposalId===a.id);const more=Array.from({length:25},(_,i)=>({...event,id:randomUUID(),recordedAt:new Date(f.clock.now.getTime()+i).toISOString()}));f.history.read=async()=>({...h,events:[...h.events,...more]});f.clock.now=new Date(2098,4,12,8,1);let r=await read(f,source);assert.equal(r.total,3);assert.equal(r.rows[0].receiptCount,26);assert.equal(r.rows[0].receipts.length,3);const first=await read(f,source,{taskId:f.ids[0]}),second=await read(f,source,{taskId:f.ids[0],offset:20});assert.equal(first.rows.length,1);assert.equal(first.rows[0].receipts.length,20);assert.equal(second.rows[0].receipts.length,6);assert.equal(new Set([...first.rows[0].receipts,...second.rows[0].receipts].map(x=>x.id)).size,26);
});
test('guarded week planning rejects a new reservation after review and preserves exact lost-reply recovery',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),r=await read(f,source);assert.equal(r.counts.ready,3);const next=await workloadNextReport(f.day,{proposalId:source.id,date}),input={date,today:next.today,timezone:next.timezone,start:'09:00',end:'12:00',gap:10,workloadFrom:{proposalId:source.id,revision:next.source.revision},selected:next.rows.filter(x=>x.taskId===f.ids[2]).map(x=>({taskId:x.taskId,contextRevision:x.contextRevision}))};
 const a=await assessWorkloadNext(f.day,input),request={...a.days[0].preview,requestId:randomUUID()},preview=await f.day.nextDayPreview(request),task=(await f.app.vault.tasks()).find(x=>x.id===f.ids[2]);await f.app.vault.scheduleTask({...task,planDate:'2098-05-25',startTime:'11:00'});await assert.rejects(assessWorkloadNext(f.day,input),/selected task/);await assert.rejects(f.day.decide(preview.id,'accept'),/changed/);assert.equal((await f.day.nextDayPreview(request)).id,preview.id);assert.equal((await read(f,source)).rows.find(x=>x.taskId===task.id).state,'reserved');
});
test('legacy, damaged follow-ups, escaping and API validation preserve bounded membership and explicit unknowns',async t=>{
 const f=await fixture(t),input={...f.input};delete input.workloadSource;const source=await f.day.nextDayPreview(input),a=await followup(f,source,[f.ids[0]]);await f.day.decide(a.id,'accept');let r=await read(f,source);assert.equal(r.source.legacy,true);assert.equal(r.total,2);await f.app.store.put('proposals',{...await f.app.store.get('proposals',a.id),held:null});r=await read(f,source);assert.equal(r.canPlan,false);assert(r.plans[0].error);assert.equal(r.rows[0].receiptCount,1);
 const e=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),html=workloadRemainingHTML(r,e);assert(!html.includes('<img'));assert(html.includes('&lt;img'));assert.equal((html.match(/data-workload-remaining-task=/g)||[]).length,2);
 await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+f.app.server.address().port;assert.equal((await fetch(url+'/workload-remaining.js')).status,200);assert.equal((await fetch(url+'/api/workload-remaining?proposalId=bad')).status,400);assert.equal((await fetch(url+'/api/workload-remaining?proposalId='+source.id+'&taskId='+randomUUID())).status,404);assert.equal((await fetch(url+'/api/workload-remaining?proposalId='+source.id+'&date=2098-02-30')).status,400);assert.equal((await(await fetch(url+'/api/workload-remaining?proposalId='+source.id)).json()).total,2);assert.equal(f.calls,0);
});
