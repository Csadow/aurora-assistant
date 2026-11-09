import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {routineOperation,validateRoutineContinuation} from '../src/workflow-routine.mjs';
import {projectProgress} from '../src/workflow-project-progress.mjs';
import {sha} from '../src/vault.mjs';
import {Workflows} from '../src/workflows.mjs';
import {focusedRequest,focusedProjectPrompt,routineProjectPrompt} from '../src/workflow-project-context.mjs';
import {characterIdentity,caringCharacter,Character} from '../src/character.mjs';

const call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});
const until=async fn=>{const end=Date.now()+15000;while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,10));}throw Error('Routine fixture timed out');};
async function fixture(t,{respond,broken=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'aurora-routine-')),root=join(dir,'project');await mkdir(root);
 const original='export const value=" BAD ";\n',correct='export const value="good";\n';
 for(const [p,c] of Object.entries({'source.mjs':original,'package.json':'{"type":"module"}\n','test.mjs':`import test from 'node:test';import assert from 'node:assert/strict';import {value} from './source.mjs';test('value',()=>assert.equal(value,'${broken?'other':'good'}'));\n`}))await writeFile(join(root,p),c);
 let calls=0,app;
 const model={model:'fixture',generationOptions:{think:false},check:async()=>{},status:async()=>({online:true,models:[]}),chat:async(messages,tools,signal)=>{
  calls++;const w=(await app.store.list('workflows'))[0];
  if(respond)return respond({w,calls,root,signal,messages,tools});
  if(!w.operations.some(o=>o.name==='record_repair_plan')){
   if(!w.operations.some(o=>o.result?.path===join(root,'test.mjs')))return call('read_system_file',{path:join(root,'test.mjs')});
   return call('record_repair_plan',{repairs:[{file:join(root,'source.mjs'),line:1,before:'" BAD "',after:'"good"',reason:'Meet the requested literal result.'}]});
  }
  const p=projectProgress(w);assert(p.readyToFinish,'routine steps must reach final evidence before another model decision');
  return call('finish_step',{summary:'Saved tests passed; the requested value was read back.',evidence:p.finishEvidence});
 }};
 const config={vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:model,workflowOptions:{pollMs:10,segmentMs:10000}};
 app=await createApp(config);
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,10));app.server.emit('close');await rm(dir,{recursive:true,force:true});});
 const notePath='20 Projects/Routine.md';await app.vault.save(notePath,'# Routine\n',null);
 const project=await app.projectWorkspaces.save({name:'Routine',notePath,folders:[root],checks:[{name:'Tests',program:'node',args:['--test','test.mjs'],cwd:root,outputIncludes:'pass 1'}]});
 const input={goal:'Change the value to good and check the result.',projectId:project.id,projectRevision:project.revision,projectCheckNames:['Tests'],copyBeforeEditCheck:'Tests',routineContinuation:true,requirements:{files:[{path:join(root,'source.mjs'),lineEndings:'lf',finalNewline:'required'}],commands:[]}};
 const w=await app.workflows.start(input);
 const wait=async status=>until(async()=>{const s=await app.store.get('workflows',w.id);return s.status===status&&!app.workflows.running.has(w.id)?s:null;});
 await wait('plan_review');assert.equal(calls,0);assert.equal((await app.store.get('workflows',w.id)).operations.length,0);
 const start=()=>app.workflows.control(w.id,'approve_plan','',w.revision);
 const action=async()=>until(async()=>{const s=await app.store.get('workflows',w.id);if(s.status!=='waiting_approval'||app.workflows.running.has(w.id))return null;const op=s.operations.find(o=>o.status==='waiting_approval');if(!op)return null;const a=await app.store.get('actions',op.action);return a.status==='pending'?a:null;});
 const approve=async a=>{await app.actions.decide(a.id,'approve',a.digest);await until(async()=>!app.actions.running.has(a.id));};
 const restart=async()=>{await app.workflows.close();app.server.emit('close');app=await createApp(config);};
 return {get app(){return app;},get calls(){return calls;},w,input,root,original,correct,wait,start,action,approve,restart};
}

