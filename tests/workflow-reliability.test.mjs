import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {workflowHealth,unverifiedWrites} from '../src/workflow-health.mjs';
import {verifyOutcome,missingOutcomes,evidenceHandle,resolveEvidence,evidenceView} from '../src/workflow-evidence.mjs';

const reports=[],call=(name,args)=>({content:'',tool_calls:[{function:{name,arguments:args}}]});
const context=m=>JSON.parse(m.at(-1).content),ops=m=>context(m).recentEvidence.map(JSON.parse);
const finish=m=>call('finish_step',{summary:'Observed and checked the result.',evidence:context(m).evidenceForCompletion.map(o=>o.id)});
const until=async(fn,label='condition')=>{const end=Date.now()+6000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw new Error('Timeout: '+label);};
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function scenario(name,fn){test(name,async t=>{const start=Date.now();try{const details=await fn(t);reports.push({scenario:name,ok:true,milliseconds:Date.now()-start,...details});}catch(e){reports.push({scenario:name,ok:false,error:e.message});throw e;}});}
after(async()=>{await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});await writeFile(new URL('../artifacts/reliability-benchmark.json',import.meta.url),JSON.stringify({kind:'deterministic executor fixtures; real filesystem and command execution where stated; not a model success rate',scenarios:reports},null,2));});
async function fixture(t,respond,options={}){
  const dir=await mkdtemp(join(tmpdir(),'aurora-reliability-')),project=join(dir,'project');await mkdir(project);
  const model={model:'fixture',generationOptions:{think:false},check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,_tools,signal,_chunk,opts)=>{signal.throwIfAborted();if(opts?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Complete the fixture task',check:'Observe the requested outcome.'}]})};return respond(m,{project,signal});}};
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:model,workflowOptions:{pollMs:10,segmentMs:10000},...options});
  t.after(async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);await rm(dir,{recursive:true,force:true});});
  app.get=id=>app.store.get('workflows',id);app.wait=async(id,state)=>until(async()=>{const w=await app.get(id);return w.status===state&&!app.workflows.running.has(id)?w:null;},state);
  app.pending=async id=>until(async()=>{const a=(await app.store.list('actions')).find(a=>a.workflow?.id===id&&a.status==='pending');return a&&!app.workflows.running.has(id)?a:null;},'pending action');
  app.approve=async id=>{const a=await app.pending(id);await app.actions.decide(a.id,'approve',a.digest);return a;};
  return Object.assign(app,{dir,project});
}

