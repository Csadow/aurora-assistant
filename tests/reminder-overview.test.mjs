import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,unlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {taskLine} from '../src/task-meta.mjs';
import {workloadFollow} from '../src/workload-follow.mjs';
import {workloadNextReport,assessWorkloadNext} from '../src/workload-next.mjs';
import {workloadContext,createWorkload} from '../public/week-workload-draft.js';
import {TIMETABLE_PATH,emptyTimetable,timetableMarkdown} from '../mobile/web/timetable.js';
import {workloadReflection} from '../src/workload-reflection.mjs';
import {workloadReflectionHTML} from '../public/workload-reflection.js';
const date='2098-05-12';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-reminder-overview-'));let calls=0;
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

import {WorkloadRevisits} from '../src/workload-revisits.mjs';

async function seed(t){const f=await fixture(t),source=await f.day.nextDayPreview(f.input);return {...f,source,revisits:f.day.workloadRevisits,request:{requestId:randomUUID(),proposalId:source.id,review:{period:'day',date,offset:0},today:date,timezone:f.input.timezone}};}

const kind='workload-reminder-decisions',tomorrow='2098-05-13';
async function setup(t){const f=await seed(t),entry=await f.revisits.save(f.request);f.clock.now=new Date(2098,4,13,8);const plans=f.day.reminderPlans,report=()=>plans.report({reminderId:entry.id}),r=await report(),row=r.rows.find(r=>r.taskId===f.ids[2]),review={requestId:randomUUID(),reminderId:entry.id,taskId:row.taskId,contextRevision:row.contextRevision,today:r.today,timezone:r.timezone,acknowledge:true};return {...f,entry,plans,report,review};}
async function reviewed(t){const f=await setup(t),decision=await f.plans.review(f.review),assess=()=>f.plans.assess({decisionId:decision.id,date:tomorrow,start:'09:00',end:'18:00',gap:10});return {...f,decision,assess};}
async function previewed(t){const f=await reviewed(t),assessment=await f.assess(),input={...assessment.days.find(d=>d.preview&&d.fits.length).preview,requestId:randomUUID()},preview=await f.day.nextDayPreview(input);return {...f,input,preview};}

import {reminderOverview} from '../src/reminder-overview.mjs';

