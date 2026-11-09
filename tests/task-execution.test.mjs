import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {Workflows} from '../src/workflows.mjs';
import {verifyOutcome,missingOutcomes} from '../src/workflow-evidence.mjs';
const reports=[];
const call=(name,args={})=>({role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]});
const evidence=m=>JSON.parse(m.at(-1).content).recentEvidence.map(JSON.parse);
async function until(fn,label='condition'){const end=Date.now()+6000;while(Date.now()<end){const x=await fn();if(x)return x;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out: '+label);}
function scenario(name,fn){test(name,async t=>{const start=Date.now();try{const stats=await fn(t);reports.push({scenario:name,ok:true,milliseconds:Date.now()-start,...stats});}catch(e){reports.push({scenario:name,ok:false,error:e.message});throw e;}});}
after(async()=>{await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});await writeFile(new URL('../artifacts/task-benchmark.json',import.meta.url),JSON.stringify({kind:'deterministic executor scenarios; not a real-model success rate',scenarios:reports},null,2));});
async function fixture(t,respond,options={}){
  const dir=await mkdtemp(join(tmpdir(),'aurora-execution-')),home=join(dir,'project');await mkdir(home);const path=join(home,'result.txt'),changed=join(home,'changed.txt');await writeFile(path,'original');
  const model={model:'fixture',generationOptions:{think:false},check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,tools,signal,_chunk,opts)=>{signal?.throwIfAborted();if(opts?.format?.properties?.steps)return {content:JSON.stringify({steps:[{title:'Do the remaining work',check:'Observe and verify the intended result'}]})};return respond(m,{path,changed,home,signal,tools,opts});}};
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:model,workflowOptions:{pollMs:10,segmentMs:10000},...options});
  t.after(async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);await rm(dir,{recursive:true,force:true});});
  app.get=id=>app.store.get('workflows',id);app.waiting=id=>until(async()=>{const w=await app.get(id);return w.status==='waiting_approval'&&!app.workflows.running.has(id)&&w.operations.at(-1)?.action&&(await app.store.get('actions',w.operations.at(-1).action)).status==='pending'?w:false;},'approval');
  app.approve=async w=>{const a=await app.store.get('actions',w.operations.at(-1).action);await app.actions.decide(a.id,'approve',a.digest);return a;};
  return Object.assign(app,{dir,home,path,changed});
}
const finish=ops=>call('finish_step',{summary:'Observed the requested result.',evidence:ops.filter(o=>o.status==='completed'&&o.name!=='finish_step').map(o=>o.id).slice(-10)});
const stats=w=>({modelCalls:w.calls,operations:w.operations.length,failedOperations:w.operations.filter(o=>o.status==='failed').length,activeMilliseconds:w.activeMs});

test('premature completion identifies the outstanding browser check and its fresh observation',async t=>{
  const f=await fixture(t,m=>{const ctx=JSON.parse(m.at(-1).content),ops=evidence(m),last=ops.at(-1);
    if(!last)return call('computer_action',{operation:'open_url',url:'https://example.com',reason:'Read the goal page'});
    if(last.name==='finish_step'&&last.status==='failed'){
      const pending=ctx.outcomeChecksNeeded[0];assert.equal(pending.group,'browser');assert.equal(pending.availableObservation.title,'Requested page');assert(last.result.error.includes(pending.availableObservation.evidence));
      return call('verify_outcome',{evidence:pending.availableObservation.evidence,kind:'browser_title',expected:'Requested page'});
    }return finish(ops);
  });
  f.actions.computer={prepare:async p=>p,enabled(){},execute:async()=>({title:'Requested page',url:'https://example.com/',text:'Observed page'})};
  const w=await f.workflows.start({goal:'Read and verify the requested page title'});
  const done=await until(async()=>{const saved=await f.get(w.id);return saved.status==='completed'?saved:false;});assert.equal(done.operations.filter(o=>o.status==='failed').length,1);
  const navigated={operations:[...done.operations,{id:'new',name:'computer_action',status:'completed',arguments:{operation:'browser_click'},result:{content:'Clicked'}}]};
  assert.equal(missingOutcomes(navigated)[0].availableObservation,undefined);
});