scenario('project edit → real Node tests → explicit command outcome',async t=>{
  let rejectedPremature=false;
  const f=await fixture(t,(m,{project})=>{const last=ops(m).at(-1);
    if(!last)return call('propose_file_edit',{path:join(project,'math.mjs'),content:'export const add=(a,b)=>a+b;\n',reason:'Fix the fixture'});
    if(last.name==='propose_file_edit')return call('read_system_file',{path:join(project,'math.mjs')});
    if(last.name==='read_system_file'&&!context(m).outcomeChecksNeeded.some(x=>x.group==='command'))return call('propose_command',{program:'node',args:['--test','math.test.mjs'],cwd:project,reason:'Run the fixture tests'});
    if(last.name==='finish_step'&&last.status==='failed'&&context(m).readbackNeeded.length)return call('read_system_file',{path:join(project,'math.mjs')});
    if(last.name==='finish_step'&&last.status==='failed'){rejectedPremature=true;assert.match(last.result.error,/command/);const check=context(m).outcomeChecksNeeded.find(x=>x.group==='command');return call('verify_outcome',{kind:'command_output',evidence:check.availableObservation.evidence,expected:'pass 2'});}
    return finish(m);
  });
  await writeFile(join(f.project,'math.mjs'),'export const add=(a,b)=>a-b;\n');
  await writeFile(join(f.project,'math.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {add} from './math.mjs';test('positive',()=>assert.equal(add(4,3),7));test('negative',()=>assert.equal(add(-2,7),5));\n");
  const w=await f.workflows.start({goal:'Fix addition and verify the actual tests'});await f.approve(w.id);await f.approve(w.id);const done=await f.wait(w.id,'completed');
  assert(rejectedPremature);assert.equal(done.version,34);assert.match(done.operations.find(o=>o.name==='propose_command').result.content,/pass 2/);assert.deepEqual(missingOutcomes(done),[]);
  assert.equal((await f.workflows.read(w.id)).health.code,'completed');
  return {calls:done.calls,operations:done.operations.length,approvals:2,actualCommand:true,trace:done.operations};
});

scenario('newer page, window, screen and file observations invalidate older successful checks',async()=>{
  for(const [group,kind,old,changed] of [
    ['browser','browser_title',{name:'computer_action',arguments:{operation:'open_url'},result:{url:'https://example.com',title:'Wanted',text:'Wanted'}},{name:'computer_action',arguments:{operation:'browser_read'},result:{url:'https://example.com',title:'Changed',text:'Changed'}}],
    ['window','window_title',{name:'computer_action',arguments:{operation:'windows'},result:{windows:[{id:'w1',title:'Wanted'}]}},{name:'computer_action',arguments:{operation:'windows'},result:{windows:[]}}],
    ['screen','screen_text',{name:'inspect_desktop',result:{content:'Wanted'}},{name:'inspect_desktop',result:{content:'Changed'}}]
  ]){
    const w={version:3,operations:[{id:'effect',name:'computer_action',arguments:{operation:group==='window'?'open_path':group==='screen'?'click':'open_url'},status:'completed'},{...old,id:'read',status:'completed'}]};
    const result=verifyOutcome(w,{evidence:'read',kind,expected:'Wanted'});w.operations.push({id:'check',name:'verify_outcome',status:'completed',result});assert.deepEqual(missingOutcomes(w),[]);
    w.operations.push({...changed,id:'new',status:'completed'});assert.throws(()=>verifyOutcome(w,result),/stale/);assert.equal(missingOutcomes(w)[0].group,group);
  }
  const w={operations:[{name:'propose_file_edit',expected:{path:'/fixture',revision:'one'},finished:'2026-01-01T00:00:01Z'},{id:'old',name:'read_system_file',status:'completed',started:'2026-01-01T00:00:02Z',result:{path:'/fixture',revision:'one',content:'Wanted'}},{id:'new',name:'read_system_file',status:'completed',started:'2026-01-01T00:00:03Z',result:{path:'/fixture',revision:'two',content:'Changed'}}]};
  assert.equal(unverifiedWrites(w).length,1);assert.throws(()=>verifyOutcome(w,{evidence:'old',kind:'file_text',expected:'Wanted'}),/stale/);return {contradictionsRejected:4};
});

scenario('command checks reject failures, truncation, wrong output and tests preceding another edit',async()=>{
  const op={id:'cmd',name:'propose_command',status:'completed',result:{code:0,content:'pass 2'}},args={evidence:'cmd',kind:'command_output',expected:'pass 2'};
  assert(verifyOutcome({operations:[op]},args).verified);
  assert.throws(()=>verifyOutcome({operations:[op]},{...args,expected:'pass 2, fail 0'}),e=>e.message.includes('exact contiguous excerpt')&&e.message.includes('Observed value: \"pass 2\"'));
  for(const patch of [{code:1},{truncated:true},{stopped:true},{content:'fail 2'}])assert.throws(()=>verifyOutcome({operations:[{...op,result:{...op.result,...patch}}]},args));
  const w={version:3,operations:[op,{name:'verify_outcome',status:'completed',result:verifyOutcome({operations:[op]},args)},{name:'propose_file_edit',status:'completed',expected:{path:'/project/math.mjs',revision:'new'}}]};
  assert.equal(missingOutcomes(w)[0].group,'command');assert.throws(()=>verifyOutcome(w,args),/predates/);assert.throws(()=>verifyOutcome({operations:[op]},{...args,kind:'command_exit',expected:'1'}),/expected="0"/);
  assert.deepEqual(missingOutcomes({version:2,operations:[op]}),[]);return {invalidChecksRejected:6,legacyTasksPreserved:true};
});

scenario('desktop disconnect after an effect never replays it on reconnect',async t=>{
  const f=await fixture(t,m=>{const latest=ops(m).at(-1),resolved=ops(m).some(o=>o.name==='user_verification');
    if(!latest)return call('computer_action',{operation:'open_path',path:'/fixture.txt',reason:'Open fixture'});
    if(resolved&&!ops(m).some(o=>o.arguments?.operation==='windows'))return call('computer_action',{operation:'windows',reason:'Observe after reconnect'});
    if(latest.arguments?.operation==='windows')return call('verify_outcome',{kind:'window_title',evidence:latest.id,expected:'fixture.txt'});return finish(m);
  });
  // Keep the real transient job/lease protocol. Substitute only the native adapter.
  f.computer.prepare=async p=>p;let lease=f.computer.connect().lease,effects=0,workerError;let polling=false;
  const timer=setInterval(()=>{if(polling)return;polling=true;try{const {job}=f.computer.poll(lease);if(job){if(job.input.operation==='open_path'){effects++;const old=lease;lease=f.computer.connect().lease;assert.throws(()=>f.computer.complete(old,job.id,{content:'late result'}),/expired/);}else f.computer.complete(lease,job.id,{windows:[{id:'editor',title:'fixture.txt'}]});}}catch(e){workerError=e;}finally{polling=false;}},5);t.after(()=>clearInterval(timer));
  const w=await f.workflows.start({goal:'Open the fixture and verify its window'});await f.wait(w.id,'needs_verification');await f.workflows.tick();assert.equal(effects,1);assert.equal((await f.workflows.read(w.id)).health.code,'needs_verification');
  await f.workflows.control(w.id,'resolve','I checked: the fixture editor opened before the connection was lost.');await f.workflows.control(w.id,'resume');const done=await f.wait(w.id,'completed');assert.equal(effects,1);assert(!workerError,workerError?.message);
  return {effects,replayedEffects:0,desktop:'simulated adapter; real lease/cancellation protocol',trace:done.operations};
});

scenario('stopped action must settle before recovery; paused tasks reconcile its final journal',async t=>{
  const gate=defer();t.after(gate.resolve);let executing=false;
  const f=await fixture(t,(_m,{project})=>call('propose_command',{program:'printf',args:['fixture'],cwd:project,reason:'Fixture'}),{executeCommand:async(_p,{signal})=>{executing=true;await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await gate.promise;return {code:null,stopped:true,content:'Stopped fixture'};}});
  const w=await f.workflows.start({goal:'Run fixture'});await f.approve(w.id);await until(()=>executing);await f.workflows.control(w.id,'pause');
  assert.equal((await f.workflows.read(w.id)).health.code,'action_running');await assert.rejects(f.workflows.control(w.id,'resume'),/Wait for the stopped action/);await assert.rejects(f.workflows.control(w.id,'resolve','I checked the result.'),/Wait for the stopped action/);
  gate.resolve();await f.wait(w.id,'needs_verification');assert.equal((await f.workflows.read(w.id)).health.choices[0].id,'verify');assert.equal((await f.store.list('actions')).length,1);return {replayedEffects:0};
});

scenario('expired approval discovered by Resume is saved and recovery becomes available',async t=>{
  const f=await fixture(t,(_m,{project})=>call('propose_file_edit',{path:join(project,'note.md'),content:'Requested note',reason:'Fixture'}));
  const w=await f.workflows.start({goal:'Save fixture note'}),a=await f.pending(w.id);await f.workflows.control(w.id,'pause');clearInterval(f.workflows.timer);
  a.expires='2000-01-01T00:00:00Z';await f.store.put('actions',a);
  await assert.rejects(f.workflows.control(w.id,'resume'),/observation/);const saved=await f.workflows.read(w.id);assert.equal(saved.status,'needs_verification');assert.equal(saved.health.choices[0].id,'verify');
  await f.workflows.control(w.id,'resolve','I checked the target. The new file does not exist.');assert.equal((await f.get(w.id)).status,'paused');return {expiredApprovalRetired:true};
});

scenario('local time limit gives a specific explanation and no automatic restart',async t=>{
  const f=await fixture(t,async(_m,{signal})=>new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}),{workflowOptions:{pollMs:10,segmentMs:80}});
  const w=await f.workflows.start({goal:'Wait for fixture'}),saved=await f.wait(w.id,'paused');assert.equal(saved.pauseReason.kind,'time_limit');assert.match(saved.error,/time limit/);await f.workflows.tick();assert.equal(f.workflows.running.size,0);return {automaticRetries:0};
});

