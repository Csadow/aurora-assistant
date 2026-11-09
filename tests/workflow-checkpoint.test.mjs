import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sha} from '../src/vault.mjs';
import {createApp} from '../src/server.mjs';
import {checkpointProject,projectCheckpointContext,beforeCheckpoint} from '../src/workflow-checkpoint.mjs';
import {requirementStatus} from '../src/workflow-requirements.mjs';
import {verifyOutcome,missingOutcomes} from '../src/workflow-evidence.mjs';
import {unverifiedWrites} from '../src/workflow-health.mjs';
import {fileObservations} from '../src/workflow-tools.mjs';

const command={program:'/usr/bin/node',args:['check.mjs'],cwd:'/fixture',outputIncludes:'passed'};
const fixture=()=>({version:6,status:'paused',project:{checks:[command]},requirements:{files:[{path:'/fixture/a',lineEndings:'lf',finalNewline:'required'}],commands:[command]},operations:[
  {id:'edit',action:'a',name:'propose_file_edit',status:'completed',finished:'2026-01-01',expected:{path:'/fixture/a',revision:sha('good\n')}},
  {id:'check',action:'b',name:'propose_command',status:'completed',command,result:{code:0,content:'passed'}},
  {id:'read',name:'read_system_file',status:'completed',started:'2026-01-02',result:{path:'/fixture/a',content:'good\n',revision:sha('good\n')}},
  {id:'verify',name:'verify_outcome',status:'completed',result:{evidence:'check',kind:'command_output',expected:'passed'}}
]});
test('project checkpoints invalidate old completion evidence without erasing progress or changing requirements',()=>{
  const w=fixture(),before=JSON.stringify({requirements:w.requirements,operations:w.operations});assert(requirementStatus(w).every(c=>c.passed));
  checkpointProject(w,'pause');assert.equal(JSON.stringify({requirements:w.requirements,operations:w.operations}),before);
  assert(requirementStatus(w).every(c=>!c.passed));assert.equal(unverifiedWrites(w).length,1);assert(fileObservations(w).every(x=>x.needsFreshRead&&!x.excerpt));
  for(const [evidence,kind] of [['read','file_text'],['check','command_output']])assert.throws(()=>verifyOutcome(w,{evidence,kind,expected:'good'}),/interruption/);
  assert.equal(missingOutcomes(w)[0].availableObservation,undefined);
  const saved=JSON.stringify(w.projectCheckpoint);checkpointProject(w,'restart');checkpointProject(w,'resume');assert.equal(JSON.stringify(w.projectCheckpoint),saved);
  assert.equal(projectCheckpointContext(w).completedActions,2);
  w.operations.push({...w.operations[1],id:'fresh-check'}, {...w.operations[2],id:'fresh-read'}, {...w.operations[3],id:'fresh-verify',result:{evidence:'fresh-check',kind:'command_output',expected:'passed'}});
  assert(requirementStatus(w).every(c=>c.passed));assert.deepEqual(unverifiedWrites(w),[]);assert.deepEqual(missingOutcomes(w),[]);
  checkpointProject(w,'pause');assert(requirementStatus(w).every(c=>!c.passed));
});
test('legacy, completed and unbound tasks keep their completion contract; pending approvals are not rewritten',()=>{
  for(const change of [{version:5},{project:null},{requirements:{files:[],commands:[]}},{status:'completed'},{status:'cancelled'}]){const w={...fixture(),...change};checkpointProject(w,'restart');assert.equal(w.projectCheckpoint,undefined);}
  const w=fixture();w.operations.push({id:'pending',action:'p',name:'propose_file_edit',status:'waiting_approval'});checkpointProject(w,'restart');assert.equal(projectCheckpointContext(w).pendingActions,1);
  w.operations.at(-1).status='completed';assert.equal(projectCheckpointContext(w).pendingActions,1,'checkpoint describes the saved interruption, not a changing count');
});
test('a pending check executed after resume is fresh only for that checkpoint; another pause invalidates it',()=>{
  const w=fixture(),op=w.operations[1];w.operations.splice(2);op.status='waiting_approval';delete op.result;checkpointProject(w,'pause');const old=w.projectCheckpoint.id;
  assert(beforeCheckpoint(w,op));op.status='completed';op.result={code:0,content:'passed'};op.executionCheckpoint=old;
  assert(!beforeCheckpoint(w,op));assert(requirementStatus(w).find(c=>c.kind==='command').passed);
  checkpointProject(w,'pause');assert.notEqual(w.projectCheckpoint.id,old,'same journal length but changed action state needs a new boundary');assert(beforeCheckpoint(w,op));assert(!requirementStatus(w).find(c=>c.kind==='command').passed);
});

