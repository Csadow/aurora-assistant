import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {FirstSteps} from '../src/first-steps.mjs';
import {sha} from '../src/vault.mjs';
import {taskLine} from '../src/task-meta.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-first-step-'));let calls=0;
 const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),backups:join(dir,'backups'),projects:[],ollamaClient:{model:'fixture',status:async()=>({online:false}),chat:async()=>{calls++;throw Error('No model call expected');}},workflowOptions:{pollMs:60000}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await app.workflows.close();app.calendar.close();app.recurring.stop();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 const clock={now:new Date(2026,9,26,8)};app.dayPlanning.now=()=>clock.now;
 await app.vault.save('20 Projects/First step.md','# First step project\n\nOpen the lecture exercise. <img src=x>',null);
 await app.vault.addTask('Study discrete mathematics',{planDate:'2026-10-26',duration:30,project:'20 Projects/First step.md'});
 const task=(await app.vault.tasks()).find(t=>t.text==='Study discrete mathematics'),focus=app.dayPlanning.dailyFocus,steps=app.dayPlanning.firstSteps;
 const choose=async(action='focus')=>{const r=await focus.report(),row=r.rows.find(r=>r.taskId===task.id);return focus.decide({requestId:randomUUID(),taskId:task.id,date:r.date,timezone:r.timezone,revision:r.revision,contextRevision:row.contextRevision,action});};
 await choose();return {app,clock,task,focus,steps,choose,get calls(){return calls;}};
}
const input=async(f,extra={})=>({requestId:randomUUID(),taskId:f.task.id,revision:(await f.steps.report(f.task.id)).revision,text:'Open my notes and solve question one.',mode:'manual',acknowledge:true,...extra});
const execution=async f=>({requestId:randomUUID(),taskId:f.task.id,revision:(await f.steps.report(f.task.id)).revision,acknowledge:true});