test('routine steps use real scoped reads, reviewed copies/edits/commands, restart and final model judgment',async t=>{
 const f=await fixture(t);await f.start();
 const copy=await f.action();assert.equal(copy.kind,'test_copy');assert.equal(f.calls,2);assert.equal(await readFile(join(f.root,'source.mjs'),'utf8'),f.original);
 await f.approve(copy);const edit=await f.action();assert.equal(edit.kind,'write');assert.equal(f.calls,2);assert.equal(edit.payload.content,f.correct);
 await f.app.workflows.control(f.w.id,'pause');await assert.rejects(f.app.actions.decide(edit.id,'approve',edit.digest),/Resume/);
 await f.restart();assert.equal((await f.app.store.get('actions',edit.id)).status,'pending');await f.app.workflows.control(f.w.id,'resume');
 await f.approve(edit);const command=await f.action();assert.equal(command.kind,'command');assert.equal(f.calls,2);await f.approve(command);
 const done=await f.wait('completed');assert.equal(f.calls,3);assert.equal(done.calls,3);assert(done.operations.filter(o=>o.name==='verify_outcome').every(o=>o.routine));
 assert.equal(done.operations.filter(o=>o.expected).length,1);assert.equal(done.operations.at(-1).name,'finish_step');assert(!done.operations.at(-1).routine);
 assert.equal(await readFile(join(f.root,'source.mjs'),'utf8'),f.correct);assert(projectProgress(done).readyToFinish);
 assert(done.operations.some(o=>o.routine&&o.name==='read_system_file'&&o.result.path===join(f.root,'package.json')),'structured manifest discovery is journaled');
});

test('stale source cannot be applied by an automatically prepared edit',async t=>{
 const f=await fixture(t);await f.start();await f.approve(await f.action());const edit=await f.action();
 await writeFile(join(f.root,'source.mjs'),'export const value="external";\n');
 await assert.rejects(f.app.actions.decide(edit.id,'approve',edit.digest),/changed|current|read|source/i);
 assert.equal(await readFile(join(f.root,'source.mjs'),'utf8'),'export const value="external";\n');assert.equal((await f.app.store.get('actions',edit.id)).status,'pending');
});

test('failed candidate assertions return to diagnosis instead of automatically preparing an edit',async t=>{
 let stage=0;
 const f=await fixture(t,{broken:true,respond:({root,w})=>{
  if(stage++===0)return call('read_system_file',{path:join(root,'test.mjs')});
  if(stage===2)return call('record_repair_plan',{repairs:[{file:join(root,'source.mjs'),line:1,before:'" BAD "',after:'"good"',reason:'Candidate needs real testing.'}]});
  assert(w.operations.find(o=>o.name==='propose_test_copy'&&o.status==='completed').result.runs[1].outcome==='assertion_failure');
  return call('ask_user',{question:'The test expects other but the goal says good. Which result is intended?'});
 }});
 await f.start();await f.approve(await f.action());const w=await f.wait('waiting_input');assert.equal(w.calls,3);assert.match(w.question,/Which result/);assert.equal((await f.app.store.list('actions')).length,1);assert.equal(await readFile(join(f.root,'source.mjs'),'utf8'),f.original);
});