const call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});
const until=async fn=>{const end=Date.now()+10000;while(Date.now()<end){const x=await fn();if(x)return x;await new Promise(r=>setTimeout(r,10));}throw Error('Checkpoint fixture timed out');};
test('two-file repair resumes the exact pending edit after backend restart without repeating the first write',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-checkpoint-multi-')),project=join(dir,'project');await mkdir(project);
  const files=['a.txt','b.txt'].map(name=>join(project,name));for(const file of files)await writeFile(file,'before\n');
  await writeFile(join(project,'check.mjs'),"import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';for(const f of ['a.txt','b.txt'])assert.equal(readFileSync(f,'utf8'),'after\\n');console.log('passed both');\n");
  let app,n=0;
  const model={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,_tools,_signal,_c,options)=>{
    assert(!options?.format?.properties.steps,'A bounded project outcome must not be replaced by an inspection-only generated plan');
    const c=JSON.parse(m.at(-1).content);n++;
    if(n<=2)return call('read_system_file',{path:files[n-1]});
    if(n<=4)return call('propose_file_edit',{path:files[n-3],content:'after\n',reason:'Repair observed output'});
    if(n===5){assert.equal(c.projectRecovery.completedEdits.length,1);return call('propose_check',{check:'C1',reason:'Check both outputs'});}
    if(n===6)return call('verify_outcome',{evidence:c.evidenceForCompletion.findLast(o=>o.name==='propose_command').id,kind:'command_output',expected:'passed both'});
    if(n<=8)return call('read_system_file',{path:files[n-7]});
    return call('finish_step',{summary:'Both files corrected and fresh check passed.',evidence:c.evidenceForCompletion.map(o=>o.id)});
  }};
  const boot=()=>createApp({vault:join(dir,'vault'),data:join(dir,'data'),embedding:'',projects:[],ollamaClient:model,workflowOptions:{pollMs:10}});
  const close=async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);};
  app=await boot();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
  const p=await app.projectWorkspaces.save({name:'Two outputs',notePath:'20 Projects/Example Project.md',folders:[project],checks:[{name:'Check',program:'node',args:['check.mjs'],cwd:project,outputIncludes:'passed both'}]});
  const w=await app.workflows.start({goal:'Correct both files to after',projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check'],requirements:{files:files.map(path=>({path,lineEndings:'lf',finalNewline:'required'})),commands:[]}});
  const wait=status=>until(async()=>{const r=await app.workflows.read(w.id);return r.status===status&&!app.workflows.running.has(w.id)?r:null;});
  const pending=()=>until(async()=>{const r=await app.workflows.read(w.id);return r.status==='waiting_approval'&&!app.workflows.running.has(w.id)&&(await app.store.list('actions')).find(a=>a.status==='pending');});
  const approve=async()=>{const a=await pending();await app.actions.decide(a.id,'approve',a.digest);return a;};
  const plan=await wait('plan_review');assert.equal(plan.calls,0);assert.match(plan.steps[0].check,/every required check/);assert.equal(plan.goal,'Correct both files to after');await app.workflows.control(w.id,'approve_plan','',w.revision);const first=await approve(),second=await pending();
  await app.workflows.control(w.id,'pause');const before=await app.workflows.read(w.id);await close();app=await boot();const paused=await wait('paused');
  assert.deepEqual(paused.requirements,before.requirements);assert.deepEqual(paused.steps,before.steps);assert.equal(paused.calls,before.calls);assert.deepEqual(await app.store.get('actions',second.id),second);
  assert.equal((await app.store.get('actions',first.id)).status,'completed');await assert.rejects(app.actions.decide(second.id,'approve',second.digest),/Resume/);
  await app.workflows.control(w.id,'resume');await app.actions.decide(second.id,'approve',second.digest);await approve();const done=await wait('completed');
  assert(done.requirementChecks.every(c=>c.passed));const actions=await app.store.list('actions');assert.equal(actions.length,3);assert.equal(actions.filter(a=>a.kind==='write').length,2);assert(actions.every(a=>a.status==='completed'));
  assert.equal(done.operations.filter(o=>o.action===first.id).length,1);assert.equal(done.operations.filter(o=>o.action===second.id).length,1);
});
for(const externallyChanged of [false,true])test('backend restart requires a fresh real check; externally changed = '+externallyChanged,async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-checkpoint-')),project=join(dir,'project'),file=join(project,'value.txt');await mkdir(project);await writeFile(file,'good\n');
  await writeFile(join(project,'check.mjs'),"import {readFileSync} from 'node:fs';if(readFileSync('value.txt','utf8')!=='good\\n')throw Error('value changed');console.log('passed');\n");
  let app,held=false,resuming=false,n=0;
  const model={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,_tools,signal,_c,options)=>{
    if(options?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Verify project',check:'A fresh check passes.'}]})};
    const c=JSON.parse(m.at(-1).content),evidence=c.evidenceForCompletion.map(o=>o.id);
    if(!resuming){n++;if(n===1)return call('propose_check',{check:'C1',reason:'Check project'});if(n===2)return call('verify_outcome',{evidence:evidence.at(-1),kind:'command_output',expected:'passed'});if(n===3)return call('read_system_file',{path:file});held=true;await new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}
    assert(c.projectRecovery);n++;
    if(n===1)return call('finish_step',{summary:'Attempt to reuse old results',evidence});
    if(n===2){assert(m.some(o=>o.role==='tool'&&o.tool_name==='finish_step'&&JSON.parse(o.content).status==='failed'));return call('read_system_file',{path:file});}
    if(n===3)return call('propose_check',{check:'C1',reason:'Verify current files after restart'});
    if(n===4&&externallyChanged){assert.equal(c.diagnosticCheck.code,1);return call('ask_user',{question:'The file changed while paused; review the failed fresh check.'});}
    if(n===4)return call('verify_outcome',{evidence:c.evidenceForCompletion.findLast(o=>o.name==='propose_command').id,kind:'command_output',expected:'passed'});
    if(n===5)return call('read_system_file',{path:file});return call('finish_step',{summary:'Fresh real check passed',evidence});
  }};
  const boot=()=>createApp({vault:join(dir,'vault'),data:join(dir,'data'),embedding:'',projects:[],ollamaClient:model,workflowOptions:{pollMs:10}});
  const close=async()=>{if(!app)return;await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);};
  t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});app=await boot();
  const p=await app.projectWorkspaces.save({name:'Fixture',notePath:'20 Projects/Example Project.md',folders:[project],checks:[{name:'Check',program:'node',args:['check.mjs'],cwd:project,outputIncludes:'passed'}]});
  const w=await app.workflows.start({goal:'Verify current project',projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check'],requirements:{files:[{path:file,lineEndings:'lf',finalNewline:'required'}],commands:[]}});
  const wait=status=>until(async()=>{const r=await app.workflows.read(w.id);return r.status===status&&!app.workflows.running.has(w.id)?r:null;});
  const approve=async()=>{await wait('waiting_approval');const a=(await app.store.list('actions')).find(a=>a.status==='pending');await app.actions.decide(a.id,'approve',a.digest);};
  await wait('plan_review');await app.workflows.control(w.id,'approve_plan','',w.revision);await approve();await until(()=>held);
  const before=await app.workflows.read(w.id);assert(before.requirementChecks.every(c=>c.passed));await close();resuming=true;n=0;app=await boot();
  const paused=await wait('paused');assert.deepEqual(paused.requirements,before.requirements);assert.deepEqual(paused.project,before.project);assert.equal(paused.calls,before.calls);assert(paused.requirementChecks.every(c=>!c.passed));
  if(externallyChanged)await writeFile(file,'external edit\n');
  await app.workflows.control(w.id,'resume');await approve();const done=await wait(externallyChanged?'waiting_input':'completed');if(externallyChanged){assert(done.requirementChecks.some(c=>!c.passed));assert.equal(done.checkRecoveries.length,1);assert.equal(done.result,undefined);}else assert(done.requirementChecks.every(c=>c.passed));assert.equal((await app.store.list('actions')).length,2);assert.equal(done.operations.filter(o=>o.name==='finish_step'&&o.status==='failed').length,1);
});
