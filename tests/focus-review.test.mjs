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
import {DayPlanning} from '../src/day-planning.mjs';
import {WeeklyReview} from '../src/weekly-review.mjs';
import {taskLine} from '../src/task-meta.mjs';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'aurora-focus-review-'));t.after(()=>rm(dir,{force:true,recursive:true}));const vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data')),clock={now:new Date(2026,9,12,12)},links=[];await vault.init();await store.init();const history=new TaskHistory({vault,data:store.root,now:()=>clock.now.toISOString()});await history.init();const taskWorkflows={summary:async()=>links};const opts={vault,history,taskWorkflows,data:store.root,now:()=>clock.now},focus=new DailyFocus(opts),day=new DayPlanning({vault,store,taskWorkflows,now:opts.now}),weekly=new WeeklyReview({vault,history,taskWorkflows,now:opts.now});day.dailyFocus=focus;day.weeklyReview=weekly;return {vault,store,clock,links,history,opts,focus,day,weekly};}
const date='2026-10-12';
async function choose(f,id,action='focus'){const r=await f.focus.report(),row=r.rows.find(r=>r.taskId===id);return f.focus.decide({requestId:randomUUID(),date:r.date,timezone:r.timezone,revision:r.revision,taskId:id,contextRevision:row.contextRevision,action});}
async function seed(f,text='Read a chapter'){await f.vault.addTask(text,{due:date,duration:30});const task=(await f.vault.tasks()).find(t=>t.text===text);await choose(f,task.id);return task;}
async function request(f,id,action='reviewed',until=null){const r=await f.focus.review(date),row=r.rows.find(r=>!id||r.taskId===id);return {requestId:randomUUID(),date:r.date,today:r.today,timezone:r.timezone,revision:r.revision,taskId:row.taskId,contextRevision:row.contextRevision,action,until};}
async function preview(f){const r=await f.day.evening(date);return f.day.eveningPreview({date,choices:r.unfinished.map(task=>({task,action:'move',date:'2026-10-13'}))});}