test('health is a read-only projection, distinguishes slow reasoning from approval, and excludes claims/advice',()=>{
  const w={id:'task',status:'running',updated:'2026-01-01T00:00:00Z',activity:{phase:'reasoning',since:'2026-01-01T00:00:00Z'},steps:[{title:'Check result',status:'running'}],current:0,calls:3,activeMs:0,operations:[{id:'read',name:'read_system_file',status:'completed',result:{path:'/fixture'}},{id:'claim',name:'finish_step',status:'completed',result:{content:'Invented claim'}},{id:'cloud',name:'consult_cloud',status:'completed',result:{content:'Advice'}}]};
  const original=JSON.stringify(w),now=Date.parse('2026-01-01T00:04:00Z'),h=workflowHealth(w,{now,runner:{startedAt:now-240000}});assert.equal(h.code,'slow');assert.equal(h.lastObserved.id,'read');assert.equal(h.wait.seconds,240);assert.deepEqual(h.choices.map(c=>c.id),['pause']);assert.equal(JSON.stringify(w),original);
  const approval=workflowHealth({...w,status:'waiting_approval'},{now,actions:[{id:'a',workflow:{id:w.id},status:'pending',expires:'2026-01-02'}]});assert.equal(approval.code,'approval');assert.equal(approval.wait,null);assert.equal(approval.choices[0].action,'a');
  const settling=workflowHealth({...w,status:'waiting_approval'},{now,actions:[{id:'a',workflow:{id:w.id},status:'completed'}]});assert.equal(settling.code,'reconciling');assert.deepEqual(settling.choices.map(c=>c.id),['pause']);
  const limited=workflowHealth({...w,status:'paused',calls:48});assert.equal(limited.code,'limit');assert(!limited.choices.some(c=>c.id==='resume'));assert.equal(limited.choices[0].id,'follow_up');
  const finalCall=workflowHealth({...w,calls:48},{now,runner:{startedAt:now-240000}});assert.equal(finalCall.choices[0].id,'pause');assert(!finalCall.choices.some(c=>c.id==='follow_up'));
});

