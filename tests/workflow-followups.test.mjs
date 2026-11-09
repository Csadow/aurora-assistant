import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {WorkflowFollowups,followupChoices,requireFollowupInspection} from '../src/workflow-followups.mjs';
import {captureCompletion} from '../src/workflow-completion.mjs';

const until=async fn=>{for(let i=0;i<400;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('Follow-up test timed out');};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-followup-')),file=join(dir,'result.txt');await writeFile(file,'Current external content\n');let calls=0,messages;
 const client={model:'fixture',generationOptions:{num_ctx:12288},status:async()=>({online:true}),check:async()=>{},chat:async m=>{calls++;messages=m;return {content:JSON.stringify({steps:[{title:'Inspect and finish the selected output',check:'Observe the selected condition in current state'}]})};}};
 const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),projects:[],backups:join(dir,'backups'),embedding:'',ollamaClient:client,workflowOptions:{pollMs:60000}});
 t.after(async()=>{await app.workflows.close();app.calendar.close();app.recurring.stop();app.backups.stop();app.recovery?.stop();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 const at=new Date().toISOString(),source={id:randomUUID(),version:19,revision:1,goal:'Finish the report',scope:dir,status:'needs_help',created:at,updated:at,model:'fixture',generation:client.generationOptions,skills:[],directives:[],planHistory:[],calls:48,activeMs:0,current:1,
  steps:[{id:randomUUID(),title:'Write initial report',status:'completed',summary:'The initial report was saved.',evidence:[]},{id:randomUUID(),title:'Verify the final page',status:'planned',check:'Observe the requested page'}],operations:[],
  question:'Which final page is intended?',requirements:{files:[{path:file,finalNewline:'required',lineEndings:'lf',requiredText:['Final']}],commands:[],browser:{url:'https://example.com/final',title:'Final page'},window:{title:'Report — Editor',app:'Editor'}}};
 await app.store.put('workflows',source);const f=app.workflows.followups;
 const preview=async(selected=['check:0'])=>{const c=await f.choices(source.id);return f.preview({sourceId:source.id,sourceFingerprint:c.fingerprint,selected});};
 const input=d=>({id:d.id,revision:d.revision,goal:d.goal,scope:d.scope,requirements:d.requirements,acknowledge:true});
 return {app,f,source,dir,file,preview,input,get calls(){return calls;},get messages(){return messages;}};
}
test('choices and preview are inert, selected requirements stay exact and parent journal remains unchanged',async t=>{
 const f=await fixture(t),before=await readFile(f.app.store.file('workflows',f.source.id),'utf8'),d=await f.preview(['check:0','question']);
 assert.deepEqual(d.requirements.files,f.source.requirements.files);assert.equal(d.requirements.browser,undefined);assert.equal(d.context.selected.length,2);assert.match(d.context.completed[0].assessment,/saved/);assert.equal(f.calls,0);assert.equal((await f.app.store.list('workflows')).length,1);assert.equal((await f.app.store.list('actions')).length,0);assert.equal(await readFile(f.file,'utf8'),'Current external content\n');assert.equal(await readFile(f.app.store.file('workflows',f.source.id),'utf8'),before);
});
test('empty, forged and duplicate selections and stale source snapshots are rejected before a draft is saved',async t=>{
 const f=await fixture(t),c=await f.f.choices(f.source.id);for(const selected of [[],['unknown'],['question','question']])await assert.rejects(f.f.preview({sourceId:f.source.id,sourceFingerprint:c.fingerprint,selected}));
 f.source.question='New question';await f.app.store.put('workflows',f.source);await assert.rejects(f.f.preview({sourceId:f.source.id,sourceFingerprint:c.fingerprint,selected:['question']}),/source results changed/);assert.equal((await f.app.store.list('followups')).length,0);
});
test('active source tasks and pending actions cannot launch parallel follow-up work',async t=>{
 const f=await fixture(t);f.source.status='running';await f.app.store.put('workflows',f.source);await assert.rejects(f.preview(),/Stop the source/);
 f.source.status='paused';await f.app.store.put('workflows',f.source);await f.app.store.put('actions',{id:randomUUID(),workflow:{id:f.source.id},status:'pending'});await assert.rejects(f.preview(),/pending actions/);
});
test('new child gets a reviewed plan, fresh journal and budgets, and historical context cannot become evidence',async t=>{
 const f=await fixture(t),d=await f.preview(['question','check:1']);const before=await readFile(f.app.store.file('workflows',f.source.id),'utf8');const w=await f.f.start(f.input(d));await until(()=>!f.app.workflows.running.has(w.id));const child=await f.app.workflows.read(w.id);
 assert.equal(child.status,'plan_review');assert.equal(child.planApprovedRevision,null);assert.equal(child.followUp.sourceId,f.source.id);assert.equal(child.followUp.draftId,d.id);assert.deepEqual(child.operations,[]);assert.deepEqual(child.skills,[]);assert.equal(child.routineContinuation,false);assert.equal(child.calls,1);assert.equal(child.project,undefined);assert.equal(child.handoff,undefined);assert.equal(child.completionReceipt,undefined);assert(child.requirementChecks.every(c=>!c.passed));assert.equal((await f.app.store.list('actions')).length,0);
 const context=JSON.parse(f.app.workflows.context(child));assert.equal(context.historicalFollowUp.sourceId,f.source.id);assert.deepEqual(context.evidenceForCompletion,[]);assert.match(f.messages[0].content,/historicalFollowUp/);assert.equal(await readFile(f.app.store.file('workflows',f.source.id),'utf8'),before);
});
test('child creation retries return the same task after a lost receipt and a new coordinator',async t=>{
 const f=await fixture(t),d=await f.preview(),put=f.app.store.put.bind(f.app.store);let fail=true;
 f.app.store.put=async(kind,r)=>{if(kind==='followups'&&r.status==='created'&&fail){fail=false;throw Error('lost receipt');}return put(kind,r);};
 await assert.rejects(f.f.start(f.input(d)),/lost receipt/);await until(()=>!f.app.workflows.running.size);f.app.store.put=put;
 const restarted=new WorkflowFollowups(f.app.workflows),child=await restarted.start(f.input(d));assert.equal(child.id,d.childId);assert.equal((await f.app.store.list('workflows')).length,2);assert.equal(f.calls,1);await assert.rejects(restarted.start({...f.input(d),goal:'Changed'}),/different inputs/);
});
test('a durable draft reopens, retains edits and rejects stale saves or discarded creation',async t=>{
 const f=await fixture(t),d=await f.preview();const saved=await f.f.save({...f.input(d),goal:'Inspect only the intended report'}),restarted=new WorkflowFollowups(f.app.workflows);
 assert.equal((await restarted.read(d.id)).goal,saved.goal);await assert.rejects(restarted.save(f.input(d)),/draft changed/);await restarted.discard({id:d.id,revision:saved.revision});await assert.rejects(restarted.start(f.input(saved)),/discarded/);assert.equal((await f.app.store.list('workflows')).length,1);assert.equal(f.calls,0);
});
test('source changes between preview and start keep the edited draft and reject new work',async t=>{
 const f=await fixture(t),d=await f.preview();f.source.steps[1].status='completed';await f.app.store.put('workflows',f.source);await assert.rejects(f.f.start(f.input(d)),/source task changed/);assert.equal((await f.f.read(d.id)).status,'draft');assert.equal((await f.app.store.list('workflows')).length,1);
});
test('changed files and absent page observations cannot satisfy fresh child checks',async t=>{
 const f=await fixture(t),d=await f.preview(['check:0','check:1']);await writeFile(f.file,'Final but changed after preview\n');const child=await f.f.start(f.input(d));await until(()=>!f.app.workflows.running.size);const w=await f.app.workflows.read(child.id);assert(w.requirementChecks.every(c=>!c.passed));assert.deepEqual(w.operations,[]);assert.equal(await readFile(f.file,'utf8'),'Final but changed after preview\n');
});
test('invalid edited requirements and missing acknowledgement cannot create a child',async t=>{
 const f=await fixture(t),d=await f.preview();await assert.rejects(f.f.start({...f.input(d),acknowledge:false}),/acknowledge/);
 await assert.rejects(f.f.start({...f.input(d),requirements:{files:[{path:f.file,exactText:'Wrong',requiredText:['Final'],finalNewline:'required',lineEndings:'lf'}],commands:[]}}),/contradicts/);assert.equal((await f.app.store.list('workflows')).length,1);
});
test('conflicting historical requirements cannot be silently merged',async t=>{
 const f=await fixture(t);f.source.requirements.files.push({...f.source.requirements.files[0],finalNewline:'forbidden'});await f.app.store.put('workflows',f.source);await assert.rejects(f.preview(['check:0','check:1']),/conflicting requirements/);
});
test('initial follow-up actions require an observation from the new journal',async t=>{
 const f=await fixture(t),w={...f.source,followUp:{sourceId:'old'},operations:[]};assert.throws(()=>requireFollowupInspection(w,'write',{}),/Inspect/);assert.doesNotThrow(()=>requireFollowupInspection(w,'computer',{operation:'windows'}));
 w.operations.push({id:randomUUID(),name:'user_verification',status:'completed',result:{content:'I saw it'}});assert.throws(()=>requireFollowupInspection(w,'command',{}),/Inspect/);
 w.operations.push({id:randomUUID(),name:'read_system_file',status:'completed',result:{path:f.file,content:'Observed'}});assert.doesNotThrow(()=>requireFollowupInspection(w,'write',{}));
});
test('completed snapshot remains immutable and legacy unresolved checks remain selectable',async t=>{
 const f=await fixture(t),w={...f.source,status:'completed',current:2,completed:new Date().toISOString(),steps:f.source.steps.map(s=>({...s,status:'completed'}))};w.completionReceipt=captureCompletion(w);const receipt=structuredClone(w.completionReceipt),before=structuredClone(w);
 const c=followupChoices(w);assert(c.items.some(i=>i.kind==='file'));assert.deepEqual(w,before);assert.deepEqual(w.completionReceipt,receipt);delete w.completionReceipt;assert(followupChoices(w).items.some(i=>i.kind==='browser'));
});

test('a failed initial child save retries once from its durable intent without duplicate planning',async t=>{
 const f=await fixture(t),d=await f.preview(),put=f.app.store.put.bind(f.app.store);let fail=true;
 f.app.store.put=async(kind,r)=>{if(kind==='workflows'&&r.id===d.childId&&fail){fail=false;throw Error('disk interrupted');}return put(kind,r);};
 await assert.rejects(f.f.start({...f.input(d),goal:'  Reviewed goal  '}),/disk interrupted/);const stored=await f.f.read(d.id);assert.equal(stored.status,'creating');assert.equal(stored.request.goal,'  Reviewed goal  ');assert.equal(f.calls,0);
 const next=new WorkflowFollowups(f.app.workflows),child=await next.start({...f.input(d),...stored.request});await until(()=>!f.app.workflows.running.size);assert.equal(child.id,d.childId);assert.equal(f.calls,1);assert.equal((await f.app.store.list('workflows')).length,2);
});
test('concurrent starts cannot create two children and lost replies can be safely retried',async t=>{
 const f=await fixture(t),d=await f.preview(),results=await Promise.allSettled([f.f.start(f.input(d)),f.f.start(f.input(d))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);await until(()=>!f.app.workflows.running.size);assert.equal((await f.f.start(f.input(d))).id,d.childId);assert.equal((await f.app.store.list('workflows')).length,2);assert.equal(f.calls,1);
});
test('action preflight rejects a follow-up edit until its own journal contains a fresh observation',async t=>{
 const f=await fixture(t),d=await f.preview(),child=await f.f.start(f.input(d));await until(()=>!f.app.workflows.running.size);const w=await f.app.store.get('workflows',child.id),operation=randomUUID();w.status='running';w.planApprovedRevision=1;w.operations=[{id:operation,name:'propose_file_edit',status:'started',arguments:{}}];await f.app.store.put('workflows',w);
 const input={path:f.file,content:'Final\n',reason:'Selected follow-up'},link={id:w.id,operation,revision:1};await assert.rejects(f.app.actions.propose('write',input,null,undefined,link),/Inspect the current/);assert.equal((await f.app.store.list('actions')).length,0);
 w.operations.unshift({id:randomUUID(),name:'read_system_file',status:'completed',result:await f.app.system.read(f.file)});await f.app.store.put('workflows',w);const a=await f.app.actions.propose('write',input,null,undefined,link);assert.equal(a.status,'pending');assert.equal(await readFile(f.file,'utf8'),'Current external content\n');
});
test('follow-up write routes require the app token and preview does not start inference',async t=>{
 const f=await fixture(t);await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>f.app.server.close(resolve)));const base='http://127.0.0.1:'+f.app.server.address().port,boot=await(await fetch(base+'/api/bootstrap')).json();
 for(const op of ['preview','save','discard','start'])assert.equal((await fetch(base+'/api/workflow-followup-'+op,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 const c=await(await fetch(base+'/api/workflow-followup-options?id='+f.source.id)).json();const response=await fetch(base+'/api/workflow-followup-preview',{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':boot.token},body:JSON.stringify({sourceId:f.source.id,sourceFingerprint:c.fingerprint,selected:['question']})});assert.equal(response.status,200);assert.equal(f.calls,0);assert.equal((await f.app.store.list('workflows')).length,1);
});
