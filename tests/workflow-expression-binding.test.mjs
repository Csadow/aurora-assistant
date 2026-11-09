import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sha} from '../src/vault.mjs';
import {recordRepairPlan,repairPlanContext,checkRepairExpression,proposeRepair} from '../src/workflow-repair-plan.mjs';
import {focusedTools,focusedRequest,focusedProjectPrompt} from '../src/workflow-project-context.mjs';
import {bindRepairExpression} from '../src/repair-expression-binding.mjs';
import {Workflows} from '../src/workflows.mjs';
import {characterIdentity,caringCharacter,Character} from '../src/character.mjs';
const path='/tmp/bound-project/width.mjs',source='const width=Math.max(a,b),height=1;\n';
const read=(content=source,id='read')=>({id,name:'read_system_file',status:'completed',arguments:{path},result:{path,content,revision:sha(content),truncated:false}});
function fixture(before='Math.max',after='Math.min',content=source){
 const w={version:9,revision:1,project:{},requirements:{files:[{path}],commands:[{program:'node'}]},operations:[read(content)]};
 const op={id:'plan',name:'record_repair_plan',revision:1,status:'started'};w.operations.push(op);op.result=recordRepairPlan(w,{repairs:[{file:path,line:1,before,after,reason:'Bound width.'}]});op.status='completed';return w;
}
const args=w=>({repair:repairPlanContext(w).repairs[0].id,cases:[{inputs:{a:700,b:1280},expected:700},{inputs:{a:460,b:320},expected:320}]});
const calculate=(w,a)=>{const op={id:'check'+w.operations.length,name:'check_repair_expression',revision:w.revision,arguments:a,status:'completed'};op.result=checkRepairExpression(w,a);w.operations.push(op);return op.result;};
test('new workflows calculate the saved pair with explicit examples and cannot override it',()=>{
 const w=fixture(),a=args(w),original=JSON.stringify(w),tool=focusedTools(w,[]).find(t=>t.function.name==='check_repair_expression');
 assert.deepEqual(tool.function.parameters.required,['repair','cases']);assert.deepEqual(Object.keys(tool.function.parameters.properties),['repair','cases']);
 const r=checkRepairExpression(w,a);assert.equal(r.binding,'saved_expression');assert.equal(r.before,'Math.max(a,b)');assert.equal(r.after,'Math.min(a,b)');assert(r.examplesMatch);assert.deepEqual(r.cases.map(c=>c.inputs),a.cases.map(c=>c.inputs));assert.equal(JSON.stringify(w),original);
 assert.throws(()=>checkRepairExpression(w,{...a,before:r.before,after:r.after}),e=>e.expressionFeedback.code==='argument_shape');
 const old={...w,version:8};assert(focusedTools(old,[]).find(t=>t.function.name==='check_repair_expression').function.parameters.required.includes('before'));assert.equal(checkRepairExpression(old,{...a,before:r.before,after:r.after}).examplesMatch,true);
});
test('unsupported or ambiguous automatic bindings retain the whole repair for exact review',()=>{
 for(const [before,after,status] of [[source.trim(),'const width=Math.min(a,b),height=2;','ambiguous'],['Math.max(a,b)','Number(a)+b','unsupported']]){
  const w=fixture(before,after),a=args(w),saved=JSON.stringify(w.operations[1]);assert.equal(repairPlanContext(w).repairs[0].expressionBinding.status,status);
  assert(!focusedTools(w,[]).some(t=>t.function.name==='check_repair_expression'));assert(focusedTools(w,[]).some(t=>t.function.name==='propose_repair'));
  assert.throws(()=>checkRepairExpression(w,a),e=>e.expressionFeedback.field==='repair');assert.equal(JSON.stringify(w.operations[1]),saved);assert.equal(proposeRepair(w,{repair:a.repair}).edits[0].after,source.replace(before,after));assert(!w.operations.some(o=>o.action));
 }
});
test('fresh source is required and changed surrounding operands cannot silently remap saved examples',()=>{
 let w=fixture('+','-','const width=a+b;\n'),a={repair:args(w).repair,cases:[{inputs:{a:720,b:20},expected:700}]};
 w=JSON.parse(JSON.stringify(w));w.projectCheckpoint={id:'restart',operationCount:w.operations.length};assert.equal(repairPlanContext(w).repairs[0].expressionBinding.currentSource,false);assert.throws(()=>checkRepairExpression(w,a),/current file/);
 w.operations.push(read('const width=c+d;\n','changed'));assert.throws(()=>checkRepairExpression(w,a),e=>e.expressionFeedback.code==='binding_changed');
 w.operations.push(read('const width=a+b;\n// unrelated new line\n','restored'));const r=checkRepairExpression(w,a);assert(r.examplesMatch);assert.equal(r.sourceRevision,sha('const width=a+b;\n// unrelated new line\n'));
 const repeated=fixture('y=a+b','y=a-b','const x=a+b,y=a+b;\n');assert.equal(checkRepairExpression(repeated,{repair:args(repeated).repair,cases:a.cases}).examplesMatch,true);
});
test('automatic binding preserves invalid-argument feedback and sticky failed examples across restart',()=>{
 let w=fixture(),a=args(w);calculate(w,{...a,cases:[{inputs:{a:700,b:1280},expected:1280}]});
 assert.throws(()=>checkRepairExpression(w,{...a,cases:[{inputs:{a:700,b:1280},expected:{width:700}}]}),e=>e.expressionFeedback.field==='cases[0].expected');
 calculate(w,a);w=JSON.parse(JSON.stringify(w));assert(repairPlanContext(w).repairs[0].expressionCheck.hasFailedExamples);assert.throws(()=>proposeRepair(w,{repair:a.repair}),/failed an expression example/);assert.equal(w.operations.filter(o=>o.name==='record_repair_plan').length,1);assert(!w.operations.some(o=>o.action));
});
test('retained failures bind the actual margin expression without correcting or replacing input scenarios',async()=>{
 const fixtures=JSON.parse(await readFile(new URL('fixtures/expression-feedback-replays.json',import.meta.url)));
 for(const c of fixtures){
  const w=c.workflow;w.version=9;
  for(const op of w.operations.filter(o=>o.name==='record_repair_plan'))for(const r of op.result.repairs){const read=w.operations[Number(r.evidence.slice(1))-1];r.expressionBinding=bindRepairExpression({content:read.result.content,line:r.line,before:r.before,after:r.after});}
  const a={repair:c.arguments.repair,cases:c.arguments.cases},original=JSON.stringify(a),repair=repairPlanContext(w).repairs.find(r=>r.id===a.repair);assert.equal(repair.expressionBinding.before,'width+left+right');assert.equal(repair.expressionBinding.after,'width-left-right');
  assert.throws(()=>checkRepairExpression(w,a),e=>['scalar_expected','scalar_input'].includes(e.expressionFeedback.code));assert.equal(JSON.stringify(a),original);assert(!w.operations.some(o=>o.action));
 }
});
test('retained bound-calculation budget failure fits with the full contract, wrong expectation and journal intact',async()=>{
 const w=JSON.parse(await readFile(new URL('fixtures/bound-context-replay.json',import.meta.url))),original=JSON.stringify(w);
 const runner=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
 const history=runner.executionHistory(w),r=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt,history,context:runner.context(w),tools:runner.toolsFor(w)}),c=JSON.parse(r.messages.at(-1).content);
 assert(r.inputBytes<=24000);assert.equal(JSON.stringify(w),original);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);
 assert(c.repairPlan.repairs.every(r=>!r.before&&!r.after&&r.expressionBinding.before&&r.expressionBinding.after));
 assert(repairPlanContext(w).repairs.every(r=>r.before&&r.after),'UI/journal still have original fragments');
 const cases=r.messages.filter(m=>m.tool_name==='check_repair_expression').map(m=>JSON.parse(m.content).result.cases);
 assert.deepEqual(cases,history.filter(m=>m.tool_name==='check_repair_expression').map(m=>JSON.parse(m.content).result.cases));assert.equal(cases.at(-1)[1].expected,630);assert.equal(cases.at(-1)[1].after.value,680);assert.equal(cases.at(-1)[1].matches,false);
 const failed=c.repairPlan.repairs.find(r=>r.expressionCheck.hasFailedExamples);assert(failed);assert.throws(()=>proposeRepair(w,{repair:failed.id}),/failed an expression example/);
});
test('retained file-menu diagnostic pause fits the project menu with the original failure and contract',async()=>{
 const w=JSON.parse(await readFile(new URL('fixtures/check-menu-context-replay.json',import.meta.url))),runner=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
 const request=()=>focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt,history:runner.executionHistory(w),context:runner.context(w),tools:runner.toolsFor(w)});
 assert.equal(w.projectToolGroup,'files');assert.throws(request,e=>e.code==='project_input_limit');
 w.projectToolGroup='project';const original=JSON.stringify(w),r=request(),c=JSON.parse(r.messages.at(-1).content);assert(r.inputBytes<=24000);assert.equal(JSON.stringify(w),original);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);assert(c.diagnosticCheck.output);assert.equal(w.operations.at(-1).result.code,1);assert.equal(w.operations.at(-1).status,'failed');
});
test('retained revision feedback fits without duplicate schema while preserving the rejected list and completed effect',async()=>{
 const w=JSON.parse(await readFile(new URL('fixtures/repair-revision-context-replay.json',import.meta.url))),original=JSON.stringify(w),runner=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
 const r=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt,history:runner.executionHistory(w),context:runner.context(w),tools:runner.toolsFor(w)}),c=JSON.parse(r.messages.at(-1).content);
 assert(r.inputBytes<=24000);assert.equal(JSON.stringify(w),original);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);
 const tool=r.messages.find(m=>m.tool_name==='record_repair_plan'),result=JSON.parse(tool.content).result;
 assert(!result.expectedArguments);assert.equal(result.repairFeedback.issues[0].code,'fragment_absent');assert.match(result.repairFeedback.issues[0].message,/after fragment is present/);
 assert.deepEqual(r.messages.find(m=>m.role==='assistant'&&m.tool_calls?.[0]?.function.name==='record_repair_plan').tool_calls[0].function.arguments,w.operations.at(-1).arguments);
 assert.equal(c.completedEdits.length,1);assert.equal(c.repairPlan.repairs[0].state,'edit_applied');assert(c.diagnosticCheck.output);assert(w.operations.at(-1).result.expectedArguments);
});