test('completion errors identify invalid claims and offer only observed evidence for correction',async t=>{
  const f=await fixture(t,(m,{path})=>{const ctx=JSON.parse(m.at(-1).content),ops=evidence(m),last=ops.at(-1);
    if(!last)return call('read_system_file',{path});
    assert.equal(ctx.currentStep.id,ctx.plan[ctx.current-1].id);assert.equal(ctx.currentStep.number,ctx.current);
    if(ctx.current===1)return finish(ops);
    if(last.status==='completed')return call('finish_step',{summary:'Second step done',evidence:[last.id]});
    assert.equal(last.name,'finish_step');assert(last.result.error.includes('finish_step'));
    assert(m.some(x=>x.role==='tool'&&x.tool_name==='finish_step'&&x.content.includes(last.arguments.evidence[0])));
    assert(ctx.evidenceForCompletion.every(o=>!['finish_step','ask_user'].includes(o.name)));
    return call('finish_step',{summary:'Observed the existing file result.',evidence:[ctx.evidenceForCompletion.find(o=>o.name==='read_system_file').id]});
  });
  const chat=f.assistant.ollama.chat;f.assistant.ollama.chat=(...args)=>args[4]?.format?.properties?.steps?{content:JSON.stringify({steps:[{title:'Read the file',check:'Observe its content'},{title:'Confirm the result',check:'Use the saved observation'}]})}:chat(...args);
  const w=await f.workflows.start({goal:'Read and confirm the fixture'});
  const done=await until(async()=>{const saved=await f.get(w.id);return saved.status==='completed'?saved:false;});
  assert.equal(done.operations.filter(o=>o.status==='failed').length,1);assert.equal(done.current,2);
});

test('failed outcome checks return in native tool history so the model can correct them',async t=>{
  const f=await fixture(t,(m,{path})=>{const ops=evidence(m),last=ops.at(-1);
    if(!last)return call('computer_action',{operation:'open_path',path,reason:'Open the fixture'});
    if(last.arguments.operation==='open_path')return call('computer_action',{operation:'windows',reason:'Observe the editor'});
    if(last.arguments.operation==='windows')return call('verify_outcome',{evidence:last.id,kind:'window_absent',expected:''});
    if(last.status==='failed'){
      assert(m.some(x=>x.role==='tool'&&x.tool_name==='verify_outcome'&&x.content.includes('window_title')&&x.content.includes('failed')));
      return call('verify_outcome',{evidence:ops.find(o=>o.arguments.operation==='windows').id,kind:'window_title',expected:'result.txt'});
    }return finish(ops);
  });
  f.actions.computer={prepare:async p=>p,enabled(){},execute:async p=>p.operation==='windows'?{windows:[{id:'editor',title:'result.txt',app:'Foot'}]}:{content:'Opening requested'}};
  const w=await f.workflows.start({goal:'Open result.txt and check its window'});
  const done=await until(async()=>{const saved=await f.get(w.id);return saved.status==='completed'?saved:false;});
  assert.equal(done.operations.filter(o=>o.status==='failed').length,1);assert.deepEqual(missingOutcomes(done),[]);
});

test('a task finishing while steering waits cannot be reopened or lose its result',async t=>{
  const f=await fixture(t,(m,{path})=>{const ops=evidence(m);return ops.length?finish(ops):call('read_system_file',{path});});
  const put=f.store.put.bind(f.store);let finalizing=false,release;
  const gate=new Promise(r=>{release=r;});t.after(release);
  f.store.put=async(kind,record)=>{if(kind==='workflows'&&record.status==='completed'&&!finalizing){finalizing=true;await gate;}return put(kind,record);};
  const w=await f.workflows.start({goal:'Inspect the fixture'});await until(()=>finalizing);
  f.workflows.running.get(w.id).controller.signal.addEventListener('abort',release,{once:true});
  await assert.rejects(f.workflows.steer(w.id,'Skip that step'),/finished/);
  const saved=await f.get(w.id);assert.equal(saved.status,'completed');assert.equal(saved.revision,1);assert.equal(saved.directives.length,0);assert(saved.result);
});