const outcomeInput=async(f,extra={})=>{const r=await f.steps.outcomes.report(f.task.id,extra.cardSequence);return {requestId:randomUUID(),taskId:f.task.id,cardSequence:r.card.sequence,revision:r.revision,kind:'blocked',note:'Need clarification on the first exercise.',acknowledge:true,...extra};};
const prepared=async t=>{const f=await fixture(t);await f.steps.save(await input(f));return f;};
test('outcome reads and saves retain original steps and never change task, focus, execution or calendar state',async t=>{
 const f=await prepared(t),card=(await f.steps.report(f.task.id)).card,before=await readFile(f.steps.path,'utf8'),notes=await f.app.vault.list(),focus=await f.focus.read(),calendar=JSON.stringify(f.app.calendar.state),history=await f.app.vault.taskHistory.read();
 await f.steps.outcomes.report(f.task.id);await f.steps.outcomes.review();assert.equal(await readFile(f.steps.path,'utf8'),before);
 for(const kind of ['blocked','continue','done'])await f.steps.outcomes.record(await outcomeInput(f,{kind}));
 const r=await f.steps.outcomes.report(f.task.id);assert.equal(r.outcomes.length,3);assert(r.outcomes[0].superseded);assert.equal(r.outcomes[2].unresolved,false);assert.deepEqual(r.card,card);assert.deepEqual(await f.app.vault.list(),notes);assert.deepEqual(await f.focus.read(),focus);assert.deepEqual(await f.app.vault.taskHistory.read(),history);assert.equal(JSON.stringify(f.app.calendar.state),calendar);assert.deepEqual(await f.app.store.list('workflows'),[]);assert.deepEqual(await f.app.store.list('task-workflows'),[]);assert.equal(f.calls,0);
});
test('outcomes require explicit review, valid kind, note and an actual retained step version',async t=>{
 const f=await prepared(t),q=await outcomeInput(f);for(const change of [{kind:'verified'},{note:''},{note:'x'.repeat(3001)},{acknowledge:false},{cardSequence:0},{cardSequence:99},{taskId:randomUUID()},{requestId:'bad'}])await assert.rejects(f.steps.outcomes.record({...q,...change}));assert.equal((await f.steps.outcomes.review()).entries.length,0);
});
test('current task, project, focus, attempt, day and timezone changes reject stale outcome reviews',async t=>{
 for(const change of ['task','project','focus','attempt','day','timezone']){
  const f=await prepared(t),q=await outcomeInput(f);
  if(change==='task')await f.app.vault.scheduleTask({...f.task,duration:45});
  if(change==='project'){const n=await f.app.vault.read(f.task.project);await f.app.vault.save(n.path,n.content+'\nChanged project',n.revision);}
  if(change==='focus')await f.choose('off');
  if(change==='attempt')await f.app.taskWorkflows.draft({task:f.task});
  if(change==='day')f.clock.now=new Date(2026,9,28,8);
  if(change==='timezone')f.focus.timezone=()=> 'UTC';
  await assert.rejects(f.steps.outcomes.record(q),/changed/);assert.equal((await f.steps.outcomes.report(f.task.id)).outcomes.length,0);
 }
});
test('source changes at the durable outcome replacement boundary are checked again',async t=>{
 const f=await prepared(t),q=await outcomeInput(f),build=f.steps.outcomes.build.bind(f.steps.outcomes);let calls=0;
 f.steps.outcomes.build=async(...a)=>{if(++calls===2){const n=await f.app.vault.read(f.task.project);await writeFile(await f.app.vault.safe(n.path),n.content+'\nBoundary change');}return build(...a);};await assert.rejects(f.steps.outcomes.record(q),/changed/);assert.equal((await f.steps.outcomes.review()).entries.length,0);
});
test('duplicate and lost replies recover after newer reports, restart and midnight without overwriting history',async t=>{
 const f=await prepared(t),q=await outcomeInput(f),results=await Promise.all([f.steps.outcomes.record(q),f.steps.outcomes.record(q)]);assert.equal(results[1].alreadySaved,true);await f.steps.outcomes.record(await outcomeInput(f,{kind:'done',note:'Enough for today.'}));f.clock.now=new Date(2026,9,29,8);const fresh=new FirstSteps({planner:f.app.dayPlanning,data:f.app.store.root}),before=await readFile(f.steps.path,'utf8');assert.equal((await fresh.outcomes.record(q)).outcomes.length,2);assert.equal((await fresh.outcomes.status(q)).recorded,true);assert.equal(await readFile(f.steps.path,'utf8'),before);await assert.rejects(fresh.outcomes.record({...q,note:'Different retry'}),/another step decision/);
});
test('unrecorded receipt checks preserve stale outcome requests without writing state',async t=>{
 const f=await prepared(t),q=await outcomeInput(f);await f.choose('off');const before=await readFile(f.steps.path,'utf8');assert.equal((await f.steps.outcomes.status(q)).recorded,false);assert.equal(await readFile(f.steps.path,'utf8'),before);await assert.rejects(f.steps.outcomes.record(q),/changed/);
});
test('follow-on saves preserve exact card and outcome history, and consume only the selected current outcome',async t=>{
 const f=await prepared(t),original=(await f.steps.report(f.task.id)).card,q=await outcomeInput(f);await f.steps.outcomes.record(q);const follow=await input(f,{text:'Ask my teacher for an example.',sourceOutcomeId:q.requestId});let r=await f.steps.save(follow);assert.equal(r.card.sequence,2);assert.equal(r.card.sourceOutcomeId,q.requestId);assert.deepEqual(r.history[1],original);assert.deepEqual(r.outcomes[0].card,original);assert.equal(r.outcomes[0].followOnSequence,2);assert.equal(r.outcomes[0].unresolved,false);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).done,false);
 await f.steps.save(await input(f,{text:'Ask about the example after class.'}));r=await f.steps.save(follow);assert.equal(r.card.sequence,3);assert.equal(r.card.text,'Ask about the example after class.');assert.equal(r.outcomes[0].followOnSequence,2);assert.equal(r.history.length,3);assert.equal(f.calls,0);
});
test('stale or superseded follow-on sources cannot replace a current first step',async t=>{
 const f=await prepared(t),q=await outcomeInput(f);await f.steps.outcomes.record(q);const follow=await input(f,{sourceOutcomeId:q.requestId});await f.steps.outcomes.record(await outcomeInput(f,{kind:'continue',note:'I found the missing example.'}));await assert.rejects(f.steps.save(follow),/changed/);await assert.rejects(f.steps.save(await input(f,{sourceOutcomeId:q.requestId})),/superseded/);await assert.rejects(f.steps.save(await input(f,{sourceOutcomeId:randomUUID()})),/superseded/);assert.equal((await f.steps.report(f.task.id)).card.sequence,1);
});
test('a changed outcome immediately before follow-on replacement rejects the new card',async t=>{
 const f=await prepared(t),q=await outcomeInput(f);await f.steps.outcomes.record(q);const follow=await input(f,{sourceOutcomeId:q.requestId}),verify=f.steps.verify.bind(f.steps);let calls=0;f.steps.verify=async(...a)=>{if(++calls===2){const state=await f.steps.read();state.outcomes[0].note='External outcome correction';await writeFile(f.steps.path,JSON.stringify(state));}return verify(...a);};await assert.rejects(f.steps.save(follow),/changed/);assert.equal((await f.steps.report(f.task.id)).card.sequence,1);
});
test('older step versions can receive self-reports after task completion, deletion or a new card without choosing focus',async t=>{
 const f=await prepared(t),first=(await f.steps.report(f.task.id)).card;await f.steps.save(await input(f,{text:'Second version'}));const n=await f.app.vault.read(f.task.path);await f.app.vault.trash(n.path,n.revision);f.clock.now=new Date(2026,9,28,8);const focus=await f.focus.read(),q=await outcomeInput(f,{cardSequence:1,kind:'done'}),r=await f.steps.outcomes.record(q);assert.equal(r.context.task,null);assert.deepEqual(r.card,first);assert.equal(r.outcomes[0].canFollowOn,false);assert.deepEqual(await f.focus.read(),focus);assert.equal((await f.steps.report(f.task.id)).card.text,'Second version');
});
test('evening review catches up unresolved outcomes across days and exposes superseded reports accurately',async t=>{
 const f=await prepared(t),q=await outcomeInput(f);await f.steps.outcomes.record(q);f.clock.now=new Date(2026,9,29,8);let r=await f.app.dayPlanning.evening();assert.equal(r.stepOutcomes.entries[0].context.date,'2026-10-26');assert.equal(r.stepOutcomes.unresolved,1);assert.equal((await f.steps.overview())[0].openOutcomes,1);await f.steps.outcomes.record(await outcomeInput(f,{kind:'done',note:'Resolved with teacher.'}));r=await f.app.dayPlanning.evening();assert.equal(r.stepOutcomes.unresolved,0);assert.equal(r.stepOutcomes.entries.length,1);r=await f.app.dayPlanning.evening('2026-10-26');assert.equal(r.stepOutcomes.entries[0].superseded,true);assert.equal(r.stepOutcomes.observedOn,'2026-10-29');
});
test('daily summaries label outcome notes as self-reports and reject previews after a new report',async t=>{
 const f=await prepared(t);await f.steps.outcomes.record(await outcomeInput(f));const summary=await f.app.dayPlanning.summaries.report('2026-10-26');assert.match(summary.suggested,/Self-reported step outcomes/);assert.match(summary.suggested,/not verified AI results/);assert.match(summary.suggested,/Need clarification/);await f.steps.outcomes.record(await outcomeInput(f,{kind:'continue'}));await assert.rejects(f.app.dayPlanning.summaries.preview({requestId:randomUUID(),date:summary.date,sourceRevision:summary.sourceRevision,targetRevision:summary.target?.revision||null,body:summary.suggested}),/sources.*changed/);
});
test('legacy first-step files read without mutation and archive their retained card on the next edit',async t=>{
 const f=await prepared(t);const state=await f.steps.read();delete state.history;delete state.outcomes;await writeFile(f.steps.path,JSON.stringify(state));const before=await readFile(f.steps.path,'utf8'),r=await f.steps.report(f.task.id),legacyRevision=sha(JSON.stringify({context:r.context,card:r.card,canSave:r.canSave,canPrepare:r.canPrepare,detail:r.detail}));assert.equal(r.revision,legacyRevision);assert.equal(await readFile(f.steps.path,'utf8'),before);await f.steps.save(await input(f,{text:'A fresh edit'}));assert.equal((await f.steps.read()).history[0].text,state.cards[f.task.id].text);
});
test('damaged history, orphaned outcomes and missing durable state fail visibly rather than being reset',async t=>{
 const f=await prepared(t);await f.steps.outcomes.record(await outcomeInput(f));const state=await f.steps.read();for(const mutate of [s=>s.history='bad',s=>s.history=[{...s.cards[f.task.id],sequence:99}],s=>s.cards[f.task.id].sourceOutcomeId='',s=>s.outcomes[0].card.text='Unmatched original',s=>s.outcomes[0].context.execution='bad',s=>s.outcomes.push(s.outcomes[0]),s=>s.receipts=[]]){const s=structuredClone(state);mutate(s);await writeFile(f.steps.path,JSON.stringify(s));const r=await f.app.dayPlanning.evening();assert.equal(r.stepOutcomes,null);assert.match(r.stepOutcomesError,/cannot be read/);assert(r.focusReview);}await rm(f.steps.path);await assert.rejects(f.steps.outcomes.report(f.task.id),/missing/);
});
test('outcome endpoints require authentication, keep receipts private and serve the native module',async t=>{
 const f=await prepared(t);await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.app.server.address().port,boot=await(await fetch(base+'/api/bootstrap')).json(),post=(path,data,auth=false)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Aster-Token':boot.token}:{})},body:JSON.stringify(data)});
 for(const p of ['save','status'])assert.equal((await post('/api/step-outcome/'+p,{})).status,403);const q=await outcomeInput(f);assert.equal((await post('/api/step-outcome/save',q,true)).status,200);assert.equal((await(await post('/api/step-outcome/status',q,true)).json()).recorded,true);const r=await(await fetch(base+'/api/step-outcome?taskId='+f.task.id+'&sequence=1')).json();assert.equal(r.receipts,undefined);assert.equal(r.outcomes[0].requestHash,undefined);assert.equal((await fetch(base+'/step-outcomes.js')).status,200);
});
