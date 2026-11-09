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

import {WorkloadRevisits} from '../src/workload-revisits.mjs';

async function seed(t){const f=await fixture(t),source=await f.day.nextDayPreview(f.input);return {...f,source,revisits:f.day.workloadRevisits,request:{requestId:randomUUID(),proposalId:source.id,review:{period:'day',date,offset:0},today:date,timezone:f.input.timezone}};}
test('saving a workload creates only an intention for the next local day and reads do not mutate planning',async t=>{
 const f=await seed(t),before=await f.snapshot(),entry=await f.revisits.save(f.request);assert.equal(entry.targetDate,'2098-05-13');assert.equal(entry.source.tasks.length,3);assert.equal(entry.review.date,date);assert.equal((await f.revisits.report({brief:true})).rows.length,0);assert.equal((await f.revisits.report({brief:true})).upcoming,1);assert.deepEqual(await f.snapshot(),before);assert.equal(f.calls,0);
 f.clock.now=new Date(2098,4,14,8);const report=await f.revisits.report({brief:true});assert.equal(report.rows[0].id,entry.id);assert.equal(report.rows[0].targetDate,'2098-05-13');assert.equal(report.rows[0].current.counts.ready,3);assert.deepEqual(await f.snapshot(),before);
});
test('duplicate saves and retries survive restart without reopening dismissed intentions',async t=>{
 const f=await seed(t),a=await f.revisits.save(f.request),again=new WorkloadRevisits({planner:f.day,data:f.app.store.root});assert.deepEqual(await again.save(f.request),a);assert.equal((await again.save({...f.request,requestId:randomUUID()})).id,a.id);assert.equal((await again.read()).entries.length,1);
 await again.dismiss({id:a.id,revision:a.revision});assert.equal((await again.save(f.request)).status,'dismissed');assert.equal((await again.save({...f.request,requestId:randomUUID()})).status,'dismissed');assert.equal((await again.report({brief:true})).total,0);assert.equal((await again.report({status:'dismissed'})).total,1);
});
test('evening and weekly origins remain distinct, canonical and linked to the original review',async t=>{
 const f=await seed(t),a=await f.revisits.save(f.request),week=(await workloadReflection(f.day,{period:'week'})).date,b=await f.revisits.save({...f.request,requestId:randomUUID(),review:{period:'week',date:week,offset:0}});assert.notEqual(a.id,b.id);assert.equal(b.review.date,week);await assert.rejects(f.revisits.save({...f.request,requestId:randomUUID(),review:{period:'day',date:'2098-05-11',offset:0}}),/no longer on/);await assert.rejects(f.revisits.save({...f.request,requestId:randomUUID(),review:{period:'week',date:'2098-05-13',offset:0}}));
});
test('current reservations, completion, changed sources and missing tasks are refreshed when a reminder returns',async t=>{
 const f=await seed(t);await f.revisits.save(f.request);let tasks=await f.app.vault.tasks();await f.app.vault.scheduleTask({...tasks.find(t=>t.id===f.ids[0]),planDate:'2098-06-01',startTime:'12:00'});const n=await f.app.vault.read(tasks.find(t=>t.id===f.ids[1]).path);await f.app.vault.save(n.path,n.content.replace('- [ ]','- [x]'),n.revision);const missing=await f.app.vault.read(tasks.find(t=>t.id===f.ids[2]).path);await f.app.vault.trash(missing.path,missing.revision);const original=await f.app.store.get('proposals',f.source.id);await f.app.store.put('proposals',{...original,title:'Edited source'});f.clock.now=new Date(2098,4,13,8);const r=(await f.revisits.report({brief:true})).rows[0];assert.equal(r.sourceChanged,true);assert.equal(r.current.counts.reserved,1);assert.equal(r.current.counts.complete,1);assert.equal(r.current.counts.unknown,1);assert.equal(r.source.tasks.length,3);assert.notEqual(r.source.title,'Edited source');
});
test('missing original and unavailable history preserve reminders with explicit incomplete status',async t=>{
 const f=await seed(t);await f.revisits.save(f.request);await unlink(f.app.store.file('proposals',f.source.id));f.history.read=async()=>{throw Error('History offline');};const r=(await f.revisits.report()).rows[0];assert.equal(r.current.sources.original,false);assert.equal(r.current.sources.history,false);assert.equal(r.sourceChanged,null);assert.equal(r.source.tasks.length,3);assert.equal(r.status,'open');assert(r.current.warnings.some(w=>w.includes('History offline')));await assert.rejects(f.revisits.save({...f.request,requestId:randomUUID(),review:{period:'week',date:(await workloadReflection(f.day,{period:'week'})).date,offset:0}}));
});
test('stale save dates, timezones, malformed requests and reused IDs cannot create or alter reminders',async t=>{
 const f=await seed(t);for(const change of [{today:'2098-05-11'},{timezone:'wrong'},{requestId:'bad'},{review:{period:'month',date,offset:0}},{review:{period:'day',date,offset:1.5}}])await assert.rejects(f.revisits.save({...f.request,...change}));assert.equal((await f.revisits.read()).entries.length,0);await f.revisits.save(f.request);await assert.rejects(f.revisits.save({...f.request,proposalId:randomUUID()}),/already used/);f.clock.now=new Date(2098,4,13,8);assert.equal((await f.revisits.save(f.request)).targetDate,'2098-05-13');await assert.rejects(f.revisits.save({...f.request,requestId:randomUUID()}),/day or timezone/);
});
test('dismissal is explicit, revision guarded and retryable without modifying tasks',async t=>{
 const f=await seed(t),a=await f.revisits.save(f.request),before=await f.snapshot();await assert.rejects(f.revisits.dismiss({id:a.id,revision:'stale'}),/changed/);assert.equal((await f.revisits.read()).entries[0].status,'open');const d=await f.revisits.dismiss({id:a.id,revision:a.revision});assert.deepEqual(await f.revisits.dismiss({id:a.id,revision:a.revision}),d);assert.deepEqual(await f.snapshot(),before);assert.equal((await f.revisits.report({status:'dismissed'})).rows[0].dismissedAt,d.dismissedAt);
});
test('missing or damaged intention storage fails closed instead of replacing saved reminders',async t=>{
 const f=await seed(t);await f.revisits.save(f.request);const original=await readFile(f.revisits.path,'utf8');await unlink(f.revisits.path);await assert.rejects(f.revisits.report(),/missing/);await assert.rejects(f.revisits.save({...f.request,requestId:randomUUID()}),/missing/);await writeFile(f.revisits.path,'broken');await assert.rejects(f.revisits.report(),/cannot be read/);await writeFile(f.revisits.path,original);assert.equal((await f.revisits.report()).total,1);const s=JSON.parse(original);s.entries.push({...s.entries[0],id:randomUUID()});await writeFile(f.revisits.path,JSON.stringify(s));await assert.rejects(f.revisits.report(),/cannot be read/);
});
test('uncertain marker write can be retried without duplicating the committed reminder',async t=>{
 const f=await seed(t);await writeFile(f.revisits.path,JSON.stringify({version:1,entries:[]}));await mkdir(f.revisits.marker);await assert.rejects(f.revisits.save(f.request),/could not be confirmed/);assert.equal((await f.revisits.read()).entries.length,1);await rm(f.revisits.marker,{recursive:true});const e=await f.revisits.save(f.request);assert.equal(e.id,f.request.requestId);assert.equal(JSON.parse(await readFile(f.revisits.marker,'utf8')).version,1);assert.equal((await f.revisits.report()).total,1);
});
test('pagination and briefing limits preserve original target days and dismissed history',async t=>{
 const f=await seed(t);for(let n=0;n<12;n++){f.clock.now=new Date(2098,4,12+n,8);await f.revisits.save({...f.request,requestId:randomUUID(),today:'2098-05-'+(12+n)});}f.clock.now=new Date(2098,5,1,8);const a=await f.revisits.report(),b=await f.revisits.report({offset:10}),brief=await f.revisits.report({brief:true});assert.equal(a.total,12);assert.equal(a.rows.length,10);assert.equal(b.rows.length,2);assert.equal(brief.rows.length,3);assert.equal(brief.total,12);assert.equal(a.rows[0].targetDate,'2098-05-13');assert.equal(new Set([...a.rows,...b.rows].map(e=>e.id)).size,12);for(const x of [{offset:-1},{status:'hidden'}])await assert.rejects(f.revisits.report(x));
});
test('authenticated API saves and dismisses intentions and briefing exposes them only when due',async t=>{
 const f=await seed(t);await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+f.app.server.address().port,boot=await(await fetch(url+'/api/bootstrap')).json(),post=(path,data,auth=true)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Aster-Token':boot.token}:{})},body:JSON.stringify(data)});assert.equal((await post('/api/workload-revisits/save',f.request,false)).status,403);const response=await post('/api/workload-revisits/save',f.request);assert.equal(response.status,200);const entry=await response.json();assert.equal((await(await fetch(url+'/api/briefing')).json()).start.revisits.upcoming,1);f.clock.now=new Date(2098,4,13,8);assert.equal((await(await fetch(url+'/api/briefing')).json()).start.revisits.rows[0].id,entry.id);assert.equal((await fetch(url+'/workload-revisits.js')).status,200);assert.equal((await fetch(url+'/api/workload-revisits?offset=-1')).status,400);assert.equal((await post('/api/workload-revisits/dismiss',{id:entry.id,revision:entry.revision})).status,200);assert.equal((await(await fetch(url+'/api/workload-revisits')).json()).total,0);
});