scenario('1. browser research → reviewed file → open application → verify outcome',async t=>{
  const f=await fixture(t,(m,{path})=>{const ops=evidence(m),last=ops.at(-1);if(!last)return call('computer_action',{operation:'open_url',url:'https://example.com',reason:'Read source'});
    if(last.arguments.operation==='open_url')return call('verify_outcome',{evidence:last.id,kind:'browser_title',expected:'Fixture research'});
    if(last.name==='verify_outcome'&&last.arguments.kind==='browser_title')return call('propose_file_edit',{path,content:'Grounded research result',reason:'Save requested summary'});
    if(last.name==='propose_file_edit')return call('read_system_file',{path});if(last.name==='read_system_file')return call('computer_action',{operation:'open_path',path,reason:'Open for review'});
    if(last.arguments.operation==='open_path')return call('computer_action',{operation:'windows',reason:'Check the opened note'});
    if(last.arguments.operation==='windows')return call('verify_outcome',{evidence:last.id,kind:'window_title',expected:'result.txt'});return finish(ops);});
  const executed=[];f.actions.computer={prepare:async p=>p,enabled(){},execute:async p=>{executed.push(p.operation);return p.operation==='open_url'?{url:'https://example.com/',title:'Fixture research',text:'Grounded research result',revision:'page-1'}:p.operation==='windows'?{windows:[{id:'note-1',app:'Editor',title:'result.txt'}]}:{content:'Requested file opening'};}};
  const w=await f.workflows.start({goal:'Research the fixture, save and open a note'});await f.approve(await f.waiting(w.id));const done=await until(async()=>{const saved=await f.get(w.id);return saved.status==='completed'?saved:false;});assert.equal(await readFile(f.path,'utf8'),'Grounded research result');assert.deepEqual(executed,['open_url','open_path','windows']);assert.deepEqual(missingOutcomes(done),[]);return {...stats(done),humanApprovals:1};
});

scenario('2. destination change retires the old approval and writes only the new file',async t=>{
  const f=await fixture(t,(m,{path,changed})=>{const ctx=JSON.parse(m.at(-1).content),ops=evidence(m),last=ops.at(-1),target=ctx.updates.length?changed:path;
    if(!last||last.status==='superseded')return call('propose_file_edit',{path:target,content:'correct destination',reason:'Requested result'});
    if(last.name==='propose_file_edit')return call('read_system_file',{path:target});return finish(ops);});
  const w=await f.workflows.start({goal:'Save the result'}),old=await f.waiting(w.id),a=await f.store.get('actions',old.operations[0].action);
  await f.workflows.steer(w.id,'Use '+f.changed+' instead',1);await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/already/);
  const pending=await f.waiting(w.id);assert.equal(pending.revision,2);assert.equal(pending.directives[0].targetStep.title,'Do the remaining work');assert.equal(pending.planHistory.length,1);await f.approve(pending);
  const done=await until(async()=>{const saved=await f.get(w.id);return saved.status==='completed'?saved:false;});assert.equal(await readFile(f.path,'utf8'),'original');assert.equal(await readFile(f.changed,'utf8'),'correct destination');return {...stats(done),humanApprovals:1,retiredApprovals:1};
});

scenario('3. an update interrupts thinking and preserves completed work',async t=>{
  let entered=false;const f=await fixture(t,async(m,{path,signal})=>{const ctx=JSON.parse(m.at(-1).content),ops=evidence(m);if(ctx.updates.length){if(!ops.some(o=>o.name==='read_system_file'))return call('read_system_file',{path});return finish(ops);}entered=true;await new Promise((_,reject)=>{if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});});
  const c=await f.store.conversation(),w=await f.workflows.start({goal:'Inspect the fixture',conversation:c.id});await until(()=>entered);
  // A completed step is a durable prior accomplishment, retained in the new plan.
  await f.workflows.control(w.id,'pause');const saved=await f.get(w.id);saved.steps.unshift({id:'prior',title:'Existing work',check:'Observed',status:'completed',summary:'Already completed'});saved.current=1;await f.store.put('workflows',saved);
  await f.workflows.control(w.id,'resume');await until(()=>f.assistant.busy.size>0);
  const events=[];await f.assistant.chat({id:c.id,workflowId:w.id,message:'Only inspect the file now',mode:'steer'},new AbortController().signal,e=>events.push(e));
  assert.equal(events.at(-1).type,'done');const done=await until(async()=>{const saved=await f.get(w.id);return saved.status==='completed'?saved:false;});assert.equal(done.steps[0].id,'prior');assert.equal(done.steps[0].summary,'Already completed');return stats(done);
});