test('routine policy is opt-in, fixed, scoped, and cannot bypass failed observations',()=>{
 const path='/tmp/project/source.mjs';
 const w={version:15,routineContinuation:true,status:'running',planApprovedRevision:1,revision:1,project:{},requirements:{files:[{path}],commands:[{program:'/usr/bin/node',args:['--test','test.mjs'],cwd:'/tmp/project',outputIncludes:'pass 1'}]},operations:[]};
 assert.equal(routineOperation(w).function.name,'read_system_file');
 for(const patch of [{version:14},{routineContinuation:false},{status:'waiting_input'},{status:'paused'},{status:'cancelled'},{planApprovedRevision:null},{revision:2},{projectToolGroup:'files'},{projectToolGroup:'desktop'}])assert.equal(routineOperation({...w,...patch}),null);
 assert.throws(()=>validateRoutineContinuation('true',w));assert.throws(()=>validateRoutineContinuation(true,{...w,project:null}));
 const next=routineOperation(w);w.operations.push({id:'read',name:'read_system_file',arguments:{path},status:'completed',routine:next.routine,result:{path,content:'excerpt',revision:sha('full'),truncated:true}});
 assert.equal(routineOperation(w),null,'a truncated read cannot loop automatically');
 w.operations.at(-1).status='failed';assert.equal(routineOperation(w),null);
});

test('ordinary failed checks return to diagnosis and never become a pass from their marker alone',async t=>{
 let turn=0;
 const f=await fixture(t,{respond:({w})=>{
  if(turn++===0)return call('propose_check',{check:'C1',reason:'Inspect the existing failing assertions.'});
  assert(w.operations.some(o=>o.name==='propose_command'&&o.status==='failed'));
  assert(!w.operations.some(o=>o.name==='verify_outcome'));assert(!projectProgress(w).readyToFinish);
  return call('request_help',{reason:'Needs diagnosis',question:'The original assertion failed. Review the intended behavior.'});
 }});
 await f.start();await f.approve(await f.action());const w=await f.wait('needs_help');assert.equal((await f.app.store.list('actions')).length,1);assert.equal(w.calls,2);
});

test('cancellation during a routine read preserves the attempt and creates no action',async t=>{
 const f=await fixture(t);let began;const started=new Promise(r=>began=r);
 const original=f.app.assistant.runTool.bind(f.app.assistant);
 f.app.assistant.runTool=async(c,id,signal)=>{if(c.function.name==='read_system_file'){began();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}));}return original(c,id,signal);};
 await f.start();await started;await f.app.workflows.control(f.w.id,'cancel');const w=await f.wait('cancelled');assert.equal(f.calls,0);assert.equal(w.operations.length,1);assert.equal(w.operations[0].status,'interrupted');assert.equal((await f.app.store.list('actions')).length,0);
});

for(const limit of ['calls','operations'])test('routine continuation respects the '+limit+' budget',async t=>{
 const f=await fixture(t),w=await f.app.store.get('workflows',f.w.id);
 if(limit==='calls')w.calls=48;else w.operations=Array.from({length:72},(_,i)=>({id:'existing-'+i,name:'ask_user',status:'completed',revision:1}));
 await f.app.workflows.save(w);await assert.rejects(f.start(),/reached its limit/);assert.equal(f.calls,0);assert.equal((await f.app.store.list('actions')).length,0);
});


test('retained routine overflow fits the same input limit with source and full contract intact',async()=>{
 const {cases}=JSON.parse(await readFile(new URL('fixtures/routine-continuation-replays.json',import.meta.url)));
 const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
 const w=cases.find(c=>c.id==='layout').record,before=JSON.stringify(w);
 const input=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt+routineProjectPrompt,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)}),c=JSON.parse(input.messages.at(-1).content);
 assert(input.inputBytes<=24000);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);assert.equal(JSON.stringify(w),before);
 assert(c.fileObservations.filter(f=>!f.inRecentToolResult).every(f=>f.excerpt&&f.truncated===false),'small complete files remain readable');
 const paths=c.evidenceForCompletion.filter(e=>e.name==='read_system_file').map(e=>e.path);assert.equal(new Set(paths).size,paths.length);
 const copy=JSON.parse(input.messages.find(m=>m.tool_name==='propose_test_copy').content).result;
 assert.deepEqual(copy.runs.map(r=>r.outcome),['assertion_failure','assertion_failure']);assert(copy.runs.every(r=>r.truncated===false));
});
