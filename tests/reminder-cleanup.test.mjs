import {weekStart} from '../src/weekly-planner.mjs';
import {ReminderCleanup} from '../src/reminder-cleanup.mjs';
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
 const dir=await mkdtemp(join(tmpdir(),'aurora-reminder-cleanup-'));let calls=0;
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


async function setup(t){const f=await seed(t),first=await f.revisits.save(f.request),second=await f.revisits.save({...f.request,requestId:randomUUID(),review:{period:'week',date:weekStart(date),offset:0}});return {...f,first,second,cleanup:f.day.reminderCleanup};}

const request=f=>({requestId:randomUUID(),today:date,timezone:f.input.timezone,selected:[f.first,f.second].map(x=>({id:x.id,revision:x.revision}))});
const accept=r=>({id:r.review.id,revision:r.review.revision,acknowledge:true});
test('cleanup starts read-only, includes current task links and validates pagination',async t=>{
 const f=await setup(t),before=await f.snapshot(),r=await f.cleanup.report();assert.equal(r.total,2);assert(r.rows.every(r=>r.current.tasks.length===3));assert.deepEqual(await f.snapshot(),before);assert.equal((await f.app.store.list('reminder-cleanups')).length,0);for(const offset of [-1,1.2,100001])await assert.rejects(f.cleanup.report({offset}));assert.equal(f.calls,0);
});
test('review changes no reminders; confirmation dismisses exactly the selection with one atomic receipt and keeps tasks',async t=>{
 const f=await setup(t),before=await f.snapshot(),input=request(f);input.selected.pop();const r=await f.cleanup.review(input);assert(r.canConfirm);assert.equal((await f.revisits.read()).entries.filter(x=>x.status==='open').length,2);const saved=await f.cleanup.accept(accept(r));assert.equal(saved.receipt.ids.length,1);const state=await f.revisits.read();assert.equal(state.entries.find(x=>x.id===f.first.id).status,'dismissed');assert.equal(state.entries.find(x=>x.id===f.second.id).status,'open');assert.equal(state.cleanups.length,1);assert.deepEqual(await f.snapshot(),before);
});
test('two selected dismissals survive new instances and exact retries without duplicate receipts, even next day',async t=>{
 const f=await setup(t),input=request(f),r=await f.cleanup.review(input),saved=await f.cleanup.accept(accept(r));f.clock.now=new Date(2098,4,13,9);const cleanup=new ReminderCleanup({planner:f.day});assert.deepEqual((await cleanup.view(r.review.id)).receipt,saved.receipt);assert.deepEqual((await cleanup.accept(accept(r))).receipt,saved.receipt);assert.deepEqual((await cleanup.review(input)).receipt,saved.receipt);assert.equal((await f.revisits.read()).cleanups.length,1);
});
test('lost review response recovers the same record and a reused request cannot change selections',async t=>{
 const f=await setup(t),input=request(f),r=await f.cleanup.review(input);assert.deepEqual(await f.cleanup.review({...input,selected:[...input.selected].reverse()}),r);await assert.rejects(f.cleanup.review({...input,selected:input.selected.slice(0,1)}),/different cleanup/);assert.equal((await f.app.store.list('reminder-cleanups')).length,1);
});
test('one stale reminder blocks the whole confirmation and identifies the changed item',async t=>{
 const f=await setup(t),r=await f.cleanup.review(request(f));await f.revisits.dismiss({id:f.first.id,revision:f.first.revision});const v=await f.cleanup.view(r.review.id);assert.equal(v.canConfirm,false);assert(v.rows.find(x=>x.id===f.first.id).issues.some(x=>x.includes('dismissed')));await assert.rejects(f.cleanup.accept(accept(r)),/No reminders were dismissed/);assert.equal((await f.revisits.read()).entries.find(x=>x.id===f.second.id).status,'open');assert.equal((await f.revisits.read()).cleanups,undefined);
});
test('missing and revised selections are reported individually without losing other choices',async t=>{
 const f=await setup(t),input=request(f);input.selected[0].revision='0'.repeat(64);input.selected.push({id:randomUUID(),revision:'0'.repeat(64)});const r=await f.cleanup.review(input);assert.equal(r.canConfirm,false);assert.equal(r.rows.filter(x=>x.issues.length).length,2);await assert.rejects(f.cleanup.accept(accept(r)));assert((await f.revisits.read()).entries.every(x=>x.status==='open'));
});
test('day change and acknowledgement/revision checks stop an unconfirmed review',async t=>{
 const f=await setup(t),r=await f.cleanup.review(request(f));await assert.rejects(f.cleanup.accept({...accept(r),acknowledge:false}));await assert.rejects(f.cleanup.accept({...accept(r),revision:'0'.repeat(64)}),/changed/);f.clock.now=new Date(2098,4,13,8);assert((await f.cleanup.view(r.review.id)).dayChanged);await assert.rejects(f.cleanup.accept(accept(r)),/day or timezone/);assert((await f.revisits.read()).entries.every(x=>x.status==='open'));
});
test('commit guard catches a reminder edit at the atomic write boundary with no partial dismissal',async t=>{
 const f=await setup(t),r=await f.cleanup.review(request(f)),old=f.revisits.commit.bind(f.revisits);f.revisits.commit=async(s,b,g)=>{const current=await f.revisits.read();current.entries[0].source.title='Externally changed';await writeFile(f.revisits.path,JSON.stringify(current));return old(s,b,g);};await assert.rejects(f.cleanup.accept(accept(r)),/reminders changed/);assert((await f.revisits.read()).entries.every(x=>x.status==='open'));
});
test('marker failure after atomic dismissal recovers one receipt without replaying changes',async t=>{
 const f=await setup(t),r=await f.cleanup.review(request(f));await unlink(f.revisits.marker);await mkdir(f.revisits.marker);await assert.rejects(f.cleanup.accept(accept(r)),/may already be saved/);const state=await f.revisits.read();assert.equal(state.cleanups.length,1);assert(state.entries.every(x=>x.status==='dismissed'));await rm(f.revisits.marker,{recursive:true});const result=await f.cleanup.accept(accept(r));assert(result.receipt);assert.deepEqual(await f.revisits.read(),state);
});
test('a missing original workload can still be explicitly dismissed without inferring task completion',async t=>{
 const f=await setup(t),before=await f.snapshot();await unlink(f.app.store.file('proposals',f.source.id));const page=await f.cleanup.report();assert(page.rows.every(x=>!x.current.sources.original));const r=await f.cleanup.review(request(f));assert(r.canConfirm);await f.cleanup.accept(accept(r));assert.deepEqual(await f.app.vault.list(),before.notes);assert((await f.app.vault.tasks()).filter(x=>f.ids.includes(x.id)).every(x=>!x.done));
});
test('damaged review and receipts refuse confirmation; unreadable index never resets history',async t=>{
 const f=await setup(t),r=await f.cleanup.review(request(f));const record=await f.app.store.get('reminder-cleanups',r.review.id);for(const damaged of [null,[],{...record,date:'2098-05-13'}]){await writeFile(f.app.store.file('reminder-cleanups',record.id),JSON.stringify(damaged));await assert.rejects(f.cleanup.view(record.id),/cannot be read/);}await f.app.store.put('reminder-cleanups',record);await f.cleanup.accept(accept(r));const state=await f.revisits.read();state.cleanups[0].ids.push(state.cleanups[0].ids[0]);await writeFile(f.revisits.path,JSON.stringify(state));await assert.rejects(f.cleanup.view(record.id),/cannot be read/);await unlink(f.revisits.path);await assert.rejects(f.cleanup.report(),/missing/);
});
test('empty, duplicate and malformed selections cannot create review records',async t=>{
 const f=await setup(t),input=request(f);await assert.rejects(f.cleanup.review(null),/Select between/);await assert.rejects(f.cleanup.accept(null),/Confirm the exact/);for(const selected of [[],[input.selected[0],input.selected[0]],[{id:'bad',revision:'x'}]])await assert.rejects(f.cleanup.review({...input,selected}));assert.equal((await f.app.store.list('reminder-cleanups')).length,0);
});
test('HTTP cleanup reads and module load, while mutations require the existing authentication and explicit input',async t=>{
 const f=await setup(t);await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.app.server.address().port;assert.equal((await fetch(base+'/api/reminder-cleanup')).status,200);assert.equal((await fetch(base+'/api/reminder-cleanup?offset=-1')).status,400);assert.equal((await fetch(base+'/api/reminder-cleanup?id=bad')).status,400);assert((await (await fetch(base+'/reminder-cleanup.js')).text()).includes('createReminderCleanup'));const boot=await (await fetch(base+'/api/bootstrap')).json();for(const action of ['review','accept']){assert.equal((await fetch(base+'/api/reminder-cleanup/'+action,{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}})).status,403);assert.equal((await fetch(base+'/api/reminder-cleanup/'+action,{method:'POST',body:'{}',headers:{'Content-Type':'application/json','X-Aster-Token':boot.token}})).status,400);}
});

