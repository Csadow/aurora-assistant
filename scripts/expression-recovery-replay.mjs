// Bounded live argument-recovery replay, not an end-to-end workflow score.
// Observations are retained fixture snapshots; no tools perform laptop actions.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {Ollama} from '../src/ollama.mjs';
import {sha} from '../src/vault.mjs';
import {Workflows} from '../src/workflows.mjs';
import {bindRepairExpression} from '../src/repair-expression-binding.mjs';
import {checkRepairExpression} from '../src/workflow-repair-plan.mjs';
import {focusedRequest,focusedProjectPrompt} from '../src/workflow-project-context.mjs';
import {diagnosisCases} from './repair-diagnosis-cases.mjs';
const automatic=process.argv.includes('--bound');
const root=new URL('../',import.meta.url),fixtures=JSON.parse(await readFile(new URL('tests/fixtures/expression-feedback-replays.json',root))),goal=(await diagnosisCases())[0].input.goal;
const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
const selected=await get('local-model');assert.equal(selected.model,'qwen3.5:9b');assert(selected.thinking);assert.equal((await get('embodiment')).phase,'idle');assert(!(await get('workflows')).some(w=>['planning','running','queued'].includes(w.status)));assert(!(await get('actions')).some(a=>a.status==='running'));assert(!(await get('agents')).runs.some(r=>['running','queued'].includes(r.status)));
const client=new Ollama('http://127.0.0.1:11434',selected.model);client.generationOptions=selected.generation;await client.check();
const paths=[...(await readdir(new URL('src/',root))).filter(p=>p.endsWith('.mjs')).map(p=>'src/'+p),'scripts/expression-recovery-replay.mjs','scripts/repair-diagnosis-cases.mjs','tests/fixtures/expression-feedback-replays.json','desktop/placement.mjs','desktop/quick-window.mjs','tests/quick-window.test.mjs'];
const source=Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(new URL(p,root)))]))),started=new Date().toISOString(),report={started,model:selected.model,generation:selected.generation,source,bindingMode:automatic?'saved_expression':'explicit_expression',cases:[],notice:'Three retained argument failures. One constrained recovery response per case, no action tools. Corrected argument syntax and preservation of the original numerical examples are scored separately; neither is full task completion.'},file=new URL('artifacts/'+(automatic?'expression-binding-recovery-':'expression-recovery-')+started.replaceAll(/[:.]/g,'-')+'.json',root),save=()=>writeFile(file,JSON.stringify(report,null,2));
await save();
for(const c of fixtures){
 const at=Date.now(),w=structuredClone(c.workflow);Object.assign(w,{goal,scope:'Only /tmp/expression-replay/project; preserve all other code and tests.',steps:[{id:'replay',title:'Repair and verify the two geometry regressions',check:goal,status:'running'}],current:0,directives:[]});
 if(automatic){w.version=9;for(const op of w.operations.filter(o=>o.name==='record_repair_plan'))for(const r of op.result.repairs){const read=w.operations[Number(r.evidence.slice(1))-1];r.expressionBinding=bindRepairExpression({content:read.result.content,line:r.line,before:r.before,after:r.after});}}
 const rejected=automatic?{repair:c.arguments.repair,cases:c.arguments.cases}:c.arguments;
 const op={id:'rejected-calculation',name:'check_repair_expression',revision:w.revision,status:'started',arguments:rejected};w.operations.push(op);
 try{checkRepairExpression(w,rejected);throw Error('Fixture no longer rejects');}catch(e){assert(e.expressionFeedback);op.status='failed';op.result={error:e.message,expressionFeedback:e.expressionFeedback};}
 const runner=Object.create(Workflows.prototype);runner.assistant={projects:{items:[]}};
 const request=focusedRequest(w,{system:focusedProjectPrompt+'\nOffline argument-recovery replay only: correct the last rejected check_repair_expression call. Preserve the original input scenarios and the saved repair. Correct expected values only when the full goal or source warrants it; do not substitute easier examples. Retained observations are fixture data, not current laptop state. Return one corrected calculation call, or explain why it cannot be corrected.',history:runner.executionHistory(w),context:runner.context(w),tools:runner.toolsFor(w).filter(t=>t.function.name==='check_repair_expression')});
 const result={name:c.name,inputBytes:request.inputBytes,feedback:op.result.expressionFeedback,request};let reply;
 try{
  reply=await client.chat(request.messages,request.tools,AbortSignal.timeout(300000));assert.equal(reply.tool_calls?.length,1);assert.equal(reply.tool_calls[0].function.name,'check_repair_expression');const raw=reply.tool_calls[0].function.arguments,args=typeof raw==='string'?JSON.parse(raw):raw;
  assert.equal(args.repair,c.arguments.repair);const checked=checkRepairExpression(w,args);result.arguments=args;result.structurallyValid=true;result.checked=checked;result.metrics=reply.metrics;
  // Independent expectations derive the logical width and margins from each
  // original monitor example; never give these expected corrections to the model.
  const expected=c.arguments.cases.map(example=>{const v=example.inputs;return {width:Math.round((v.transform%2===1?v.height:v.width)/v.scale),left:v.reserved[0],right:v.reserved[2],expected:Math.round((v.transform%2===1?v.height:v.width)/v.scale)-v.reserved[0]-v.reserved[2]};});
  result.preservesScenarios=checked.cases.length===expected.length&&expected.every((e,i)=>{const got=checked.cases[i];return got.inputs.width===e.width&&got.inputs.left===e.left&&got.inputs.right===e.right;});
  result.matchesGoal=checked.cases.length===expected.length&&expected.every((e,i)=>checked.cases[i].expected===e.expected&&checked.cases[i].matches);
 }catch(e){result.error=e.message;result.rawReply=reply;result.metrics=reply?.metrics||e.metrics;result.structurallyValid??=false;result.preservesScenarios??=false;result.matchesGoal??=false;}
 result.seconds=Math.round((Date.now()-at)/1000);report.cases.push(result);await save();console.log(JSON.stringify({case:result.name,valid:result.structurallyValid,preservesScenarios:result.preservesScenarios,matchesGoal:result.matchesGoal,seconds:result.seconds,error:result.error}));
}
report.changedDuringRun=[];for(const [p,digest] of Object.entries(source))if(sha(await readFile(new URL(p,root)))!==digest)report.changedDuringRun.push(p);
report.finished=new Date().toISOString();await save();console.log(file.pathname);if(report.changedDuringRun.length||!report.cases.every(c=>c.structurallyValid&&c.preservesScenarios&&c.matchesGoal))process.exitCode=1;
