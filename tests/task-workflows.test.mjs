import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {TaskWorkflows} from '../src/task-workflows.mjs';
import {captureCompletion} from '../src/workflow-completion.mjs';
const until=async fn=>{for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');};
async function followup(f,source){
 const choices=await f.app.workflows.followups.choices(source.id),selected=choices.items.slice(0,1).map(i=>i.id);assert(selected.length);
 const draft=await f.app.workflows.followups.preview({sourceId:source.id,sourceFingerprint:choices.fingerprint,selected});
 const {id}=await f.app.workflows.followups.start({...f.input(draft),goal:'Inspect the remaining report outcome'});await until(()=>!f.app.workflows.running.has(id));return f.app.store.get('workflows',id);
}
async function attemptsFixture(t){const f=await fixture(t),d=await f.draft(),source=await f.start(d),target=await followup(f,source);return {...f,d,source,target,preview:()=>f.tw.previewAttachment({id:d.id,revision:d.revision,targetId:target.id}),attach:r=>f.tw.decideAttachment({id:d.id,reviewId:r.attachment.id,action:'attach',acknowledge:true})};}
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-planner-execution-'));let calls=0;
 const model={model:'fixture',generationOptions:{num_ctx:12288},status:async()=>({online:true}),check:async()=>{},chat:async()=>{calls++;return {content:JSON.stringify({steps:[{title:'Inspect and deliver the requested result',check:'Observe the requested result in its current state'}]})};}};
 const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:model,workflowOptions:{pollMs:60000}});
 t.after(async()=>{await app.workflows.close();app.calendar.close();app.recurring.stop();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 await app.vault.addTask('Prepare my report',{planDate:'2026-10-26',startTime:'09:00',duration:30,due:'2026-10-30',remindAt:'2026-10-26T08:50:00+05:00'});
 const task=(await app.vault.tasks()).find(t=>t.text==='Prepare my report'),tw=app.taskWorkflows;
 const draft=()=>tw.draft({task});const input=d=>({id:d.id,revision:d.revision,goal:d.goal,scope:d.scope,requirements:d.requirements,acknowledge:true});
 const start=async d=>{const {id}=await tw.start(input(d));await until(()=>!app.workflows.running.has(id));return app.store.get('workflows',id);};
 const complete=async w=>{w.status='completed';w.current=w.steps.length;w.completed=new Date().toISOString();w.steps.forEach(s=>{s.status='completed';s.summary='Observed fixture result. These are fixture observations.';s.evidence=[];});w.result='Fixture result ready';w.completionReceipt=captureCompletion(w);await app.store.put('workflows',w);return w;};
 const decide=d=>tw.decide({id:d.id,reviewId:d.review.id,action:'complete',acknowledge:true});
 return {app,tw,task,dir,draft,input,start,complete,decide,get calls(){return calls;}};
}
test('planner draft is inert, saves edits and creates one fresh plan-reviewed linked workflow',async t=>{
 const f=await fixture(t),before=await f.app.vault.tasks(),d=await f.draft();assert.equal(f.calls,0);assert.equal((await f.app.store.list('workflows')).length,0);assert.deepEqual(await f.app.vault.tasks(),before);
 const saved=await f.tw.save({...f.input(d),goal:'Inspect the report and report exact observations'});assert.equal((await new TaskWorkflows({vault:f.app.vault,store:f.app.store,workflows:f.app.workflows}).read(d.id)).goal,saved.goal);
 const w=await f.start(saved);assert.equal(w.status,'plan_review');assert.equal(w.planApprovedRevision,null);assert.equal(w.plannerTask.taskId,f.task.id);assert.deepEqual(w.operations,[]);assert.deepEqual(w.skills,[]);assert.equal(w.routineContinuation,false);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).done,false);
 assert.equal((await f.app.dayPlanning.briefing()).execution[0].workflowId,w.id);
});
test('duplicate preparation and concurrent starts cannot create duplicate links or workflows',async t=>{
 const f=await fixture(t),attempts=await Promise.allSettled([f.draft(),f.draft()]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);const d=await f.draft();assert.equal((await f.app.store.list('task-workflows')).length,1);
 const tries=await Promise.allSettled([f.tw.start(f.input(d)),f.tw.start(f.input(d))]);assert.equal(tries.filter(x=>x.status==='fulfilled').length,1);await until(()=>!f.app.workflows.running.size);assert.equal((await f.tw.start(f.input(d))).id,d.childId);assert.equal(f.calls,1);
});
test('invalid, duplicate and completed task identities reject preparation',async t=>{
 const f=await fixture(t);await assert.rejects(f.tw.draft({task:{...f.task,id:null}}),/invalid or duplicate ID/);const n=await f.app.vault.read(f.task.path);
 await f.app.vault.save(n.path,n.content+'\n'+n.content.split('\n')[f.task.line]+'\n',n.revision);await assert.rejects(f.draft(),/duplicate ID/);await f.app.vault.save(n.path,n.content,(await f.app.vault.read(n.path)).revision);
 await f.app.vault.toggleTask(f.task.path,f.task.line,f.task.revision,true);await assert.rejects(f.tw.draft({task:(await f.app.vault.tasks()).find(t=>t.id===f.task.id)}),/already marked complete/);
});
test('unfinished prerequisites block draft creation and are rechecked before starting',async t=>{
 const f=await fixture(t);await f.app.vault.addTask('Dependent work',{dependsOn:[f.task.id]});let task=(await f.app.vault.tasks()).find(t=>t.text==='Dependent work');await assert.rejects(f.tw.draft({task}),/prerequisites/);
 const prerequisite=(await f.app.vault.tasks()).find(t=>t.id===f.task.id);await f.app.vault.toggleTask(prerequisite.path,prerequisite.line,prerequisite.revision,true);task=(await f.app.vault.tasks()).find(t=>t.id===task.id);const d=await f.tw.draft({task});const current=(await f.app.vault.tasks()).find(t=>t.id===f.task.id);await f.app.vault.toggleTask(current.path,current.line,current.revision,false);await assert.rejects(f.start(d),/changed|prerequisites/);assert.equal(f.calls,0);
});
test('failed initial child save retains original reviewed input for retry after restart',async t=>{
 const f=await fixture(t),d=await f.draft(),put=f.app.store.put.bind(f.app.store);let fail=true;f.app.store.put=async(k,v)=>{if(k==='workflows'&&v.id===d.childId&&fail){fail=false;throw Error('Initial save interrupted');}return put(k,v);};const input={...f.input(d),goal:'  Exact reviewed goal  '};await assert.rejects(f.tw.start(input),/interrupted/);f.app.store.put=put;const saved=await f.tw.read(d.id);assert.equal(saved.request.goal,input.goal);const w=await f.tw.start({...f.input(saved),...saved.request});await until(()=>!f.app.workflows.running.size);assert.equal(w.id,d.childId);assert.equal(f.calls,1);
});
test('pending actions block completion review and unlinking, and missing tasks stay visible',async t=>{
 const f=await fixture(t),d=await f.draft(),w=await f.complete(await f.start(d));await f.app.store.put('actions',{id:randomUUID(),status:'pending',workflow:{id:w.id},created:new Date().toISOString()});await assert.rejects(f.tw.preview({id:d.id}),/pending actions/);await assert.rejects(f.tw.unlink({id:d.id,revision:d.revision}),/pending actions/);const n=await f.app.vault.read(f.task.path);await f.app.vault.save(n.path,n.content.split('\n').filter((_,i)=>i!==f.task.line).join('\n'),n.revision);const s=(await f.tw.summary())[0];assert(s.identityIssue);assert.match(s.detail,/identity/);await assert.rejects(f.tw.preview({id:d.id}),/missing/);
});
test('changed source note, stale revisions and missing acknowledgements retain drafts without starting',async t=>{
 const f=await fixture(t),d=await f.draft();await assert.rejects(f.tw.start({...f.input(d),acknowledge:false}),/Review/);await f.app.vault.addTask('Another task');await assert.rejects(f.start(d),/changed/);assert.equal((await f.tw.read(d.id)).status,'draft');assert.equal(f.calls,0);
 const saved=await f.tw.save({...f.input(d),goal:'Kept edits'});await assert.rejects(f.tw.save(f.input(d)),/changed/);assert.equal(saved.goal,'Kept edits');
});
test('creation recovers a lost reply with the same workflow and never re-plans',async t=>{
 const f=await fixture(t),d=await f.draft(),put=f.app.store.put.bind(f.app.store);let fail=true;
 f.app.store.put=async(k,r)=>{if(k==='task-workflows'&&r.status==='linked'&&fail){fail=false;throw Error('Lost link receipt');}return put(k,r);};await assert.rejects(f.tw.start(f.input(d)),/Lost/);await until(()=>!f.app.workflows.running.size);f.app.store.put=put;
 const restarted=new TaskWorkflows({vault:f.app.vault,store:f.app.store,workflows:f.app.workflows});assert.equal((await restarted.start(f.input(d))).id,d.childId);assert.equal(f.calls,1);assert.equal((await restarted.read(d.id)).workflow.id,d.childId);await assert.rejects(restarted.start({...f.input(d),goal:'Different'}),/different inputs/);
});
test('workflow completion never automatically checks a task; explicit review preserves scheduling and calendar identity',async t=>{
 const f=await fixture(t),d=await f.draft(),w=await f.start(d);await assert.rejects(f.tw.preview({id:d.id}),/Finish the workflow/);await f.complete(w);
 const before=await f.app.vault.read(f.task.path),calendar=await f.app.calendar.status(),review=await f.tw.preview({id:d.id});assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).done,false);assert.equal(review.review.completion.mode,'recorded');assert.equal(review.review.intent,undefined);
 await assert.rejects(f.tw.decide({id:d.id,reviewId:review.review.id,action:'complete'}),/Review/);await f.decide(review);const after=(await f.app.vault.tasks()).find(t=>t.id===f.task.id);assert.deepEqual({...after,done:false,revision:f.task.revision},f.task);assert.equal((await f.app.vault.read(f.task.path)).content,before.content.replace('- [ ] Prepare','- [x] Prepare'));assert.deepEqual((await f.app.calendar.status()).links,calendar.links);
 const history=await f.app.vault.taskHistory.report();assert.equal(history.events.filter(e=>e.taskId===f.task.id&&e.kinds.includes('marked_complete')).length,1);
});
test('a changed task requires fresh completion review and a changed workflow invalidates that review',async t=>{
 const f=await fixture(t),d=await f.draft(),w=await f.complete(await f.start(d));let r=await f.tw.preview({id:d.id});await f.app.vault.scheduleTask({...f.task,startTime:'10:00'});await assert.rejects(f.decide(r),/changed/);
 await f.tw.decide({id:d.id,reviewId:r.review.id,action:'discard'});r=await f.tw.preview({id:d.id});assert(r.review.changedSinceStart);assert.equal(r.review.task.startTime,'10:00');w.result='Changed result';await f.app.store.put('workflows',w);await assert.rejects(f.decide(r),/results changed/);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).done,false);
});
test('a duplicate task ID added after completion preview cannot change either task',async t=>{
 const f=await fixture(t),d=await f.draft();await f.complete(await f.start(d));const r=await f.tw.preview({id:d.id}),n=await f.app.vault.read(f.task.path);await f.app.vault.save('40 Tasks/Duplicate.md',n.content,null);await assert.rejects(f.decide(r),/duplicate ID/);assert((await f.app.vault.tasks()).filter(t=>t.id===f.task.id).every(t=>!t.done));
});
test('interrupted completion saves reconcile once and never overwrite a later reopening',async t=>{
 const f=await fixture(t),d=await f.draft();await f.complete(await f.start(d));const r=await f.tw.preview({id:d.id}),put=f.app.store.put.bind(f.app.store);let fail=true;
 f.app.store.put=async(k,v)=>{if(k==='task-workflows'&&v.review?.status==='applied'&&fail){fail=false;throw Error('Interrupted receipt');}return put(k,v);};await assert.rejects(f.decide(r),/Interrupted/);f.app.store.put=put;
 const restarted=new TaskWorkflows({vault:f.app.vault,store:f.app.store,workflows:f.app.workflows});assert.equal((await restarted.decide({id:d.id,reviewId:r.review.id,action:'complete',acknowledge:true})).review.status,'applied');const task=(await f.app.vault.tasks()).find(t=>t.id===f.task.id);await f.app.vault.toggleTask(task.path,task.line,task.revision,false);await f.decide(r);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).done,false);assert.equal((await f.app.vault.taskHistory.report()).events.filter(e=>e.taskId===task.id&&e.kinds.includes('marked_complete')).length,1);
});
test('interrupted write before commit retries only after explicit confirmation',async t=>{
 const f=await fixture(t),d=await f.draft();await f.complete(await f.start(d));const r=await f.tw.preview({id:d.id}),save=f.app.vault.save.bind(f.app.vault);f.app.vault.save=async()=>{throw Error('Disk interrupted');};await assert.rejects(f.decide(r),/Disk/);f.app.vault.save=save;assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).done,false);assert((await f.tw.read(d.id)).review.interrupted);await f.decide(r);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).done,true);
});
test('unrelated edits after an uncertain save block replay and discard keeps the current note',async t=>{
 const f=await fixture(t),d=await f.draft();await f.complete(await f.start(d));const r=await f.tw.preview({id:d.id}),put=f.app.store.put.bind(f.app.store);let fail=true;f.app.store.put=async(k,v)=>{if(v.review?.status==='applied'&&fail){fail=false;throw Error('Lost receipt');}return put(k,v);};await assert.rejects(f.decide(r));f.app.store.put=put;await f.app.vault.addTask('Keep new addition');const before=await f.app.vault.read(f.task.path);await assert.rejects(f.decide(r),/changed/);await f.tw.decide({id:d.id,reviewId:r.review.id,action:'discard'});assert.equal((await f.app.vault.read(f.task.path)).content,before.content);
});
test('unlinking leaves the workflow and planner untouched and permits a new reviewed link',async t=>{
 const f=await fixture(t),d=await f.draft(),w=await f.start(d),before=await f.app.store.get('workflows',w.id);await f.tw.unlink({id:d.id,revision:d.revision});assert.deepEqual(await f.app.store.get('workflows',w.id),before);assert.equal((await f.tw.summary()).length,0);const next=await f.draft();assert.notEqual(next.id,d.id);assert.notEqual(next.childId,w.id);await assert.rejects(f.start(d),/removed/);
});
test('completion guards are rechecked at the atomic note commit',async t=>{
 const f=await fixture(t),d=await f.draft(),w=await f.complete(await f.start(d)),r=await f.tw.preview({id:d.id}),save=f.app.vault.save.bind(f.app.vault);f.app.vault.save=async(...args)=>{w.result='Late changed outcome';await f.app.store.put('workflows',w);return save(...args);};await assert.rejects(f.decide(r),/results changed/);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).done,false);
});
test('planner execution APIs require the app token and expose status without write intents',async t=>{
 const f=await fixture(t);await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>f.app.server.close(r)));const base='http://127.0.0.1:'+f.app.server.address().port,boot=await(await fetch(base+'/api/bootstrap')).json();
 for(const op of ['draft','save','start','unlink','review','decide','attachment','attach-decide'])assert.equal((await fetch(base+'/api/task-workflow-'+op,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 const response=await fetch(base+'/api/task-workflow-draft',{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':boot.token},body:JSON.stringify({task:f.task})});assert.equal(response.status,200);const list=await(await fetch(base+'/api/task-workflows')).json();assert.equal(list[0].taskId,f.task.id);assert.equal(f.calls,0);
});
test('reviewed follow-up becomes current without changing workflows, approvals, tasks or calendar links',async t=>{
 const f=await attemptsFixture(t),notes=await f.app.vault.tasks(),source=await f.app.store.get('workflows',f.source.id),target=await f.app.store.get('workflows',f.target.id),calendar=await f.app.calendar.status();
 const r=await f.preview();assert.equal(r.childId,source.id);assert.equal(r.attachment.status,'pending');assert.equal(r.attempts.length,1);
 await assert.rejects(f.tw.decideAttachment({id:f.d.id,reviewId:r.attachment.id,action:'attach'}),/Review/);
 const result=await f.attach(r);assert.equal(result.childId,target.id);assert.equal(result.revision,f.d.revision+1);assert.equal(result.attempts.length,2);assert.equal(result.attempts[0].current,false);assert.equal(result.attempts[1].current,true);assert.equal(result.attempts[1].sourceId,source.id);
 assert.deepEqual(await f.app.store.get('workflows',source.id),source);assert.deepEqual(await f.app.store.get('workflows',target.id),target);assert.deepEqual(await f.app.vault.tasks(),notes);assert.deepEqual((await f.app.calendar.status()).links,calendar.links);
 const summary=(await f.app.dayPlanning.briefing()).execution[0];assert.equal(summary.attempt,2);assert.equal(summary.workflowId,target.id);assert.match(summary.detail,/Attempt 2 of 2/);
});
test('attachment survives restart and a lost acknowledgement without duplicating an attempt',async t=>{
 const f=await attemptsFixture(t),r=await f.preview();const restarted=new TaskWorkflows({vault:f.app.vault,store:f.app.store,workflows:f.app.workflows});assert.equal((await restarted.read(f.d.id)).attachment.id,r.attachment.id);
 const put=f.app.store.put.bind(f.app.store);let fail=true;f.app.store.put=async(k,v)=>{const result=await put(k,v);if(k==='task-workflows'&&v.attachment?.status==='applied'&&fail){fail=false;throw Error('Lost attachment reply');}return result;};await assert.rejects(f.attach(r),/Lost/);f.app.store.put=put;
 const result=await restarted.decideAttachment({id:f.d.id,reviewId:r.attachment.id,action:'attach',acknowledge:true});assert.equal(result.attempts.length,2);assert.equal(result.childId,f.target.id);assert.equal(result.workflow.status,'plan_review');
});
test('an interrupted attachment before storage leaves the prior attempt current and retries safely',async t=>{
 const f=await attemptsFixture(t),r=await f.preview(),put=f.app.store.put.bind(f.app.store);f.app.store.put=async(k,v)=>{if(k==='task-workflows'&&v.attachment?.status==='applied')throw Error('Disk interrupted');return put(k,v);};await assert.rejects(f.attach(r),/Disk/);f.app.store.put=put;assert.equal((await f.tw.read(f.d.id)).childId,f.source.id);assert.equal((await f.tw.read(f.d.id)).attachment.status,'pending');assert.equal((await f.attach(r)).attempts.length,2);
});
test('changed task, parent or follow-up invalidates attachment review without losing history',async t=>{
 for(const change of ['task','parent','target']){const f=await attemptsFixture(t),r=await f.preview();if(change==='task')await f.app.vault.scheduleTask({...f.task,startTime:'11:00'});else{const w=change==='parent'?f.source:f.target;w.goal+=' changed';await f.app.store.put('workflows',w);}await assert.rejects(f.attach(r),/changed/);assert.equal((await f.tw.read(f.d.id)).childId,f.source.id);await f.tw.decideAttachment({id:f.d.id,reviewId:r.attachment.id,action:'discard'});assert.equal((await f.tw.read(f.d.id)).attachment.status,'discarded');}
});
test('completed, cancelled, already approved, active and used follow-ups cannot be attached',async t=>{
 const f=await attemptsFixture(t),original=structuredClone(f.target);for(const changes of [{status:'completed'},{status:'cancelled'},{planApprovedRevision:1},{status:'running'},{operations:[{status:'completed',name:'read_system_file'}]}]){await f.app.store.put('workflows',{...original,...changes});await assert.rejects(f.preview(),/freshly prepared|Stop the workflow/);const candidates=await f.tw.candidates(f.d.id);assert(candidates.items[0].issue);}await f.app.store.put('workflows',original);assert.equal((await f.tw.candidates(f.d.id)).items[0].issue,null);
});
test('cancelled source can continue via a fresh follow-up, but pending actions and controls block attachment',async t=>{
 const f=await attemptsFixture(t);f.source.status='cancelled';await f.app.store.put('workflows',f.source);const r=await f.preview();f.app.workflows.controls.add(f.target.id);await assert.rejects(f.attach(r),/being updated/);f.app.workflows.controls.delete(f.target.id);
 const action={id:randomUUID(),status:'pending',workflow:{id:f.source.id}};await f.app.store.put('actions',action);await assert.rejects(f.attach(r),/pending actions/);action.status='cancelled';await f.app.store.put('actions',action);assert.equal((await f.attach(r)).childId,f.target.id);
});
test('only direct follow-ups of the current attempt may be attached; stale replacement decisions are rejected',async t=>{
 const f=await attemptsFixture(t),sibling=await followup(f,f.source),r=await f.preview();await assert.rejects(f.tw.previewAttachment({id:f.d.id,revision:f.d.revision,targetId:sibling.id}),/Discard the pending/);await f.attach(r);
 await assert.rejects(f.tw.previewAttachment({id:f.d.id,revision:f.d.revision,targetId:sibling.id}),/current attempt changed/);
 await assert.rejects(f.tw.previewAttachment({id:f.d.id,revision:f.d.revision+1,targetId:sibling.id}),/direct follow-up/);
 const third=await followup(f,f.target),next=await f.tw.previewAttachment({id:f.d.id,revision:f.d.revision+1,targetId:third.id});await f.attach(next);await assert.rejects(f.attach(r),/review changed/);const final=await f.tw.read(f.d.id);assert.equal(final.attempts.length,3);assert.equal(final.childId,third.id);
});
test('duplicate attachment decisions serialize and cannot claim a workflow owned by another link',async t=>{
 const f=await attemptsFixture(t),r=await f.preview();const tries=await Promise.allSettled([f.attach(r),f.attach(r)]);assert.equal(tries.filter(t=>t.status==='fulfilled').length,1);assert.equal((await f.tw.read(f.d.id)).attempts.length,2);
 const g=await attemptsFixture(t);await g.app.store.put('task-workflows',{id:randomUUID(),childId:g.target.id,status:'linked',task:g.task,created:new Date().toISOString(),revision:1});await assert.rejects(g.preview(),/already attached/);
});
test('pending completion saves and attachment previews exclude each other, including unlinking',async t=>{
 const f=await attemptsFixture(t);await f.complete(f.source);const completion=await f.tw.preview({id:f.d.id});await assert.rejects(f.preview(),/completion review/);await f.tw.decide({id:f.d.id,reviewId:completion.review.id,action:'discard'});const r=await f.preview();await assert.rejects(f.tw.preview({id:f.d.id}),/attachment review/);await assert.rejects(f.tw.unlink({id:f.d.id,revision:f.d.revision}),/pending completion or attachment/);await f.tw.decideAttachment({id:f.d.id,reviewId:r.attachment.id,action:'discard'});assert.equal((await f.tw.read(f.d.id)).childId,f.source.id);
});
test('earlier completion reviews cannot check the planner task after a new attempt is attached',async t=>{
 const f=await attemptsFixture(t);await f.complete(f.source);const old=await f.tw.preview({id:f.d.id});await f.decide(old);let task=(await f.app.vault.tasks()).find(t=>t.id===f.task.id);await f.app.vault.toggleTask(task.path,task.line,task.revision,false);
 const r=await f.preview();await f.attach(r);await assert.rejects(f.decide(old),/review changed/);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).done,false);await assert.rejects(f.tw.preview({id:f.d.id}),/Finish the workflow/);
 await f.complete(f.target);const current=await f.tw.preview({id:f.d.id});assert.equal(current.review.workflowId,f.target.id);assert.equal(current.review.linkRevision,2);assert.equal(current.reviewHistory.at(-1).workflowId,f.source.id);await f.decide(current);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).done,true);
});
test('a forged or stale completion binding is rejected even when an interrupted write looks applied',async t=>{
 const f=await attemptsFixture(t);await f.complete(f.source);let r=await f.tw.preview({id:f.d.id}),raw=await f.tw.record(f.d.id);raw.review.workflowId=f.target.id;raw.review.intent={afterRevision:f.task.revision,after:f.task};await f.app.store.put('task-workflows',raw);await assert.rejects(f.decide(r),/earlier attempt/);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).done,false);
});
test('missing tasks, duplicate task IDs and missing source workflows block attaching',async t=>{
 const f=await attemptsFixture(t),r=await f.preview(),n=await f.app.vault.read(f.task.path);await f.app.vault.save('40 Tasks/Duplicate.md',n.content,null);await assert.rejects(f.attach(r),/duplicate ID/);
 const g=await attemptsFixture(t);await rm(g.app.store.file('workflows',g.source.id));await assert.rejects(g.preview(),/direct follow-up/);assert.match((await g.tw.summary())[0].detail,/missing/);
});
test('attention reads and briefing share current blockers without inference or writes',async t=>{
 const f=await fixture(t),d=await f.draft(),before=await readFile(f.app.store.file('task-workflows',d.id),'utf8'),notes=await f.app.vault.tasks();
 assert.equal((await f.tw.attention(d.id)).attention.kind,'draft');assert.equal((await f.app.dayPlanning.briefing()).execution[0].attention.kind,'draft');assert.equal(f.calls,0);assert.deepEqual(await f.app.vault.tasks(),notes);assert.equal(await readFile(f.app.store.file('task-workflows',d.id),'utf8'),before);
 const w=await f.start(d);assert.equal((await f.tw.attention(d.id)).attention.kind,'plan');const snapshot=await readFile(f.app.store.file('workflows',w.id),'utf8');await f.tw.attention(d.id);assert.equal(await readFile(f.app.store.file('workflows',w.id),'utf8'),snapshot);assert.equal(f.calls,1);
});
test('attention distinguishes questions, uncertain results, pauses, model changes and work limits',async t=>{
 const f=await fixture(t),d=await f.draft(),w=await f.start(d);w.planApprovedRevision=w.revision;
 for(const [changes,kind] of [[{status:'waiting_input',question:'Which file should I use?'},'question'],[{status:'needs_verification',question:null,error:'The saved outcome is uncertain.'},'verification'],[{status:'paused',error:'Stopped for the evening.'},'paused'],[{status:'needs_help',error:'The check failed twice.'},'paused'],[{calls:48},'limit'],[{calls:1,model:'different-model'},'model_changed']]){Object.assign(w,changes);await f.app.store.put('workflows',w);const item=await f.tw.attention(d.id);assert.equal(item.attention.kind,kind);assert.equal(item.attention.destination,'workflow');assert(item.attention.detail);}
});
test('only actions belonging to the current attempt appear, including expiry and manually completed task cleanup',async t=>{
 const f=await attemptsFixture(t),r=await f.preview();await f.attach(r);const now=new Date().toISOString();
 await f.app.store.put('actions',{id:randomUUID(),workflow:{id:f.source.id},status:'pending',created:now});assert.equal((await f.tw.attention(f.d.id)).attention.kind,'plan');
 const action={id:randomUUID(),workflow:{id:f.target.id},status:'pending',expires:'2000-01-01T00:00:00Z',created:now};await f.app.store.put('actions',action);let item=await f.tw.attention(f.d.id);assert.equal(item.attention.kind,'approval');assert.equal(item.attention.actionId,action.id);assert.match(item.attention.detail,/expired/);
 await f.app.vault.toggleTask(f.task.path,f.task.line,f.task.revision,true);assert.equal((await f.tw.attention(f.d.id)).attention.kind,'approval');action.status='dismissed';await f.app.store.put('actions',action);assert.equal((await f.tw.attention(f.d.id)).attention,null);
});
test('active work and reconciled approvals do not become false attention items',async t=>{
 const f=await fixture(t),d=await f.draft(),w=await f.start(d);w.planApprovedRevision=w.revision;
 for(const status of ['planning','running','queued','planned','waiting_approval']){w.status=status;await f.app.store.put('workflows',w);assert.equal((await f.tw.attention(d.id)).attention,null,status);}
 w.status='cancelled';await f.app.store.put('workflows',w);assert.equal((await f.tw.attention(d.id)).attention.kind,'cancelled');await f.tw.unlink({id:d.id,revision:d.revision});assert.equal(await f.tw.attention(d.id),null);
});
test('pending reviews outrank workflow status and interrupted completion stays visible after a saved checkbox',async t=>{
 const f=await attemptsFixture(t),r=await f.preview();assert.equal((await f.tw.attention(f.d.id)).attention.kind,'attachment_review');await f.tw.decideAttachment({id:f.d.id,reviewId:r.attachment.id,action:'discard'});await f.complete(f.source);assert.equal((await f.tw.attention(f.d.id)).attention.kind,'completion');const review=await f.tw.preview({id:f.d.id});assert.equal((await f.tw.attention(f.d.id)).attention.kind,'completion_review');
 const put=f.app.store.put.bind(f.app.store);f.app.store.put=async(k,v)=>{if(k==='task-workflows'&&v.review?.status==='applied')throw Error('Lost completion receipt');return put(k,v);};await assert.rejects(f.decide(review),/Lost/);f.app.store.put=put;const item=await f.tw.attention(f.d.id);assert.equal(item.done,true);assert.equal(item.attention.kind,'completion_save');await f.decide(review);assert.equal((await f.tw.attention(f.d.id)).attention,null);
});
test('attention exposes invalid identity, duplicate links and missing workflow recovery',async t=>{
 const f=await fixture(t),d=await f.draft(),w=await f.start(d);await rm(f.app.store.file('workflows',w.id));assert.equal((await f.tw.attention(d.id)).attention.kind,'missing_workflow');
 const copy={...await f.tw.record(d.id),id:randomUUID()};await f.app.store.put('task-workflows',copy);assert.match((await f.tw.attention(d.id)).attention.detail,/more than one/);await rm(f.app.store.file('task-workflows',copy.id));const n=await f.app.vault.read(f.task.path);await f.app.vault.save('40 Tasks/Duplicate.md',n.content,null);assert.equal((await f.tw.attention(d.id)).attention.kind,'task_issue');
});
test('fresh attention lookup follows replacement and survives recreation of the service object',async t=>{
 const f=await attemptsFixture(t);f.source.status='waiting_input';f.source.question='Old attempt question';await f.app.store.put('workflows',f.source);assert.equal((await f.tw.attention(f.d.id)).attention.kind,'question');const r=await f.preview();await f.attach(r);
 const restarted=new TaskWorkflows({vault:f.app.vault,store:f.app.store,workflows:f.app.workflows}),item=await restarted.attention(f.d.id);assert.equal(item.workflowId,f.target.id);assert.equal(item.attention.kind,'plan');assert(!item.attention.detail.includes('Old attempt question'));
});
test('attention GET endpoint is read-only and resolves stale completed items without creating reviews',async t=>{
 const f=await fixture(t),d=await f.draft();await f.complete(await f.start(d));await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>f.app.server.close(r)));const url='http://127.0.0.1:'+f.app.server.address().port+'/api/task-workflow-attention?id='+d.id;
 assert.equal((await(await fetch(url)).json()).attention.kind,'completion');assert.equal((await f.tw.read(d.id)).review,undefined);await f.app.vault.toggleTask(f.task.path,f.task.line,f.task.revision,true);assert.equal((await(await fetch(url)).json()).attention,null);
});

