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

async function followup(f,source,ids=f.ids.slice(0,2),target='2098-05-13',end='12:00'){
 const r=await workloadNextReport(f.day,{proposalId:source.id,date:target}),a=await assessWorkloadNext(f.day,{date:r.date,today:r.today,timezone:r.timezone,start:'09:00',end,gap:10,workloadFrom:{proposalId:r.source.proposalId,revision:r.source.revision},selected:r.rows.filter(r=>ids.includes(r.taskId)).map(r=>({taskId:r.taskId,contextRevision:r.contextRevision}))});
 return f.day.nextDayPreview({...a.days[0].preview,requestId:randomUUID()});
}
const read=(f,input={})=>workloadReflection(f.day,input);
test('evening and weekly periods group each original workload once and reads preserve all records',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),a=await followup(f,source,[f.ids[0]]);await f.day.decide(a.id,'accept');await followup(f,source,[f.ids[1]]);
 const before=await f.snapshot(),day=await read(f),week=await read(f,{period:'week'});assert.equal(day.total,1);assert.equal(week.total,1);assert.equal(day.rows[0].proposalId,source.id);assert.equal(day.rows[0].known,3);assert.equal(day.rows[0].counts.reserved,1);assert.equal(day.rows[0].unplaced,2);assert.equal(new Set(day.rows[0].tasks.map(t=>t.taskId)).size,3);assert.deepEqual(await f.snapshot(),before);assert.equal(f.calls,0);
});
test('actual carry-forward decisions stay distinct from proposals, omissions and ordinary scheduling',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input);await followup(f,source,[f.ids[0]]);await followup(f,source,[f.ids[0]],'2098-05-14');let task=(await f.app.vault.tasks()).find(t=>t.id===f.ids[2]);await f.app.vault.scheduleTask({...task,planDate:date});
 let evening=await f.day.evening(date),p=await f.day.eveningPreview({date,choices:[{task:evening.unfinished.find(t=>t.id===task.id),action:'move',date:'2098-05-13'}]});await f.day.decide(p.id,'accept');
 f.clock.now=new Date(2098,4,13,8);evening=await f.day.evening('2098-05-13');p=await f.day.eveningPreview({date:'2098-05-13',choices:[{task:evening.unfinished.find(t=>t.id===task.id),action:'move',date:'2098-05-14'}]});await f.day.decide(p.id,'accept');
 const r=await read(f,{date}),row=r.rows[0].tasks.find(t=>t.taskId===task.id);assert.equal(row.deferrals.total,2);assert.equal(row.deferrals.inPeriod,1);assert.equal(row.omittedIn.length,2);assert.equal(r.rows[0].tasks[0].deferrals.total,0);assert.equal(row.deferrals.recent[0].proposalId,p.id);
 const history=f.history.read.bind(f.history),h=await history(),event=h.events.find(e=>e.decision?.proposalId===p.id);f.history.read=async()=>({...h,events:[...h.events,{...event,id:randomUUID(),source:'recovered_save'},{...event,id:randomUUID(),source:'external_observation'},{...event,id:randomUUID(),recordedAt:'2099-01-01T00:00:00Z'}]});assert.equal((await read(f,{date})).rows[0].tasks.find(t=>t.taskId===task.id).deferrals.total,2);
});
test('later reservations, completion and missing tasks remain current without changing the reviewed period',async t=>{
 const f=await fixture(t);await f.day.nextDayPreview(f.input);let tasks=await f.app.vault.tasks(),task=tasks.find(t=>t.id===f.ids[0]);await f.app.vault.scheduleTask({...task,planDate:'2098-06-01',startTime:'11:00'});let n=await f.app.vault.read(tasks.find(t=>t.id===f.ids[1]).path);await f.app.vault.save(n.path,n.content.replace('- [ ]','- [x]'),n.revision);n=await f.app.vault.read(tasks.find(t=>t.id===f.ids[2]).path);await f.app.vault.trash(n.path,n.revision);
 f.clock.now=new Date(2098,4,15,10);const r=await read(f,{date});assert.equal(r.date,date);assert.equal(r.today,'2098-05-15');assert.equal(r.rows[0].counts.reserved,1);assert.equal(r.rows[0].counts.complete,1);assert.equal(r.rows[0].counts.unknown,1);assert.equal(r.rows[0].unplaced,0);assert.equal((await read(f,{date:'2098-05-15'})).total,0);assert.equal(r.rows[0].tasks[2].deferrals.total,null);
});
test('unavailable history and plan indexes report unknown coverage without inventing empty history',async t=>{
 const f=await fixture(t);await f.day.nextDayPreview(f.input);f.history.read=async()=>{throw Error('History unavailable');};let r=await read(f);assert.equal(r.sources.history,false);assert.equal(r.total,1);assert(r.rows[0].tasks.every(t=>t.deferrals.total===null));const list=f.app.store.list.bind(f.app.store);f.app.store.list=async k=>{if(k==='proposals')throw Error('Plan index unavailable');return list(k);};r=await read(f);assert.equal(r.total,null);assert.equal(r.sources.proposals,false);assert.equal(r.rows.length,0);assert(r.warnings.length>=2);
});
test('missing original sources retain known follow-up membership without asserting omissions',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),a=await followup(f,source,[f.ids[0]]);await f.day.decide(a.id,'accept');const get=f.app.store.get.bind(f.app.store),list=f.app.store.list.bind(f.app.store),all=await list('proposals');f.app.store.get=async(k,id)=>{if(id===source.id)throw Error('Missing original');return get(k,id);};f.app.store.list=async k=>k==='proposals'?all.filter(p=>p.id!==source.id):list(k);
 f.clock.now=new Date(2098,4,13,8);const r=await read(f);assert.equal(r.total,1);assert.equal(r.rows[0].known,1);assert.equal(r.rows[0].sources.original,false);assert.equal(r.rows[0].tasks[0].omittedIn,null);assert(r.rows[0].warnings.length);
});
test('partial and held follow-ups stay unplaced only where current notes support it; pending history is explicit',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),a=await followup(f,source),save=f.app.vault.save.bind(f.app.vault);let n=0;f.app.vault.save=async(...args)=>{if(++n===2)throw Error('Partial fixture');return save(...args);};await assert.rejects(f.day.decide(a.id,'accept'));f.app.vault.save=save;const history=f.history.read.bind(f.history),h=await history();f.history.read=async()=>({...h,pending:{decision:{proposalId:a.id},path:'fixture',afterTasks:[]}});
 const r=await read(f);assert.equal(r.rows[0].unplaced,2);assert.equal(r.rows[0].pending,true);assert.equal(r.rows[0].tasks.find(t=>t.taskId===f.ids[1]).omittedIn.length,0);assert(r.warnings.some(w=>w.includes('reconciliation')));
});
test('pagination keeps unrelated sources distinct even when they share tasks, and excludes future-created records',async t=>{
 const f=await fixture(t),source=await f.day.nextDayPreview(f.input),stored=await f.app.store.get('proposals',source.id);for(let i=0;i<6;i++)await f.app.store.put('proposals',{...stored,id:randomUUID(),created:i===5?'2099-01-01T00:00:00Z':stored.created});
 let r=await read(f);assert.equal(r.total,6);assert.equal(r.rows.length,5);assert(r.rows.every(g=>g.known===3));const next=await read(f,{offset:5});assert.equal(next.rows.length,1);assert.equal(new Set([...r.rows,...next.rows].map(g=>g.proposalId)).size,6);
});
test('damaged dates and legacy records stay labelled and cannot fabricate full shortlist coverage',async t=>{
 const f=await fixture(t),input={...f.input};delete input.workloadSource;const source=await f.day.nextDayPreview(input);await f.app.store.put('proposals',{...await f.app.store.get('proposals',source.id),id:randomUUID(),targetDate:'broken'});const r=await read(f);assert.equal(r.total,1);assert.equal(r.rows[0].legacy,true);assert.equal(r.rows[0].known,2);assert(r.warnings.some(w=>w.includes('dates')));
});
test('period validation, local day boundaries and escaped navigation work through the read-only API',async t=>{
 const f=await fixture(t);await f.day.nextDayPreview(f.input);for(const input of [{period:'month'},{date:'2098-02-30'},{date:'2098-05-13'},{offset:-1},{offset:1.5}])await assert.rejects(read(f,input));
 const r=await read(f),e=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),html=workloadReflectionHTML(r,null,e);assert(html.includes('&lt;img'));assert(!html.includes('<img'));assert(html.includes('Omission alone is not a deferral'));assert(html.includes('returnReview'));assert(!html.includes('data-workload-next-task'));
 await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+f.app.server.address().port;assert.equal((await fetch(url+'/workload-reflection.js')).status,200);assert.equal((await fetch(url+'/api/workload-reflection?period=no')).status,400);assert.equal((await(await fetch(url+'/api/workload-reflection?period=week&date='+date)).json()).total,1);assert.equal(f.calls,0);
});