scenario('4. status and pause work while inference is busy and respect conversation ownership',async t=>{
  const f=await fixture(t,async(_m,{signal})=>new Promise((_,reject)=>{if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
  const c=await f.store.conversation(),w=await f.workflows.start({goal:'Inspect fixture',conversation:c.id});await until(()=>f.workflows.running.has(w.id));
  for(const message of ['/status','pause']){const events=[];await f.assistant.chat({id:c.id,workflowId:w.id,message},new AbortController().signal,e=>events.push(e));assert.equal(events.at(-1).type,'done');}
  assert.equal((await f.get(w.id)).status,'paused');const stranger=await f.store.conversation();await assert.rejects(f.assistant.chat({id:stranger.id,workflowId:w.id,message:'/resume'},new AbortController().signal,()=>{}),e=>e.status===403);const limited=await f.get(w.id);limited.calls=48;await f.store.put('workflows',limited);await assert.rejects(f.workflows.steer(w.id,'Try again'),/limit/);return {humanApprovals:0};
});

scenario('5. stale page evidence and mismatched results cannot verify completion',async()=>{
  const read={id:'read',name:'computer_action',status:'completed',arguments:{operation:'browser_read'},result:{url:'https://example.com/',title:'Before',text:'Old value',revision:'v1'}};
  const click={id:'click',name:'computer_action',status:'completed',arguments:{operation:'browser_click'},result:{content:'Clicked'}};
  assert.throws(()=>verifyOutcome({operations:[read,click]},{evidence:'read',kind:'browser_text',expected:'Old value'}),/stale/);
  const fresh={...read,id:'fresh',result:{...read.result,text:'Actual result'}};assert.throws(()=>verifyOutcome({operations:[read,click,fresh]},{evidence:'fresh',kind:'browser_text',expected:'Imaginary result'}),/failed/);
  assert(verifyOutcome({operations:[read,click,fresh]},{evidence:'fresh',kind:'browser_text',expected:'Actual result'}).verified);return {rejectedFalseChecks:2};
});

scenario('6. external file edits survive stale approval and require user verification',async t=>{
  const f=await fixture(t,(_m,{path})=>call('propose_file_edit',{path,content:'assistant edit',reason:'Fixture'}));const w=await f.workflows.start({goal:'Edit fixture'}),pending=await f.waiting(w.id);await writeFile(f.path,'external user change');await f.approve(pending);
  await until(async()=>(await f.get(w.id)).status==='needs_verification');assert.equal(await readFile(f.path,'utf8'),'external user change');await assert.rejects(f.workflows.control(w.id,'resume'),/observation/);assert.equal((await f.store.list('actions')).length,1);return {humanApprovals:1,replayedActions:0};
});

scenario('7. failed commands stop and are never automatically repeated',async t=>{
  let runs=0;const f=await fixture(t,(_m,{home})=>call('propose_command',{program:'printf',args:['fixture'],cwd:home,reason:'Check result'}),{executeCommand:async()=>{runs++;return {code:1,content:'Check failed'};}});
  const w=await f.workflows.start({goal:'Run the fixture check'});await f.approve(await f.waiting(w.id));await until(async()=>(await f.get(w.id)).status==='needs_verification');await f.workflows.tick();await f.workflows.tick();assert.equal(runs,1);return {humanApprovals:1,executions:runs,replayedActions:0};
});

scenario('8. restart during plan update retires approvals once and keeps the task paused',async t=>{
  const f=await fixture(t,(_m,{path})=>call('propose_file_edit',{path,content:'after',reason:'Fixture'}));const w=await f.workflows.start({goal:'Edit fixture'}),pending=await f.waiting(w.id);await f.workflows.close();
  const put=f.store.put.bind(f.store);let crashed=false;f.store.put=async(kind,record)=>{if(kind==='workflows'&&record.revision===2&&!record.pendingSteer&&!crashed){crashed=true;throw new Error('Simulated interruption');}return put(kind,record);};
  await assert.rejects(f.workflows.steer(w.id,'Use a different destination instead'),/Simulated/);f.store.put=put;
  f.workflows=new Workflows({assistant:f.assistant,store:f.store,skills:f.skills,actions:f.actions,pollMs:10});f.assistant.workflows=f.workflows;await f.workflows.init();
  const recovered=await f.get(w.id);assert.equal(recovered.status,'paused');assert.equal(recovered.revision,2);assert.equal(recovered.directives.length,1);assert.equal(recovered.operations[0].status,'superseded');assert.equal((await f.store.get('actions',pending.operations[0].action)).status,'dismissed');assert.equal(await readFile(f.path,'utf8'),'original');return {replayedActions:0,retiredApprovals:1};
});

scenario('9. missing windows and an unclear goal produce a question, not invented success',async t=>{
  const f=await fixture(t,m=>{const ctx=JSON.parse(m.at(-1).content);if(!ctx.updates.length)return call('ask_user',{question:'Which editor should I use for this file?'});return call('ask_user',{question:'I have your preference. Which file should I open?'});});
  const w=await f.workflows.start({goal:'Open my document'});await until(async()=>(await f.get(w.id)).status==='waiting_input'&&!f.workflows.running.has(w.id));await assert.rejects(f.workflows.control(w.id,'resume'),/Answer/);await f.workflows.control(w.id,'pause');await assert.rejects(f.workflows.control(w.id,'resume'),/Answer/);await f.workflows.steer(w.id,'Use the existing editor');await until(async()=>{const saved=await f.get(w.id);return saved.status==='waiting_input'&&saved.revision===2;});
  const windows={id:'windows',name:'computer_action',arguments:{operation:'windows'},status:'completed',result:{windows:[]}};assert.throws(()=>verifyOutcome({operations:[windows]},{evidence:'windows',kind:'window_title',expected:'Imaginary editor'}),/failed/);assert.throws(()=>verifyOutcome({operations:[windows]},{evidence:'windows',kind:'window_absent',expected:'made-up-id'}),/observed/);return {falseCompletion:false};
});

scenario('10. completed work becomes linked memory only after review and is recalled by a later task',async t=>{
  const f=await fixture(t,(m,{path})=>{const ops=evidence(m);return ops.length?finish(ops):call('read_system_file',{path});});await f.vault.save('20 Projects/Fixture.md','# Fixture\nA test project.',null);
  const w=await f.workflows.start({goal:'Inspect the fixture result'});await until(async()=>(await f.get(w.id)).status==='completed');
  const before=(await f.vault.list()).length,draft=await f.workflows.memory(w.id,{});assert.match(draft.body,/Results/);const input={title:'Juniper fixture decision',body:draft.body+'\nThe reviewed juniper decision is amber.',project:'20 Projects/Fixture.md'};
  const proposal=await f.workflows.memory(w.id,input);assert.equal((await f.workflows.memory(w.id,input)).id,proposal.id);assert.equal((await f.vault.list()).length,before);
  await f.assistant.acceptProposal(proposal.id,'accept');const note=await f.vault.read(proposal.path);assert.match(note.content,/\[\[20 Projects\/Fixture\]\]/);
  const next=await f.workflows.start({goal:'Recall the juniper fixture decision and inspect the file'});await until(async()=>(await f.get(next.id)).status==='completed');assert((await f.get(next.id)).memorySources.some(n=>n.path===proposal.path));return {memoryProposals:1,confirmedAfterReview:true};
});
