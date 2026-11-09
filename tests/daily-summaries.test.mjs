import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Vault} from '../src/vault.mjs';
import {Store} from '../src/store.mjs';
import {TaskHistory} from '../src/task-history.mjs';
import {DailyFocus} from '../src/daily-focus.mjs';
import {DailyCheckins} from '../src/daily-checkins.mjs';
import {DailySummaries} from '../src/daily-summaries.mjs';
import {checkinReview} from '../src/checkin-review.mjs';
import {WeeklyReview} from '../src/weekly-review.mjs';
import {DayPlanning} from '../src/day-planning.mjs';
import {taskLine} from '../src/task-meta.mjs';
import {TIMETABLE_PATH,emptyTimetable,timetableMarkdown} from '../mobile/web/timetable.js';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'aurora-summary-'));t.after(()=>rm(dir,{recursive:true,force:true}));const vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data')),clock={now:new Date(2026,9,12,8)},links=[];await vault.init();await store.init();const history=new TaskHistory({vault,data:store.root,now:()=>clock.now.toISOString()});await history.init();const opts={vault,store,taskWorkflows:{summary:async()=>links},now:()=>clock.now},day=new DayPlanning(opts),focus=new DailyFocus({...opts,history,data:store.root});day.dailyFocus=focus;const checkins=new DailyCheckins({planner:day,data:store.root});day.checkins=checkins;day.summaries=new DailySummaries({planner:day});return {vault,store,clock,links,history,day,focus,checkins,opts};}
async function input(f,extra={}){const r=await f.day.candidates();return {requestId:randomUUID(),date:r.date,timezone:r.timezone,kind:'interruption',note:'Class ran late. Work can resume after lunch.',start:'13:00',end:'17:00',gap:10,selected:r.tasks.filter(t=>!t.locked).map(t=>({taskId:t.id,contextRevision:t.contextRevision})),...extra};}
async function preview(f,entry,extra={}){return f.day.preview({requestId:randomUUID(),date:entry.date,timezone:entry.timezone,checkin:{id:entry.id,revision:entry.revision},selected:(await f.day.candidates()).tasks.filter(t=>!t.locked),start:entry.start,end:entry.end,gap:entry.gap,...extra});}
const meta={planDate:'2026-10-12',startTime:'07:00',duration:30,due:'2026-10-15',remindAt:'2026-10-14T04:00:00Z'};
const report=f=>f.day.summaries.report('2026-10-12');
async function draft(f,body){const r=await report(f);return {requestId:randomUUID(),date:r.date,sourceRevision:r.sourceRevision,targetRevision:r.target?.revision||null,body:body||r.suggested};}
test('review and summary reads leave notes, history, focus and check-ins untouched',async t=>{
 const f=await fixture(t);await f.vault.addTask('Work',meta);const notes=await f.vault.list(),history=await f.history.read();const r=await report(f);
 assert.equal(r.target,null);assert.match(r.suggested,/Current outcomes/);assert.equal((await f.day.evening()).checkins.entries.length,0);assert.deepEqual(await f.vault.list(),notes);assert.deepEqual(await f.history.read(),history);assert.deepEqual(await f.store.list('daily-summaries'),[]);await assert.rejects(readFile(f.checkins.path),{code:'ENOENT'});await assert.rejects(readFile(f.focus.path),{code:'ENOENT'});
});
test('check-in review separates original intentions, unsaved previews, recorded adjustments and current completion',async t=>{
 const f=await fixture(t);await f.vault.addTask('Work',{duration:25});const day=await f.day.nextDay(meta.planDate),plan=await f.day.nextDayPreview({requestId:randomUUID(),date:day.date,today:day.today,timezone:day.timezone,selected:day.rows.map(r=>({taskId:r.taskId,contextRevision:r.contextRevision})),start:'09:00',end:'12:00'});await f.day.decide(plan.id,'accept');
 const task=(await f.vault.tasks())[0];await f.vault.scheduleTask({...task,duration:35});const e=await f.checkins.create(await input(f)),p=await preview(f,e);
 let r=await checkinReview(f.day,meta.planDate);assert.equal(r.entries[0].rows[0].original.duration,25);assert.equal(r.entries[0].rows[0].intention.duration,35);assert.equal(r.entries[0].adjustments[0].recorded.length,0);assert.equal(r.entries[0].adjustments[0].unrecorded,1);
 await f.day.decide(p.id,'accept');const current=(await f.vault.tasks())[0];await f.vault.toggleTask(current.path,current.line,current.revision,true);r=await checkinReview(f.day,meta.planDate);assert.equal(r.entries[0].adjustments[0].recorded.length,1);assert.equal(r.entries[0].adjustments[0].unrecorded,0);assert.equal(r.entries[0].rows[0].current.done,true);assert.equal(r.entries[0].status,'open');assert.equal(r.entries[0].adjustments[0].recorded[0].after.done,false);
 const week=new WeeklyReview({vault:f.vault,history:f.history,taskWorkflows:f.opts.taskWorkflows,now:f.opts.now});week.dayPlanning=f.day;assert.deepEqual((await week.report()).checkins.entries,r.entries);assert.equal((await f.day.evening()).checkins.entries[0].id,e.id);
});
test('partial adjustments count only committed note receipts and recovered saves keep their provenance',async t=>{
 const f=await fixture(t);await f.vault.addTask('One',meta);await f.vault.save('20 Projects/Second.md','- [ ] '+taskLine('Two',meta),null);const e=await f.checkins.create(await input(f)),p=await preview(f,e),save=f.vault.save.bind(f.vault);let calls=0;f.vault.save=async(...a)=>{if(++calls===2)throw Error('disk');return save(...a);};await assert.rejects(f.day.decide(p.id,'accept'));f.vault.save=save;let a=(await checkinReview(f.day,meta.planDate)).entries[0].adjustments[0];assert.equal(a.recorded.length,1);assert.equal(a.unrecorded,1);
 const h=await f.history.read(),event=h.events.find(r=>r.decision?.proposalId===p.id);event.source='recovered_save';await writeFile(f.history.path,JSON.stringify(h));a=(await checkinReview(f.day,meta.planDate)).entries[0].adjustments[0];assert.equal(a.recorded[0].source,'recovered_save');assert.equal(a.status,'pending');
});
test('missing and duplicate selected task identities never imply completion',async t=>{
 const f=await fixture(t);await f.vault.addTask('Work',meta);await f.checkins.create(await input(f));const task=(await f.vault.tasks())[0];await f.vault.save('20 Projects/Duplicate.md','- [ ] '+taskLine('Copy',meta,task.id),null);let r=await report(f);assert.match(r.sources.tasks[0].issue,/Duplicate/);assert.equal(r.sources.tasks[0].current,null);const n=await f.vault.read(task.path);await f.vault.save(task.path,'No tasks',n.revision);const copy=await f.vault.read('20 Projects/Duplicate.md');await f.vault.trash(copy.path,copy.revision);r=await report(f);assert.match(r.sources.tasks[0].issue,/completion is unknown/);assert.equal(r.sources.checkins.entries[0].rows[0].current,null);
});
test('summary preview is durable and explicit saving writes one journal without changing task or memory facts',async t=>{
 const f=await fixture(t);await f.vault.addTask('Work',meta);await f.checkins.create(await input(f));const tasks=await f.vault.tasks(),h=await f.history.read(),c=await f.checkins.read(),d=await draft(f,'My reflection\n\n- [ ] This is quoted journal content, not a planner task.'),p=await f.day.summaries.preview(d);
 assert.equal((await report(f)).target,null);assert.equal(p.intent,undefined);assert.equal(p.requestHash,undefined);assert.equal((await f.day.summaries.preview(d)).id,p.id);await assert.rejects(f.day.summaries.preview({...d,body:'Different'}),/already used/);
 await Promise.all([f.day.summaries.decide({id:p.id,action:'save'}),f.day.summaries.decide({id:p.id,action:'save'})]);const r=await report(f),n=await f.vault.read(p.path);assert.equal(n.kind,'daily-summary');assert.equal(n.status,'journal');assert.equal(r.target.body.trim(),d.body);assert.deepEqual(await f.vault.tasks(),tasks);assert.deepEqual(await f.history.read(),h);assert.deepEqual(await f.checkins.read(),c);assert.equal((await f.vault.list()).filter(n=>n.kind==='daily-summary').length,1);
});
test('changed task, check-in status, execution and day block stale summary saves',async t=>{
 for(const change of ['task','checkin','execution','day']){const f=await fixture(t);await f.vault.addTask('Work',meta);const e=await f.checkins.create(await input(f)),p=await f.day.summaries.preview(await draft(f));
  if(change==='task')await f.vault.scheduleTask({...((await f.vault.tasks())[0]),duration:50});if(change==='checkin')await f.checkins.decide({requestId:randomUUID(),id:e.id,revision:e.revision,status:'reviewed'});if(change==='execution')f.links.push({id:randomUUID(),taskId:e.selected[0].taskId,executionRevision:'changed',detail:'Question needs review'});if(change==='day')f.clock.now=new Date(2026,9,13,8);
  await assert.rejects(f.day.summaries.decide({id:p.id,action:'save'}),/sources or the saved note changed/);assert.equal((await report(f)).target,null);
 }
});
test('sources are checked again at the atomic note replacement boundary',async t=>{
 const f=await fixture(t);await f.vault.addTask('Work',meta);const p=await f.day.summaries.preview(await draft(f)),save=f.vault.save.bind(f.vault);f.vault.save=async(...args)=>{const task=(await f.vault.tasks())[0],n=await f.vault.read(task.path);await save(n.path,n.content.replace('Work','Changed work'),n.revision);return save(...args);};await assert.rejects(f.day.summaries.decide({id:p.id,action:'save'}),/sources or the saved note changed/);assert.equal((await report(f)).target,null);
});
test('lost note save and receipt replies recover after restart and midnight without another write',async t=>{
 for(const failAt of ['note','receipt']){const f=await fixture(t),d=await draft(f),p=await f.day.summaries.preview(d),save=f.vault.save.bind(f.vault),put=f.store.put.bind(f.store);let fail=true;
  if(failAt==='note')f.vault.save=async(...a)=>{const n=await save(...a);if(fail){fail=false;throw Error('lost reply');}return n;};else f.store.put=async(k,r)=>{if(k==='daily-summaries'&&r.status==='saved'&&fail){fail=false;throw Error('lost receipt');}return put(k,r);};
  await assert.rejects(f.day.summaries.decide({id:p.id,action:'save'}),/may already be saved/);f.store.put=put;f.vault.save=async()=>{throw Error('Must not rewrite');};f.clock.now=new Date(2026,9,13,8);const restarted=new DailySummaries({planner:f.day});assert.equal((await restarted.preview(d)).id,p.id);assert.equal((await restarted.decide({id:p.id,action:'save'})).status,'saved');assert.equal((await restarted.decide({id:p.id,action:'dismiss'})).status,'saved');
 }
});
test('a lost receipt followed by editing or deleting the saved summary never restores old text',async t=>{
 for(const deleted of [false,true]){const f=await fixture(t),p=await f.day.summaries.preview(await draft(f)),put=f.store.put.bind(f.store);f.store.put=async(k,r)=>{if(k==='daily-summaries'&&r.status==='saved')throw Error('lost receipt');return put(k,r);};await assert.rejects(f.day.summaries.decide({id:p.id,action:'save'}));f.store.put=put;const n=await f.vault.read(p.path);if(deleted)await f.vault.trash(p.path,n.revision);else await f.vault.save(p.path,n.content+'\nLater personal edit',n.revision);const before=await f.vault.list();assert.equal((await f.day.summaries.decide({id:p.id,action:'save'})).status,'saved');assert.deepEqual(await f.vault.list(),before);}
});
test('uncertain writes without surviving note/history evidence require a fresh explicit review',async t=>{
 for(const committed of [true,false]){const f=await fixture(t),p=await f.day.summaries.preview(await draft(f)),save=f.vault.save.bind(f.vault);f.vault.save=async(...args)=>{if(committed)await save(...args);throw Error('interrupted');};await assert.rejects(f.day.summaries.decide({id:p.id,action:'save'}),/may already be saved/);f.vault.save=save;if(committed)await rm(await f.vault.safe(p.path));await assert.rejects(f.day.summaries.decide({id:p.id,action:'save'}),/cannot be confirmed from the note/);assert.equal((await report(f)).target,null);assert.equal((await f.day.summaries.decide({id:p.id,action:'dismiss'})).status,'dismissed');const fresh=await f.day.summaries.preview(await draft(f));assert.equal((await f.day.summaries.decide({id:fresh.id,action:'save'})).status,'saved');}
});
test('changed and unrelated target notes are protected; a new reviewed version keeps note history',async t=>{
 const f=await fixture(t),d=await draft(f),p=await f.day.summaries.preview(d);await f.day.summaries.decide({id:p.id,action:'save'});const second=await f.day.summaries.preview(await draft(f,'Second version')),n=await f.vault.read(p.path);await f.vault.save(p.path,n.content+'\nExternal edit',n.revision);await assert.rejects(f.day.summaries.decide({id:second.id,action:'save'}),/sources or the saved note changed/);await f.day.summaries.decide({id:second.id,action:'dismiss'});await assert.rejects(f.day.summaries.decide({id:second.id,action:'save'}),/dismissed/);const third=await f.day.summaries.preview(await draft(f,'Merged reflection'));await f.day.summaries.decide({id:third.id,action:'save'});assert.match((await f.vault.read(p.path)).content,/Merged reflection/);assert.equal((await f.vault.history(p.path)).length,2);
 const other=await fixture(t),r=await report(other);await other.vault.save(r.path,'Personal unrelated note',null);await assert.rejects(other.day.summaries.preview(await draft(other)),/Another note occupies/);
});
test('invalid input and damaged summary/check-in records fail visibly without publishing',async t=>{
 const f=await fixture(t),d=await draft(f);for(const bad of [{date:'not-a-date'},{date:'2026-10-13'},{requestId:'../'},{body:''},{body:'x'.repeat(120001)},{targetRevision:undefined}])await assert.rejects(f.day.summaries.preview({...d,...bad}));const p=await f.day.summaries.preview(d),r=await f.store.get('daily-summaries',p.id);r.path='10 Profile/About me.md';await f.store.put('daily-summaries',r);await assert.rejects(f.day.summaries.decide({id:p.id,action:'save'}),/damaged/);await writeFile(f.checkins.path,'bad');assert.match((await f.day.evening()).checkinsError,/cannot be read/);await assert.rejects(report(f),/cannot be read/);
});
test('daily summary API authenticates writes, serves both UI modules and redacts write internals',async t=>{
 const {createApp}=await import('../src/server.mjs');const f=await fixture(t),app=await createApp({vault:f.vault.root,data:f.store.root,projects:[],ollamaClient:{status:async()=>({online:false,models:[]})}});app.dayPlanning.now=f.opts.now;await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});const base='http://127.0.0.1:'+app.server.address().port,boot=await(await fetch(base+'/api/bootstrap')).json(),post=(path,data,token)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-Aster-Token':token}:{})},body:JSON.stringify(data)});
 for(const path of ['/api/daily-summary/preview','/api/daily-summary/decide'])assert.equal((await post(path,{})).status,403);for(const path of ['/daily-summary.js','/checkin-review.js'])assert.equal((await fetch(base+path)).status,200);
 const c=await(await fetch(base+'/api/daily-summary?date=2026-10-12')).json(),r=await post('/api/daily-summary/preview',{requestId:randomUUID(),date:c.date,sourceRevision:c.sourceRevision,targetRevision:null,body:c.suggested},boot.token);assert.equal(r.status,200);const p=await r.json();assert.equal(p.sourceRevision,undefined);assert.equal(p.requestHash,undefined);assert.equal(p.intent,undefined);const res=await post('/api/daily-summary/decide',{id:p.id,action:'save'},boot.token);assert.equal(res.status,200);assert.equal((await res.json()).status,'saved');assert.equal((await(await fetch(base+'/api/proposals')).json()).some(r=>r.id===p.id),false);
});
