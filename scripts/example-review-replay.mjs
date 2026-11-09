// Two one-response trials from the retained 1.39 failure. The exact correction
// below is supplied by this isolated user-review fixture, never by the model.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {Ollama} from '../src/ollama.mjs';
import {sha} from '../src/vault.mjs';
import {Workflows} from '../src/workflows.mjs';
import {workflowExampleReview} from '../src/workflow-example-review.mjs';
import {proposeRepair} from '../src/workflow-repair-plan.mjs';
import {focusedRequest,focusedProjectPrompt} from '../src/workflow-project-context.mjs';
import {characterIdentity,caringCharacter,Character} from '../src/character.mjs';
const root=new URL('../',import.meta.url),fixture='tests/fixtures/reviewed-example-stall.json',retained=JSON.parse(await readFile(new URL(fixture,root)));
const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
const selected=await get('local-model');assert.equal(selected.model,'qwen3.5:9b');assert(selected.thinking);assert.equal((await get('embodiment')).phase,'idle');assert(!(await get('workflows')).some(w=>['planning','running','queued'].includes(w.status)));assert(!(await get('actions')).some(a=>a.status==='running'));assert(!(await get('agents')).runs.some(r=>['running','queued'].includes(r.status)));
const client=new Ollama('http://127.0.0.1:11434',selected.model);client.generationOptions=selected.generation;await client.check();
const paths=[...(await readdir(new URL('src/',root))).filter(p=>p.endsWith('.mjs')).map(p=>'src/'+p),'scripts/example-review-replay.mjs',fixture,'desktop/placement.mjs'];
const source=Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(new URL(p,root)))]))),started=new Date().toISOString(),report={started,model:selected.model,generation:selected.generation,source,cases:[],notice:'Two retained failure snapshots projected as version-11 tasks with current source observations. One ordinary tool response each: before review must request_help; after a fixture user reviews exactly width 1280 → 720 against the goal, must stage R4.2 unchanged. No personal workflow is migrated, no file/action executes, no model edits its own expectations. This is a targeted continuation test, not full-task completion or a general diagnosis success rate.'};
const file=new URL('artifacts/example-review-replay-'+started.replaceAll(/[:.]/g,'-')+'.json',root),save=()=>writeFile(file,JSON.stringify(report,null,2));await save();
const runner=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
for(const reviewed of [false,true]){
 const w=structuredClone(retained);w.version=11;w.status='paused';
 if(reviewed){
  const service={running:new Map(),reconciling:new Set(),examplePreviews:new Map(),actions:{system:{read:async path=>w.operations.findLast(o=>o.name==='read_system_file'&&o.result?.path===path).result}},save:async()=>{},read:async()=>w};
  const input={operation:'preview',revision:w.revision,repair:'R4.2',caseId:'X7.1',inputs:{left:10,right:10,width:720},expected:700,reason:'Use logical width 720 from the goal, not the unrelated 1280 screen width.',provenance:{kind:'goal',quote:'720 minus 10 on each side gives 700'}};
  const p=await workflowExampleReview(service,w,input);await workflowExampleReview(service,w,{...input,operation:'apply',token:p.token});report.review=w.operations.at(-1);
 }
 const request=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt,history:runner.executionHistory(w),context:runner.context(w),tools:runner.toolsFor(w)}),at=Date.now(),result={name:reviewed?'after explicit example review':'before example review',inputBytes:request.inputBytes,request};
 try{
  const reply=await client.chat(request.messages,request.tools,AbortSignal.timeout(300000));result.reply=reply;result.metrics=reply.metrics;
  assert.equal(reply.tool_calls?.length,1,'One tool response required');const call=reply.tool_calls[0].function;result.tool=call.name;
  const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
  if(!reviewed){assert.equal(call.name,'request_help','The mistaken example needs explicit user review');assert.equal(typeof args.reason,'string');assert.equal(typeof args.question,'string');}
  else{assert.equal(call.name,'propose_repair','Stage the reviewed remaining repair');assert.deepEqual(args,{repair:'R4.2'});const patch=proposeRepair(w,args),observed=w.operations.findLast(o=>o.name==='read_system_file'&&o.result?.path===patch.path).result.content;assert.equal(observed.replace(patch.edits[0].before,patch.edits[0].after),await readFile(new URL('desktop/placement.mjs',root),'utf8'),'Only the planted margin expression is corrected');}
  result.ok=true;
 }catch(e){result.ok=false;result.error=e.message;}
 result.seconds=Math.round((Date.now()-at)/1000);report.cases.push(result);await save();console.log(JSON.stringify({name:result.name,tool:result.tool,ok:result.ok,seconds:result.seconds,error:result.error}));
}
report.changedDuringRun=[];for(const [p,digest] of Object.entries(source))if(sha(await readFile(new URL(p,root)))!==digest)report.changedDuringRun.push(p);
report.finished=new Date().toISOString();await save();console.log(file.pathname);if(report.changedDuringRun.length||!report.cases.every(c=>c.ok))process.exitCode=1;