test('a full day keeps classes, an interrupted session and a changed unfinished task through evening cleanup and next-day reopening',async t=>{
 const f=await setup(t),id=f.ids[0],task=(await f.app.vault.tasks()).find(x=>x.id===id);await f.app.vault.scheduleTask({...task,planDate:date,startTime:'11:00'});
 const tt=await f.app.vault.read(TIMETABLE_PATH);await f.app.vault.save(tt.path,timetableMarkdown({...emptyTimetable(),travelConfirmed:true,classes:[{id:'class',day:f.clock.now.getDay(),title:'Mathematics',location:'Campus',start:'09:00',end:'10:00'}]}),tt.revision);
 const focus=await f.day.dailyFocus.report(),row=focus.rows.find(x=>x.taskId===id);await f.day.dailyFocus.decide({requestId:randomUUID(),taskId:id,date,timezone:focus.timezone,revision:focus.revision,contextRevision:row.contextRevision,action:'focus'});await f.day.firstSteps.save({requestId:randomUUID(),taskId:id,revision:(await f.day.firstSteps.report(id)).revision,text:'Read one exercise',mode:'manual',acknowledge:true});
 assert.equal((await f.day.briefing()).day.classes[0].title,'Mathematics');const sessions=f.day.focusSessions;let mono=1000;sessions.clock=()=>mono;const start=await sessions.change({requestId:randomUUID(),action:'start',taskId:id,revision:(await sessions.report({taskId:id})).revision,note:'',acknowledge:true});mono+=300000;f.clock.now=new Date(+f.clock.now+300000);await sessions.change({requestId:randomUUID(),action:'pause',id:start.session.id,revision:(await sessions.report({id:start.session.id})).revision,note:'Interrupted by class preparation',acknowledge:true});
 const changed=(await f.app.vault.tasks()).find(x=>x.id===id);await f.app.vault.scheduleTask({...changed,startTime:'14:00'});f.clock.now=new Date(2098,4,12,18);f.day.calendar={context:async()=>{throw Error('Calendar unavailable');},fresh:async()=>{throw Error('Calendar unavailable');}};await f.history.sync();const before=await f.snapshot(),r=await f.cleanup.review({...request(f),selected:[{id:f.first.id,revision:f.first.revision}]});await f.cleanup.accept(accept(r));assert.deepEqual(await f.snapshot(),before);assert.equal((await sessions.read()).sessions.find(x=>x.id===start.session.id).status,'paused');assert.equal((await f.app.vault.tasks()).find(x=>x.id===id).done,false);
 f.clock.now=new Date(2098,4,13,8);const reopened=await new ReminderCleanup({planner:f.day}).view(r.review.id);assert(reopened.receipt);assert.equal(reopened.review.date,date);assert.equal((await f.revisits.read()).entries.find(x=>x.id===f.second.id).status,'open');assert.deepEqual(await f.snapshot(),before);
});