test('review GETs are read only; unscheduled intentions and current attempts remain distinct',async t=>{
 const f=await fixture(t);await f.focus.review();await assert.rejects(readFile(f.focus.path),{code:'ENOENT'});
 const task=await seed(f),intent=(await f.focus.read()).days;f.links.push({id:'link',taskId:task.id,executionRevision:'1',status:'completed',results:{question:'Review the result'}});
 await f.vault.scheduleTask({...task,planDate:'2026-10-15'});const notes=await f.vault.list(),r=await f.focus.review(date);
 assert.equal(r.rows[0].intention.task.planDate,null);assert.equal(r.rows[0].task.planDate,'2026-10-15');assert.equal(r.rows[0].task.done,false);assert.equal(r.rows[0].execution[0].status,'completed');assert.equal(r.rows[0].changed,true);
 assert.deepEqual((await f.focus.read()).days,intent);assert.deepEqual(await f.vault.list(),notes);assert.equal((await f.day.evening()).unfinished.length,0);
});
test('missed focus reviews survive days away and acknowledgments preserve original choices, notes and history',async t=>{
 const f=await fixture(t);await seed(f);f.clock.now=new Date(2026,9,19,8);const notes=await f.vault.list(),history=await f.history.read(),days=(await f.focus.read()).days;
 assert.deepEqual((await f.day.briefing()).focus.reviewDays,[{date,total:1,pending:1}]);const r=await f.focus.reviewDecision(await request(f));assert.equal(r.pending,0);
 assert.equal((await new DailyFocus(f.opts).review(date)).pending,0);assert.deepEqual((await f.focus.read()).days,days);assert.deepEqual(await f.vault.list(),notes);assert.deepEqual(await f.history.read(),history);
 const task=(await f.vault.tasks())[0];await f.vault.scheduleTask({...task,duration:35});assert.equal((await f.focus.review(date)).pending,0,'later edits do not reopen a reviewed historical intention');
});
test('review reminder catches up after restart without choosing focus and a later daily decision supersedes it',async t=>{
 const f=await fixture(t),task=await seed(f);await f.focus.reviewDecision(await request(f,task.id,'reconsider','2026-10-13'));
 f.clock.now=new Date(2026,9,17,8);let r=await new DailyFocus(f.opts).report();assert.equal(r.counts.focused,0);assert.equal(r.rows[0].reconsider.until,'2026-10-13');assert.equal(r.rows[0].reconsider.reviewDate,date);assert.equal(r.rows[0].choice,null);
 await choose(f,task.id,'off');f.clock.now=new Date(2026,9,18,8);assert.equal((await f.focus.report()).rows[0].reconsider,null);assert.equal((await f.vault.tasks())[0].planDate,null);
});
test('reviewed replaces its reminder; another focus choice requires a fresh review',async t=>{
 const f=await fixture(t),task=await seed(f);await f.focus.reviewDecision(await request(f,task.id,'reconsider','2026-10-13'));await f.focus.reviewDecision(await request(f));
 f.clock.now=new Date(2026,9,13,8);assert.equal((await f.focus.report()).rows[0].reconsider,null);
 f.clock.now=new Date(2026,9,12,13);await choose(f,task.id);assert.equal((await f.focus.review()).pending,1);
});
test('duplicate, missing and complete tasks can be acknowledged but cannot get review reminders',async t=>{
 const f=await fixture(t),task=await seed(f);await f.vault.save('40 Tasks/Duplicate.md','- [ ] '+taskLine(task.text,task,task.id),null);
 assert.match((await f.focus.review()).rows[0].identityIssue,/Duplicate/);await assert.rejects(f.focus.reviewDecision(await request(f,task.id,'reconsider','2026-10-13')),/unique/);assert.equal((await f.day.evening()).unfinished.length,0);
 let n=await f.vault.read('40 Tasks/Duplicate.md');await f.vault.trash(n.path,n.revision);let current=(await f.vault.tasks())[0];await f.vault.toggleTask(current.path,current.line,current.revision,true);
 await assert.rejects(f.focus.reviewDecision(await request(f,task.id,'reconsider','2026-10-13')),/unfinished/);assert.equal((await f.focus.reviewDecision(await request(f))).pending,0);
 n=await f.vault.read(task.path);await f.vault.save(n.path,'# Removed task\n',n.revision);assert.equal((await f.focus.review()).rows[0].task,null);await f.focus.reviewDecision(await request(f));assert.equal((await f.vault.tasks()).length,0);
});
test('stale task, attempt, choice, date and timezone cannot be acknowledged',async t=>{
 const f=await fixture(t),task=await seed(f);let req=await request(f);await f.vault.scheduleTask({...task,duration:40});await assert.rejects(f.focus.reviewDecision(req),/changed/);
 req=await request(f);f.links.push({id:'x',taskId:task.id,executionRevision:'new'});await assert.rejects(f.focus.reviewDecision(req),/changed/);
 req=await request(f);await choose(f,task.id,'off');await assert.rejects(f.focus.reviewDecision(req),/changed/);await choose(f,task.id);
 req=await request(f);f.clock.now=new Date(2026,9,13,8);await assert.rejects(f.focus.reviewDecision(req),/changed/);
 req=await request(f);f.focus.timezone=()=>req.timezone==='UTC'?'Asia/Tokyo':'UTC';await assert.rejects(f.focus.reviewDecision(req),/changed/);
});
test('external task and attempt changes at atomic replacement reject review receipts',async t=>{
 const f=await fixture(t),task=await seed(f),tasks=f.vault.tasks.bind(f.vault);let calls=0;const req=await request(f);
 f.vault.tasks=async()=>{if(++calls===2){const n=await f.vault.read(task.path);await writeFile(join(f.vault.root,n.path),n.content.replace('Read a chapter','Changed outside Aurora'));}return tasks();};
 await assert.rejects(f.focus.reviewDecision(req),/before saving/);f.vault.tasks=tasks;assert.equal((await f.focus.review()).pending,1);
 calls=0;const fresh=await request(f);f.vault.tasks=async()=>{if(++calls===2)f.links.push({id:'changed',taskId:task.id,executionRevision:'new'});return tasks();};await assert.rejects(f.focus.reviewDecision(fresh),/before saving/);
});
test('lost reply retries are idempotent after restart and cannot overwrite a newer decision',async t=>{
 const f=await fixture(t);await seed(f);const req=await request(f);await f.focus.reviewDecision(req);await f.focus.reviewDecision(await request(f,null,'reconsider','2026-10-13'));
 const r=await new DailyFocus(f.opts).reviewDecision(req);assert.equal(r.alreadySaved,true);assert.equal(r.rows[0].decision.action,'reconsider');await assert.rejects(f.focus.reviewDecision({...req,action:'reconsider',until:'2026-10-14'}),/already used/);
});
test('a failure after the review file commits reports uncertainty and the saved request recovers',async t=>{
 const f=await fixture(t);await seed(f);const input=await request(f),tasks=f.vault.tasks.bind(f.vault);let calls=0;
 f.vault.tasks=async()=>{if(++calls===3)throw Error('Read failed after save');return tasks();};
 await assert.rejects(f.focus.reviewDecision(input),e=>e.status===503&&/may already be saved/.test(e.message));f.vault.tasks=tasks;
 const state=await f.focus.read(),recovered=await new DailyFocus(f.opts).reviewDecision(input);assert.equal(recovered.alreadySaved,true);assert.equal(recovered.pending,0);assert.deepEqual(await f.focus.read(),state);
});
test('concurrent decisions serialize; malformed or missing saved review data fails closed',async t=>{
 const f=await fixture(t);await seed(f);const a=await request(f),b=await request(f,null,'reconsider','2026-10-13');assert.deepEqual((await Promise.allSettled([f.focus.reviewDecision(a),f.focus.reviewDecision(b)])).map(r=>r.status),['fulfilled','rejected']);
 const s=await f.focus.read();s.reviews[Object.keys(s.reviews)[0]].decisions[a.taskId].until='bad';await writeFile(f.focus.path,JSON.stringify(s));await assert.rejects(f.focus.review(),/cannot be read/);await rm(f.focus.path);await assert.rejects(f.focus.review(),/missing/);
});
test('review validates dates and actions and never accepts an unrelated task',async t=>{
 const f=await fixture(t);await seed(f);for(const extra of [{action:'complete'},{taskId:randomUUID()},{requestId:'bad'},{action:'reconsider',until:date},{action:'reconsider',until:'bad'},{date:'2026-10-13'}])await assert.rejects(f.focus.reviewDecision({...await request(f),...extra}));
});
test('unscheduled focus tasks use the existing evening scheduling path with stable IDs and no automatic review or execution',async t=>{
 const f=await fixture(t),task=await seed(f);const p=await preview(f);assert.equal(p.changes.length,1);assert.equal(p.changes[0].before.planDate,null);assert.equal((await f.vault.tasks())[0].planDate,null);
 await f.day.decide(p.id,'accept');const after=(await f.vault.tasks())[0];assert.equal(after.id,task.id);assert.equal(after.planDate,'2026-10-13');assert.equal(after.due,task.due);assert.equal(after.done,false);assert.equal((await f.focus.review()).pending,1);assert.equal((await f.focus.review()).rows[0].intention.task.planDate,null);
});
test('unscheduled carry-forward respects calendar capacity and rejects changed intentions before saving',async t=>{
 const f=await fixture(t),task=await seed(f),context={enabled:true,complete:true,revision:'a',from:'2026-10-01',to:'2026-11-01',events:[{id:'busy',summary:'Busy',start:{dateTime:new Date(2026,9,13,9).toISOString()},end:{dateTime:new Date(2026,9,13,10).toISOString()}}]};f.day.calendar={fresh:async()=>context,context:async()=>context};
 const r=await f.day.evening(),p=await f.day.eveningPreview({date,choices:[{task:r.unfinished[0],action:'move',date:'2026-10-13'}],reserveTimes:true,start:'09:00',end:'11:00'});assert.equal(p.changes[0].after.startTime,'10:10');
 await choose(f,task.id,'off');await assert.rejects(f.day.decide(p.id,'accept'),/intention changed/);assert.equal((await f.vault.tasks())[0].planDate,null);
});
test('changed focus intention at a note commit is rejected; recovered saved notes reconcile after midnight',async t=>{
 const f=await fixture(t),task=await seed(f),p=await preview(f),save=f.vault.save.bind(f.vault);f.vault.save=async(...args)=>{await choose(f,task.id,'off');return save(...args);};await assert.rejects(f.day.decide(p.id,'accept'),/intention changed/);f.vault.save=save;await choose(f,task.id);
 const next=await preview(f),put=f.store.put.bind(f.store);let fail=true;f.store.put=async(k,r)=>{if(r.id===next.id&&r.saved?.length&&fail){fail=false;throw Error('Interrupted receipt');}return put(k,r);};await assert.rejects(f.day.decide(next.id,'accept'),/Interrupted/);f.store.put=put;
 f.clock.now=new Date(2026,9,13,8);const notes=await f.vault.list(),history=await f.history.read();assert.equal((await f.day.decide(next.id,'accept')).status,'accepted');assert.deepEqual(await f.vault.list(),notes);assert.deepEqual(await f.history.read(),history);
});
test('review API protects writes, serves its UI, and returns the same missed days in briefing',async t=>{
 const f=await fixture(t),{createApp}=await import('../src/server.mjs'),app=await createApp({vault:f.vault.root,data:f.store.root,projects:[],ollamaClient:{status:async()=>({online:false,models:[]})}});app.dayPlanning.now=()=>f.clock.now;const af={...f,focus:app.dayPlanning.dailyFocus};await seed(af);
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});const url='http://127.0.0.1:'+app.server.address().port,boot=await(await fetch(url+'/api/bootstrap')).json(),input=await request(af),post=token=>fetch(url+'/api/daily-focus/review/decide',{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-Aster-Token':token}:{})},body:JSON.stringify(input)});
 assert.equal((await post()).status,403);assert.equal((await post(boot.token)).status,200);assert.equal((await fetch(url+'/focus-review.js')).status,200);assert.equal((await(await fetch(url+'/api/daily-focus/review?date='+date)).json()).pending,0);assert.equal((await(await fetch(url+'/api/briefing')).json()).focus.reviewDays[0].pending,0);
});
