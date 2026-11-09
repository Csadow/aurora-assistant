// Exercise the real reviewed copy path, then ask the selected local model
// for its next step at the version-33 sole-partial decision point. With
// --continue, carry a complete revised plan through strictly scoped reviews.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';
import {recordRepairPlan} from '../src/workflow-repair-plan.mjs';
import {bindCopyRequirement} from '../src/workflow-test-copy.mjs';
import {projectProgress} from '../src/workflow-project-progress.mjs';
import {focusedRequest,focusedProjectPrompt,projectCompletionPrompt,localReadOnlyGroupPrompt} from '../src/workflow-project-context.mjs';
import {characterIdentity} from '../src/character.mjs';

const options=process.argv.slice(2),automatic=options.includes('--automatic'),continueAfterPlan=options.includes('--continue')||automatic,reports=options.filter(option=>!['--continue','--automatic'].includes(option));
const name=reports[0]||'sole-partial-project-live-results.json';
if(reports.length>1||options.filter(option=>['--continue','--automatic'].includes(option)).length>1||!/^[a-z0-9][a-z0-9.-]*\.json$/.test(name))throw Error('Supply --continue or --automatic and one safe report filename under artifacts.');
const directory=await mkdtemp(join(tmpdir(),'aurora-sole-partial-live-'));
const root=join(directory,'project'),data=join(directory,'data'),target=join(root,'fit.mjs');
const text={
 'fit.mjs':'export const fit=(width,area)=>Math.max(width,area);\nexport const duration=(start,end)=>end-start||1;\n',
 'fit.test.mjs':`import test from 'node:test';import assert from 'node:assert/strict';import {fit,duration} from './fit.mjs';
test('small width stays small',()=>assert.equal(fit(700,1280),700));
test('large width fits area',()=>assert.equal(fit(460,320),320));
test('zero duration remains zero',()=>assert.equal(duration(9,9),0));\n`,
 'package.json':'{"type":"module"}\n'
};
const nextSource=source=>[
 source.replace('Math.max(width,area)','Math.min(width,area)'),
 ...['end-start','end-start||0','(end===start?0:end-start)'].map(expression=>source.replace('end-start||1',expression))
].filter(candidate=>candidate!==source);
const validFinalSource=source=>source.includes('Math.min(width,area)')&&['end-start','end-start||0','(end===start?0:end-start)'].some(expression=>source===text['fit.mjs'].replace('Math.max(width,area)','Math.min(width,area)').replace('end-start||1',expression));
const report={date:new Date().toISOString(),model:'qwen3.5:9b',thinking:true,continueAfterPlan,automatic,copyApprovals:0,writeApprovals:0,checkApprovals:0,originalEdits:0,ok:false};
let app;
const wait=async fn=>{const end=Date.now()+30000;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,30));}throw Error('Reviewed copy timed out.');};
try{
 await mkdir(root);await mkdir(data);for(const [file,content] of Object.entries(text))await writeFile(join(root,file),content);
 const get=async path=>{const response=await fetch('http://127.0.0.1:4717'+path,{signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);return response.json();};
 const selected=await get('/api/local-model');assert.equal(selected.model,report.model);assert.equal(selected.thinking,true);
 assert.equal((await get('/api/embodiment')).phase,'idle');assert(!(await get('/api/workflows')).some(w=>['planning','running','queued'].includes(w.status)));
 const client=new Ollama('http://127.0.0.1:11434',report.model);client.generationOptions=selected.generation;
 app=await createApp({vault:join(directory,'vault'),data,backups:join(directory,'backups'),desktopProfile:join(directory,'profile'),projects:[],embedding:'',ollamaClient:client,workflowOptions:{pollMs:100000}});clearInterval(app.workflows.timer);
 const allowed=app.system.allowed.bind(app.system);app.system.allowed=path=>{assert(path===root||path.startsWith(root+'/'),'Only the disposable project may be opened');return allowed(path);};
 const notePath='20 Projects/Sole partial trial.md';await app.vault.save(notePath,'# Sole partial trial\n',null);
 const project=await app.projectWorkspaces.save({name:'Sole partial trial',notePath,folders:[root],checks:[{name:'Fit tests',program:'node',args:['--test','fit.test.mjs'],cwd:root,outputIncludes:'pass 3'}]});
 const now=new Date().toISOString(),w={id:randomUUID(),version:33,engine:'local',revision:1,status:'running',created:now,updated:now,goal:'Repair the fit helper so both width examples fit the available area and zero duration stays zero. Use observed source and saved tests, test an exact candidate in a temporary copy, then make only reviewed edits and check the original project.',scope:`Only ${target} in the disposable project may be edited.`,project,requirements:{files:[{path:target,lineEndings:'lf',finalNewline:'required'}],commands:project.checks.map(({name,...check})=>check)},model:report.model,generation:{...app.assistant.ollama.generationOptions},steps:[{id:randomUUID(),status:'running',title:'Repair the helper',check:'Saved tests and final readback'}],current:0,operations:[],calls:0,activeMs:0,skills:[],directives:[],memorySources:[],memoryRevision:1,projectToolGroup:'project'};
 w.copyBeforeEdit=bindCopyRequirement('Fit tests',project,w.requirements);
 for(const file of Object.keys(text)){const path=join(root,file);w.operations.push({id:randomUUID(),revision:1,name:'read_system_file',status:'completed',arguments:{path},result:await app.system.read(path)});}
 const plan={id:randomUUID(),revision:1,step:w.steps[0].id,name:'record_repair_plan',status:'started'};w.operations.push(plan);plan.result=recordRepairPlan(w,{repairs:[{file:target,line:1,before:'Math.max(width,area)',after:'Math.min(width,area)',reason:'Both widths must fit the area.'}]});plan.status='completed';
 await app.workflows.save(w);
 const args={repair:plan.result.repairs[0].id,check:'C1'},copy={id:randomUUID(),revision:1,step:w.steps[0].id,name:'propose_test_copy',arguments:args,status:'started'};w.operations.push(copy);await app.workflows.save(w);
 const action=await app.actions.propose('test_copy',args,null,null,{id:w.id,operation:copy.id,step:w.steps[0].id,revision:1});
 assert.equal(action.payload.root,root);assert.equal(action.payload.candidate.path,target);assert.equal(action.payload.candidate.before,text['fit.mjs']);assert.equal(action.payload.candidate.content,text['fit.mjs'].replace('Math.max','Math.min'));assert.equal(action.payload.check.cwd,root);assert.deepEqual(action.payload.check.args,['--test','fit.test.mjs']);
 for(const file of action.payload.files)assert.equal(file.content,await readFile(file.path,'utf8'));
 copy.action=action.id;copy.status='waiting_approval';w.status='waiting_approval';await app.workflows.save(w);
 await app.actions.decide(action.id,'approve',action.digest);report.copyApprovals++;
 const completed=await wait(async()=>{const a=await app.store.get('actions',action.id);return !app.actions.running.has(action.id)&&a.status!=='running'?a:null;});assert.equal(completed.status,'completed');
 const saved=await app.store.get('workflows',w.id);await app.workflows.reconcile(saved);await app.workflows.save(saved);
 const diagnosis=saved.operations.findLast(op=>op.name==='propose_test_copy'&&op.status==='completed').result.diagnosis;
 report.copy={baseline:diagnosis.baseline.counts,candidate:diagnosis.candidate.counts,stillFailing:diagnosis.stillFailing};
 assert.deepEqual([diagnosis.baseline.counts.fail,diagnosis.candidate.counts.pass,diagnosis.stillFailing],[3,2,1]);
 assert.equal(projectProgress(saved).next.tool,'record_repair_plan');assert.equal(await readFile(target,'utf8'),text['fit.mjs']);
 let first;
 if(!automatic){
  const style=(await app.assistant.character.prompt()).slice(0,1800);
  const system=characterIdentity+style+'\n'+focusedProjectPrompt+projectCompletionPrompt+localReadOnlyGroupPrompt+' Configured projects: '+JSON.stringify(app.assistant.projects.items);
  const request=focusedRequest(saved,{system,history:app.workflows.executionHistory(saved),context:app.workflows.context(saved),tools:app.workflows.toolsFor(saved)});
  report.inputBytes=request.inputBytes;assert(request.inputBytes<=24000);
  const start=Date.now(),reply=await client.chat(request.messages,request.tools,AbortSignal.timeout(180000),undefined,{think:true});report.modelSeconds=Math.round((Date.now()-start)/1000);
  report.toolCalls=reply.tool_calls?.map(call=>({name:call.function.name,arguments:call.function.arguments}))||[];report.content=reply.content;report.metrics=reply.metrics;
  first=report.toolCalls[0];report.revisedPlan=first?.name==='record_repair_plan';
  if(report.revisedPlan){const argumentsObject=typeof first.arguments==='string'?JSON.parse(first.arguments):first.arguments;const trial=structuredClone(saved),proposed={id:randomUUID(),revision:trial.revision,name:'record_repair_plan',status:'started'};trial.operations.push(proposed);try{const result=recordRepairPlan(trial,argumentsObject);proposed.result=result;proposed.status='completed';report.validRevisedPlan=true;report.repairSummary=result.repairs.map(r=>({file:r.file,line:r.line,before:r.before,after:r.after}));report.coverage={width:result.repairs.some(r=>r.line===1&&r.after.includes('Math.min(width,area)')),zeroDuration:result.repairs.some(r=>r.line===2&&!r.after.includes('||1'))};report.completeProposedSet=Object.values(report.coverage).every(Boolean);report.nextAfterRevisedPlan=projectProgress(trial).next.tool;}catch(error){report.validRevisedPlan=false;report.validationError=error.message;}}
 }
 if(continueAfterPlan){
  const state=await app.store.get('workflows',w.id);
  if(!automatic){
   assert(report.completeProposedSet,'The model did not retain both still-needed corrections.');
   assert.equal(report.nextAfterRevisedPlan,'propose_repair');
   const argumentsObject=typeof first.arguments==='string'?JSON.parse(first.arguments):first.arguments;
   const revised={id:randomUUID(),revision:state.revision,step:state.steps[state.current].id,name:'record_repair_plan',arguments:argumentsObject,status:'started',started:new Date().toISOString()};
   state.operations.push(revised);revised.result=recordRepairPlan(state,argumentsObject);revised.status='completed';revised.finished=new Date().toISOString();state.calls++;
   await app.workflows.save(state);
  }
  assert(app.workflows.launch(state));
  const started=Date.now();let previous='';
  while(Date.now()-started<900000){
   const current=await app.store.get('workflows',w.id);report.record=current;
   const progress=JSON.stringify({status:current.status,calls:current.calls,operations:current.operations.length,last:current.operations.at(-1)?.requestedTool||current.operations.at(-1)?.name});
   if(progress!==previous){console.log(progress);previous=progress;}
   if(['completed','paused','needs_help','needs_verification','waiting_input','cancelled'].includes(current.status)&&!app.workflows.running.has(w.id))break;
   if(current.status==='waiting_approval')for(const operation of current.operations.filter(op=>op.status==='waiting_approval'&&op.action)){
    const pending=await app.store.get('actions',operation.action);if(pending.status!=='pending')continue;
    const source=await readFile(target,'utf8'),expected=nextSource(source);
    if(pending.kind==='test_copy'){
     const payload=pending.payload;assert.equal(payload.root,root);assert.equal(payload.candidate.path,target);assert.equal(payload.candidate.before,source);if(!expected.includes(payload.candidate.content)){report.rejectedCandidate={kind:'test_copy',content:payload.candidate.content};throw Error('Copy candidate exceeds the observed source corrections.');}assert.equal(payload.check.cwd,root);assert.equal(payload.check.program,'/usr/bin/node');assert.deepEqual(payload.check.args,['--test','fit.test.mjs']);assert.equal(payload.check.outputIncludes,'pass 3');
     for(const file of payload.files){assert(file.path.startsWith(root+'/'));assert.equal(file.content,await readFile(file.path,'utf8'));}report.copyApprovals++;
    }else if(pending.kind==='write'){
     assert.equal(pending.payload.path,target);assert.equal(pending.payload.before,source);if(!expected.includes(pending.payload.content)){report.rejectedCandidate={kind:'write',content:pending.payload.content};throw Error('Edit exceeds the observed source corrections.');}report.writeApprovals++;
    }else{
     assert.equal(pending.kind,'command');assert.equal(pending.payload.program,'/usr/bin/node');assert.deepEqual(pending.payload.args,['--test','fit.test.mjs']);assert.equal(pending.payload.cwd,root);report.checkApprovals++;
    }
    await app.actions.decide(pending.id,'approve',pending.digest);
   }
   await app.workflows.tick();await new Promise(resolve=>setTimeout(resolve,200));
  }
  const final=await app.store.get('workflows',w.id);report.record=final;report.originalEdits=(await app.store.list('actions')).filter(action=>action.workflow?.id===w.id&&action.kind==='write'&&action.status==='completed').length;
  assert.equal(final.status,'completed',final.error||'The disposable task did not complete.');
  assert.equal(report.originalEdits,2);assert(report.copyApprovals>=2);assert.equal(report.writeApprovals,2);assert(report.checkApprovals>=1);
  const expectedFinal=await readFile(target,'utf8');assert(validFinalSource(expectedFinal));
  const checks=(await app.workflows.read(w.id)).requirementChecks;assert(checks.length>=2&&checks.every(check=>check.passed));
  const lastWrite=final.operations.findLastIndex(operation=>operation.name==='propose_file_edit'&&operation.status==='completed'),lastCommand=final.operations.findLastIndex(operation=>operation.name==='propose_command'&&operation.status==='completed');
  assert(lastCommand>lastWrite);assert.match(final.operations[lastCommand].result.content,/pass 3/);
  assert(final.operations.slice(lastCommand+1).some(operation=>operation.name==='verify_outcome'&&operation.status==='completed'));
  assert(final.operations.slice(lastCommand+1).some(operation=>operation.name==='read_system_file'&&operation.status==='completed'&&operation.result?.path===target&&operation.result?.content===expectedFinal),'Final source readback after the passing check is missing.');
  report.finalChecksPassed=true;report.finalReadback=true;
 }
 report.ok=true;
}catch(error){report.error=error.message;console.error(error.message);process.exitCode=1;}
finally{if(app){report.originalEdits=(await app.store.list('actions').catch(()=>[])).filter(action=>action.kind==='write'&&action.status==='completed').length;await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,30));}report.originalUnchanged=await readFile(target,'utf8').then(content=>content===text['fit.mjs']).catch(()=>false);if(!continueAfterPlan&&!report.originalUnchanged){report.ok=false;report.error??='Disposable original changed outside review';process.exitCode=1;}await writeFile(new URL('../artifacts/'+name,import.meta.url),JSON.stringify(report,null,2));await rm(directory,{recursive:true,force:true});console.log(JSON.stringify({ok:report.ok,copy:report.copy,tool:report.toolCalls?.[0]?.name,validRevisedPlan:report.validRevisedPlan,originalUnchanged:report.originalUnchanged,originalEdits:report.originalEdits,error:report.error}));}