test('evening review reports only the current attempt with bounded saved results, without inference or planner completion',async t=>{
 const f=await attemptsFixture(t);f.app.dayPlanning.now=()=>new Date(2026,9,26,20);let source=await f.complete(f.source);const review=await f.preview();await f.attach(review);
 const target=await f.app.store.get('workflows',f.target.id);target.status='waiting_input';target.question='Which current report should I use?';target.steps[0].summary='Partial current result';await f.app.store.put('workflows',target);
 const calls=f.calls,before=await f.app.vault.list(),report=await f.app.dayPlanning.evening(),entry=report.unfinished.find(t=>t.id===f.task.id),e=entry.execution[0];
 assert.equal(e.workflowId,target.id);assert.equal(e.attempt,2);assert.equal(e.results.question,target.question);assert.equal(e.results.steps[0].summary,'Partial current result');assert(!JSON.stringify(e.results).includes('Observed fixture result'));assert.equal(f.calls,calls);assert.deepEqual(await f.app.vault.list(),before);
 const p=await f.app.dayPlanning.eveningPreview({date:report.date,choices:[{task:entry,action:'move',date:'2026-10-27'}]});
 source.result='Historical change';await f.app.store.put('workflows',source);const links=await f.app.store.list('task-workflows'),calendar=(await f.app.calendar.status()).links;await f.app.dayPlanning.decide(p.id,'accept');assert.deepEqual(await f.app.store.list('task-workflows'),links);assert.deepEqual((await f.app.calendar.status()).links,calendar);assert.equal(f.calls,calls);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).done,false);
});
test('attaching a new current attempt invalidates saved evening decisions without changing their task',async t=>{
 const f=await attemptsFixture(t);f.app.dayPlanning.now=()=>new Date(2026,9,26,20);const report=await f.app.dayPlanning.evening(),task=report.unfinished.find(t=>t.id===f.task.id),p=await f.app.dayPlanning.eveningPreview({date:report.date,choices:[{task,action:'unschedule'}]});await f.attach(await f.preview());await assert.rejects(f.app.dayPlanning.decide(p.id,'accept'),/execution changed/);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.task.id).planDate,f.task.planDate);
});

