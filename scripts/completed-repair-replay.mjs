// One-response recovery from retained real-model stalls. No action execution,
// invented observations, migrated personal tasks or relaxed acceptance checks.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {Ollama} from '../src/ollama.mjs';
import {sha} from '../src/vault.mjs';
import {Workflows} from '../src/workflows.mjs';
import {focusedRequest,focusedProjectPrompt} from '../src/workflow-project-context.mjs';
import {recordRepairPlan,proposeRepair} from '../src/workflow-repair-plan.mjs';
import {characterIdentity,caringCharacter,Character} from '../src/character.mjs';
const root=new URL('../',import.meta.url),fixture='tests/fixtures/completed-repair-stall.json';
const retained=JSON.parse(await readFile(new URL(fixture,root))),pristine=await readFile(new URL('desktop/quick-window.mjs',root),'utf8');
const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
const selected=await get('local-model');assert.equal(selected.model,'qwen3.5:9b');assert(selected.thinking);assert.equal((await get('embodiment')).phase,'idle');assert(!(await get('workflows')).some(w=>['planning','running','queued'].includes(w.status)));assert(!(await get('actions')).some(a=>a.status==='running'));assert(!(await get('agents')).runs.some(r=>['running','queued'].includes(r.status)));
const client=new Ollama('http://127.0.0.1:11434',selected.model);client.generationOptions=selected.generation;await client.check();
const paths=[...(await readdir(new URL('src/',root))).filter(p=>p.endsWith('.mjs')).map(p=>'src/'+p),'scripts/completed-repair-replay.mjs',fixture,'desktop/quick-window.mjs'];
const source=Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(new URL(p,root)))]))),started=new Date().toISOString(),report={started,model:selected.model,generation:selected.generation,source,cases:[],notice:'Two retained version-9 stalls projected as version-10 tasks. One response with the ordinary tool menu per case. The first still requires a fresh test-file read after the failed command; the second has completed its diagnostic reads. Accept that required read in the first case or the exact outstanding width correction, never a repeated margin edit. Only repair-list validation and patch construction run in memory. This is not full-task completion.'};
const file=new URL('artifacts/completed-repair-replay-'+started.replaceAll(/[:.]/g,'-')+'.json',root),save=()=>writeFile(file,JSON.stringify(report,null,2));await save();
const runner=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
for(const [name,count] of [['after unknown repair ID',13],['after re-listing the completed edit',18]]){
 const w=structuredClone(retained);w.version=10;w.operations=w.operations.slice(0,count);
 const request=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt,history:runner.executionHistory(w),context:runner.context(w),tools:runner.toolsFor(w)}),at=Date.now(),result={name,inputBytes:request.inputBytes,request};
 try{
  const reply=await client.chat(request.messages,request.tools,AbortSignal.timeout(300000));result.reply=reply;result.metrics=reply.metrics;
  assert.equal(reply.tool_calls?.length,1,'One tool response required');const call=reply.tool_calls[0].function;result.tool=call.name;
  const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
  if(call.name==='read_system_file'){
    assert.equal(count,13,'Diagnostic reads are already complete in this snapshot');
    assert.deepEqual(args,{path:w.project.folders[0]+'/tests/quick-window.test.mjs'},'Only this mandatory post-check read advances the first snapshot');
    result.requiredRead=true;result.structurallyValid=true;result.correctRemainingRepair=false;result.nextStepCorrect=true;
  }else{
  assert.equal(call.name,'record_repair_plan','Record the outstanding correction after diagnostic reads');
  const op={id:'replayed-repair',name:'record_repair_plan',revision:w.revision,status:'started',arguments:args};w.operations.push(op);
  op.result=recordRepairPlan(w,args);op.status='completed';result.structurallyValid=true;
  assert.equal(op.result.repairs.length,1,'Only the outstanding width correction');const repair=op.result.repairs[0];
  assert(repair.path.endsWith('/desktop/quick-window.mjs'),'Do not re-list the completed margin edit');
  const patch=proposeRepair(w,{repair:repair.id});assert.equal(patch.edits.length,1);
  const observed=w.operations.findLast(o=>o.name==='read_system_file'&&o.result?.path===repair.path).result.content;
  assert.equal(observed.replace(patch.edits[0].before,patch.edits[0].after),pristine,'Restore only the planted width expression');
  result.correctRemainingRepair=true;result.nextStepCorrect=true;
  }
 }catch(e){result.error=e.message;result.structurallyValid??=false;result.correctRemainingRepair=false;result.nextStepCorrect=false;}
 result.seconds=Math.round((Date.now()-at)/1000);report.cases.push(result);await save();console.log(JSON.stringify({name,tool:result.tool,valid:result.structurallyValid,nextStepCorrect:result.nextStepCorrect,correctRepair:result.correctRemainingRepair,seconds:result.seconds,error:result.error}));
}
report.changedDuringRun=[];for(const [p,digest] of Object.entries(source))if(sha(await readFile(new URL(p,root)))!==digest)report.changedDuringRun.push(p);
report.finished=new Date().toISOString();await save();console.log(file.pathname);if(report.changedDuringRun.length||!report.cases.every(c=>c.nextStepCorrect))process.exitCode=1;