test('cleanup history is read-only, paginated and keeps original dates across a representative week',async t=>{
 const f=await setup(t),reviews=[];for(let i=0;i<12;i++){f.clock.now=new Date(2098,4,12,8,i);reviews.push(await f.cleanup.review(request(f)));}
 const before=await f.snapshot(),stored=await f.revisits.read(),first=await f.cleanup.history();assert.equal(first.total,12);assert.equal(first.rows.length,10);assert.equal(first.rows[0].id,reviews.at(-1).review.id);assert(first.rows.every(r=>r.status==='pending'));assert.equal((await f.cleanup.history({offset:10})).rows.length,2);assert.equal((await f.cleanup.history({date:'2098-05-13'})).total,0);assert.deepEqual(await f.snapshot(),before);assert.deepEqual(await f.revisits.read(),stored);
 await f.cleanup.accept(accept(reviews[0]));const stable=await f.revisits.read();for(let day=13;day<=19;day++){f.clock.now=new Date(2098,4,day,8);const all=[...(await f.cleanup.history()).rows,...(await f.cleanup.history({offset:10})).rows];assert.equal(all.filter(r=>r.status==='recorded').length,1);assert.equal(all.filter(r=>r.status==='blocked').length,11);assert(all.every(r=>r.date===date));assert.equal((await f.cleanup.view(reviews[0].review.id)).receipt.id,reviews[0].review.id);assert.deepEqual(await f.revisits.read(),stable);}
 assert.deepEqual(await f.snapshot(),before);assert.equal(f.calls,0);
});
test('cleanup history retains missing receipt reviews and rejects damaged archives without inventing results',async t=>{
 const f=await setup(t),r=await f.cleanup.review(request(f));await f.cleanup.accept(accept(r));const path=f.app.store.file('reminder-cleanups',r.review.id),raw=await readFile(path,'utf8');await unlink(path);let h=await f.cleanup.history({date:'2098-05-13'});assert.equal(h.rows[0].status,'unavailable');assert.equal(h.rows[0].date,null);assert.match(h.rows[0].issues[0],/original review is missing/);await writeFile(path,'null');await assert.rejects(f.cleanup.history(),/cannot all be read/);assert.equal(await readFile(path,'utf8'),'null');await writeFile(path,raw);h=await f.cleanup.history();assert.equal(h.rows[0].status,'recorded');
 const state=await f.revisits.read();state.cleanups[0].reviewRevision='f'.repeat(64);await writeFile(f.revisits.path,JSON.stringify(state));h=await f.cleanup.history();assert.equal(h.rows[0].status,'unavailable');assert.match(h.rows[0].issues[0],/does not match/);
});
test('cleanup history validates filters and exposes its read-only route and recovery module',async t=>{
 const f=await setup(t);for(const input of [{offset:-1},{offset:1.5},{offset:100001},{date:''},{date:'2098-02-30'}])await assert.rejects(f.cleanup.history(input),e=>e.status===400);
 await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.app.server.address().port;const r=await fetch(base+'/api/reminder-cleanup/history');assert.equal(r.status,200);assert.equal((await r.json()).total,0);assert.equal((await fetch(base+'/api/reminder-cleanup/history?offset=bad')).status,400);assert.equal((await fetch(base+'/api/reminder-cleanup/history?date=')).status,400);assert.equal((await fetch(base+'/cleanup-recovery.js')).status,200);assert.equal((await fetch(base+'/api/reminder-cleanup/history',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
});