test('weekly review distinguishes results awaiting completion from unfinished current attempts and preserves history when rescheduled',async t=>{
 const f=await attemptsFixture(t),weekly=f.app.dayPlanning.weeklyReview;weekly.now=f.app.dayPlanning.now=()=>new Date(2026,9,26,20);await f.complete(f.source);
 let report=await weekly.report(),task=report.unfinished.find(t=>t.id===f.task.id);assert.match(task.guidance,/recorded result/);assert.equal(task.execution[0].results.steps[0].summary,'Observed fixture result. These are fixture observations.');assert.equal(task.done,false);
 const p=await f.app.dayPlanning.weeklyPreview({date:report.start,choices:[{task,action:'move',date:'2026-10-27'}]});await f.attach(await f.preview());await assert.rejects(f.app.dayPlanning.decide(p.id,'accept'),/execution changed/);
 const w=await f.app.store.get('workflows',f.target.id);w.status='waiting_input';w.question='Choose the remaining report';await f.app.store.put('workflows',w);report=await weekly.report();task=report.unfinished.find(t=>t.id===f.task.id);assert.equal(task.execution[0].workflowId,w.id);assert.equal(task.execution[0].attempt,2);assert.equal(task.execution[0].results.question,w.question);assert(!JSON.stringify(task.execution[0].results).includes('Observed fixture result'));
 const links=await f.app.store.list('task-workflows'),calendar=(await f.app.calendar.status()).links,calls=f.calls;const next=await f.app.dayPlanning.weeklyPreview({date:report.start,choices:[{task,action:'move',date:'2026-10-27',text:'Inspect one remaining section',duration:15}]});await f.app.dayPlanning.decide(next.id,'accept');assert.deepEqual(await f.app.store.list('task-workflows'),links);assert.deepEqual((await f.app.calendar.status()).links,calendar);assert.equal(f.calls,calls);assert.equal((await f.app.vault.tasks()).find(t=>t.id===task.id).done,false);
});