test('health explains queued work, questions, missing desktop and model changes',()=>{
  const w={id:'task',status:'queued',steps:[],operations:[],current:0,calls:0,activeMs:0,model:'one',generation:{think:true}};
  assert.match(workflowHealth(w,{busy:true}).headline,/Waiting for the local model/);
  assert.equal(workflowHealth({...w,status:'paused',question:'Which file?'}).choices[0].id,'update');
  assert.equal(workflowHealth({...w,status:'paused'},{model:'two',generation:{think:true}}).code,'model_changed');
  const h=workflowHealth({...w,status:'needs_verification',operations:[{id:'f',name:'computer_action',status:'failed'}]},{desktop:{enabled:true,online:false}});assert.deepEqual(h.choices.map(c=>c.id),['verify','desktop']);
  const complete=workflowHealth({...w,status:'completed',calls:48});assert.equal(complete.code,'completed');assert.deepEqual(complete.choices,[]);
});

test('short evidence handles are exact, stable and cannot turn failed records into proof',()=>{
  const w={operations:[{id:'first-record',name:'read_system_file',status:'completed',result:{path:'/fixture',content:'Observed'}},{id:'failed-record',name:'read_system_file',status:'failed',result:{error:'No observation'}}]};
  assert.equal(evidenceHandle(w,'first-record'),'E1');assert.equal(resolveEvidence(w,'E1'),'first-record');
  assert.equal(verifyOutcome(w,{evidence:'E1',kind:'file_text',expected:'Observed'}).evidence,'first-record');
  for(const evidence of ['E2','E3','E01','e1','E0','first-recor'])assert.throws(()=>verifyOutcome(w,{evidence,kind:'file_text',expected:'Observed'}),/successful observation/);
  w.operations.push({id:'later',name:'verify_outcome',arguments:{evidence:'first-record'},result:{evidence:'first-record'}});
  w.operations[1].status='superseded';const restored=JSON.parse(JSON.stringify(w));assert.equal(resolveEvidence(restored,'E1'),'first-record');assert.equal(evidenceHandle(restored,'later'),'E3');
  const view=evidenceView(restored,restored.operations[2]);assert.equal(view.arguments.evidence,'E1');assert.equal(view.result.evidence,'E1');assert.equal(restored.operations[2].result.evidence,'first-record');
});