test('empty follow-through does not create records or load task execution, and validates filters',async t=>{
 const f=await fixture(t);f.day.execution=async()=>{throw Error('No execution read expected');};const before=await f.snapshot(),r=await reminderOverview(f.day);assert.equal(r.complete,true);assert.equal(r.total,0);assert.equal(r.sources.execution,null);assert.deepEqual(await f.snapshot(),before);for(const input of [{group:'bad'},{offset:-1},{offset:0.5},{brief:'yes'}])await assert.rejects(reminderOverview(f.day,input));
});
test('overview and shared morning/workspace projection separate reviewed, previewed and recorded placement without side effects',async t=>{
 const f=await reviewed(t),before=await f.snapshot(),r=await reminderOverview(f.day);assert.equal(r.rows[0].state,'reviewed');assert.equal(r.rows[0].group,'planning');assert.equal(r.rows[0].reviewedOn,tomorrow);assert.equal(r.rows[0].reminder.targetDate,tomorrow);assert.equal(r.rows[0].source.proposalId,f.source.id);assert.equal(r.rows[0].canOpenReminder,true);assert.deepEqual(await f.snapshot(),before);assert.deepEqual((await f.day.briefing()).start.reminderFollow.rows,r.rows);const {continueDay}=await import('../src/continue-day.mjs');assert.deepEqual((await continueDay(f.day)).start.reminderFollow.rows,r.rows);assert.deepEqual(await f.snapshot(),before);const a=await f.assess(),p=await f.day.nextDayPreview({...a.days[0].preview,requestId:randomUUID()});let row=(await reminderOverview(f.day)).rows[0];assert.equal(row.state,'preview');assert.equal(row.plans[0].recorded,0);await f.day.decide(p.id,'accept');row=(await reminderOverview(f.day)).rows[0];assert.equal(row.state,'scheduled');assert.equal(row.group,'scheduled');assert.equal(row.plans[0].recorded,1);assert.equal(row.latest.after.startTime,row.current.startTime);assert.equal(f.calls,0);
});
test('passed slots and later edits remain separate from completion and preserve original dates',async t=>{
 const f=await previewed(t);await f.day.decide(f.preview.id,'accept');f.clock.now=new Date(2098,4,14,8);let r=(await reminderOverview(f.day)).rows[0];assert.equal(r.group,'attention');assert.equal(r.state,'scheduled');assert.equal(r.reservationActive,false);assert.equal(r.reminder.targetDate,tomorrow);const task=(await f.app.vault.tasks()).find(t=>t.id===f.ids[2]);await f.app.vault.scheduleTask({...task,planDate:'2098-06-01',startTime:'13:00'});r=(await reminderOverview(f.day)).rows[0];assert.equal(r.state,'changed');assert.equal(r.latest.after.planDate,tomorrow);assert.equal(r.current.planDate,'2098-06-01');const n=await f.app.vault.read(task.path);await f.app.vault.save(n.path,n.content.replace('- [ ]','- [x]'),n.revision);assert.equal((await reminderOverview(f.day)).total,0);r=(await reminderOverview(f.day,{group:'history'})).rows[0];assert.equal(r.state,'completed');assert.equal(r.plans[0].recorded,1);
});
test('an unrelated reservation is shown as current but is not attributed to this review',async t=>{
 const f=await reviewed(t),task=(await f.app.vault.tasks()).find(t=>t.id===f.ids[2]);await f.app.vault.scheduleTask({...task,planDate:'2098-06-01',startTime:'13:00'});const r=(await reminderOverview(f.day)).rows[0];assert.equal(r.state,'reviewed');assert.equal(r.latest,null);assert.equal(r.reservationActive,true);assert.equal(r.current.startTime,'13:00');
});
test('dismissing a reminder retains its linked preview in history without marking the task complete',async t=>{
 const f=await previewed(t);await f.revisits.dismiss({id:f.entry.id,revision:f.entry.revision});assert.equal((await reminderOverview(f.day)).total,0);const r=(await reminderOverview(f.day,{group:'all'})).rows[0];assert.equal(r.group,'history');assert.equal(r.state,'preview');assert.equal(r.reminder.status,'dismissed');assert.equal(r.current.done,false);assert.equal(r.plans[0].id,f.preview.id);
});
test('missing decisions retain referenced plans as unknown instead of hiding saved work',async t=>{
 const f=await previewed(t);await f.day.decide(f.preview.id,'accept');await unlink(f.app.store.file(kind,f.decision.id));const before=await f.snapshot(),r=await reminderOverview(f.day);assert.equal(r.rows.length,1);assert.equal(r.rows[0].state,'unknown');assert.equal(r.rows[0].canOpenReminder,false);assert.equal(r.rows[0].plans[0].id,f.preview.id);assert.equal(r.rows[0].reviewedOn,null);assert.deepEqual(await f.snapshot(),before);
});
for(const missing of ['original','reminder','task'])test('missing '+missing+' retains the review and explicit uncertainty',async t=>{
 const f=await previewed(t);if(missing==='original')await unlink(f.app.store.file('proposals',f.source.id));if(missing==='reminder')await writeFile(f.revisits.path,JSON.stringify({version:1,entries:[]}));if(missing==='task'){const n=await f.app.vault.read((await f.app.vault.tasks()).find(t=>t.id===f.ids[2]).path);await f.app.vault.trash(n.path,n.revision);}const r=(await reminderOverview(f.day)).rows[0];assert.equal(r.id,f.decision.id);assert.equal(r.state,'unknown');assert.equal(r.plans[0].id,f.preview.id);assert.equal(r.reviewedOn,tomorrow);assert(r.issues.length);
});
test('partial saves stay pending until explicit history recovery; overview never reconciles or retries them',async t=>{
 const f=await previewed(t),committed=f.history.committed;f.history.committed=async()=>{throw Error('Lost receipt');};await assert.rejects(f.day.decide(f.preview.id,'accept'));const before=await f.snapshot();let r=(await reminderOverview(f.day)).rows[0];assert.equal(r.state,'unknown');assert.equal(r.plans[0].pending,true);assert.equal(r.plans[0].recorded,0);assert.deepEqual(await f.snapshot(),before);f.history.committed=committed;await f.history.sync();r=(await reminderOverview(f.day)).rows[0];assert.equal(r.state,'scheduled');assert.equal(r.plans[0].recorded,1);assert.equal((await f.app.store.get('proposals',f.preview.id)).status,'pending');
});
test('unreadable source indexes and damaged decision records stay visibly incomplete',async t=>{
 const f=await previewed(t),read=f.history.read;f.history.read=async()=>{throw Error('History unavailable');};let r=await reminderOverview(f.day);assert.equal(r.complete,false);assert.equal(r.rows[0].state,'unknown');assert.equal(r.rows[0].plans[0].recorded,null);f.history.read=read;const list=f.app.store.list;f.app.store.list=async function(k){if(k===kind)throw Error('Index missing');return list.call(this,k);};r=await reminderOverview(f.day);assert.equal(r.complete,false);assert.equal(r.rows[0].plans[0].id,f.preview.id);f.app.store.list=list;const d=await f.app.store.get(kind,f.decision.id);await f.app.store.put(kind,{...d,taskId:'invalid'});r=await reminderOverview(f.day);assert.equal(r.complete,false);assert.equal(r.rows[0].state,'unknown');assert(r.warnings.length);
});
test('a mismatched review reference never attributes a receipt to the wrong decision',async t=>{
 const f=await previewed(t);await f.day.decide(f.preview.id,'accept');const p=await f.app.store.get('proposals',f.preview.id);await f.app.store.put('proposals',{...p,reminderDecision:{...p.reminderDecision,revision:'0'.repeat(64)}});const r=(await reminderOverview(f.day)).rows[0];assert.equal(r.state,'unknown');assert.equal(r.latest,null);assert.equal(r.plans[0].recorded,null);
});
test('first-step and current existing workflow links are navigation snapshots, not new execution',async t=>{
 const f=await reviewed(t),task=(await f.app.vault.tasks()).find(t=>t.id===f.ids[2]),id=randomUUID();f.day.firstSteps.read=async()=>({cards:{[task.id]:{text:'Inspect one exercise <img src=x>',mode:'manual',context:{date,task},updated:f.clock.now.toISOString()}}});f.day.execution=async()=>[{id,taskId:task.id,workflowId:null,status:'draft',detail:'Existing draft'}];const r=(await reminderOverview(f.day)).rows[0];assert.equal(r.step.text,'Inspect one exercise <img src=x>');assert.equal(r.execution[0].id,id);assert.equal(r.execution[0].status,'draft');assert.equal((await f.app.store.list('workflows')).length,0);assert.equal(f.calls,0);
});
test('pagination and compact grouping preserve all reviews and source reads stay bounded',async t=>{
 const f=await reviewed(t);for(let n=0;n<13;n++)await f.plans.review({...f.review,requestId:randomUUID()});const counts={};for(const [target,name,key] of [[f.app.vault,'tasks','tasks'],[f.history,'read','history'],[f.day.firstSteps,'read','steps'],[f.day,'execution','execution']]){const fn=target[name];target[name]=async function(...args){counts[key]=(counts[key]||0)+1;return fn.apply(this,args);};}const a=await reminderOverview(f.day);assert.equal(a.total,14);assert.equal(a.rows.length,12);assert.deepEqual(counts,{tasks:2,history:1,steps:1,execution:1});const b=await reminderOverview(f.day,{offset:12}),brief=await reminderOverview(f.day,{brief:true});assert.equal(b.rows.length,2);assert.equal(brief.rows.length,3);assert.equal(brief.total,14);assert.equal(new Set([...a.rows,...b.rows].map(r=>r.id)).size,14);
});
test('the installed HTTP entry serves the shared module and refuses invalid filters',async t=>{
 const f=await reviewed(t);await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+f.app.server.address().port;assert.equal((await fetch(url+'/reminder-overview.js')).status,200);for(const suffix of ['group=bad','offset=-1','offset=1.5'])assert.equal((await fetch(url+'/api/reminder-overview?'+suffix)).status,400);const r=await(await fetch(url+'/api/reminder-overview')).json();assert.equal(r.rows[0].id,f.decision.id);
});
