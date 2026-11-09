import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sha} from '../src/vault.mjs';
import {expressionExamples,expressionInputs} from '../src/repair-expression.mjs';
import {recordRepairPlan,repairPlanContext,checkRepairExpression,proposeRepair} from '../src/workflow-repair-plan.mjs';
import {focusedRequest,focusedTools,focusedProjectPrompt} from '../src/workflow-project-context.mjs';
import {Workflows} from '../src/workflows.mjs';
import {characterIdentity,caringCharacter,Character} from '../src/character.mjs';

const path='/tmp/project/width.mjs',source='const width=Math.max(a,b),height=1; // <span data-fake-expression>\n';
const read=(id='read',content=source)=>({id,name:'read_system_file',status:'completed',arguments:{path},result:{path,content,revision:sha(content),truncated:false}});
function fixture(after='Math.min(a,b)'){
 const w={version:8,revision:1,project:{},requirements:{files:[{path}],commands:[{program:'node'}]},operations:[read()]};
 const op={id:'plan',name:'record_repair_plan',revision:1,status:'started'};w.operations.push(op);op.result=recordRepairPlan(w,{repairs:[{file:path,line:1,before:'Math.max(a,b)',after,reason:'Bound the width.'}]});op.status='completed';return w;
}
const args=w=>({repair:repairPlanContext(w).repairs[0].id,before:'Math.max(a,b)',after:'Math.min(a,b)',cases:[{inputs:{a:700,b:1280},expected:700},{inputs:{a:460,b:320},expected:320}]});
function check(w,a){const op={id:'example'+w.operations.length,name:'check_repair_expression',revision:w.revision,arguments:a,status:'started'};w.operations.push(op);try{op.result=checkRepairExpression(w,a);op.status='completed';}catch(e){op.result={error:e.message,expressionFeedback:e.expressionFeedback};op.status='failed';}return op;}

test('expression errors identify exact scalar fields and never coerce, flatten or mutate examples',()=>{
 const inputs=[['expected',{inputs:{a:700,b:1280},expected:{width:700}},'scalar_expected'],['inputs["reserved"]',{inputs:{a:700,b:1280,reserved:[10,10]},expected:700},'scalar_input'],['inputs["a"]',{inputs:{a:'700',b:1280},expected:700},'scalar_input'],['inputs',{inputs:{a:700},expected:700},'missing_inputs'],['inputs["constructor"]',{inputs:{a:700,b:1280,constructor:1},expected:700},'input_name']];
 for(const [field,c,code] of inputs){const before=JSON.stringify(c);assert.throws(()=>expressionExamples('Math.max(a,b)','Math.min(a,b)',[{inputs:{a:1,b:2},expected:1},c]),e=>e.expressionIssue.field==='cases[1].'+field&&e.expressionIssue.code===code&&e.expressionIssue.requiredInputs.join(',')==='a,b');assert.equal(JSON.stringify(c),before);}
 assert.throws(()=>expressionExamples('a','return a;',[{inputs:{a:1},expected:1}]),e=>e.expressionIssue.field==='after'&&e.expressionIssue.code==='unsupported_expression');
 assert.throws(()=>expressionExamples('a','a',Array(7).fill({inputs:{a:1},expected:1})),e=>e.expressionIssue.code==='case_count');
});
test('required inputs include inactive branches and introduced names are facts, not a scope verdict',()=>{
 assert.deepEqual(expressionInputs('a','flag ? a : other.width'),{requiredInputs:['a','flag','other.width'],introducedInputs:['flag','other.width']});
 assert.throws(()=>expressionExamples('a','true ? a : b',[{inputs:{a:1},expected:1}]),e=>e.expressionIssue.code==='missing_inputs'&&e.expressionIssue.requiredInputs.includes('b'));
 const w=fixture('Math.min(a,b)-left'),r=checkRepairExpression(w,{...args(w),after:'Math.min(a,b)-left',cases:[{inputs:{a:700,b:1280,left:0},expected:700}]});
 assert.deepEqual(r.introducedInputs,['left']);assert.equal(r.examplesMatch,true);assert.match(r.notice,/not a scope analysis/);assert(!w.operations.some(o=>o.action));
});
test('source-expression feedback remains bound to the whole saved correction and current observed line',()=>{
 const w=fixture(),original=JSON.stringify(w);
 for(const [change,field,code] of [[{before:'other.width',after:'other.width-left'},'before','source_expression'],[{after:'Math.min(a,b)+1'},'after','incomplete_replacement']]){
  assert.throws(()=>checkRepairExpression(w,{...args(w),...change}),e=>e.expressionFeedback.field===field&&e.expressionFeedback.code===code&&e.expressionFeedback.observation.text===source.trimEnd()&&e.expressionFeedback.sourceRevision===sha(source));
 }
 assert.equal(JSON.stringify(w),original);
});
test('malformed example recovery preserves the saved repair and earlier candidate failures',()=>{
 const w=fixture(),a=args(w),plan=JSON.stringify(w.operations[1]);check(w,{...a,cases:[{inputs:{a:700,b:1280},expected:1280}]});
 const bad=check(w,{...a,cases:[{inputs:{a:700,b:1280},expected:{width:700}}]});assert.equal(bad.status,'failed');
 assert.equal(repairPlanContext(w).repairs[0].expressionFeedback.field,'cases[0].expected');assert.equal(repairPlanContext(w).repairs[0].expressionCheck.hasFailedExamples,true);
 check(w,a);assert.equal(repairPlanContext(w).repairs[0].expressionFeedback,null);assert.equal(repairPlanContext(w).repairs[0].expressionCheck.hasFailedExamples,true);assert.throws(()=>proposeRepair(w,{repair:a.repair}),/failed an expression example/);
 assert.equal(JSON.stringify(w.operations[1]),plan);assert(!w.operations.some(o=>o.action));assert(bad.result.expressionFeedback);
});
test('unresolved expression feedback survives restart and tracks source freshness without changing the diagnosis',()=>{
 let w=fixture();check(w,{...args(w),cases:[{inputs:{a:700,b:1280},expected:{width:700}}]});
 assert.equal(repairPlanContext(w).repairs[0].expressionFeedback.currentSource,true);
 w=JSON.parse(JSON.stringify(w));w.projectCheckpoint={id:'restart',operationCount:w.operations.length};assert.equal(repairPlanContext(w).repairs[0].expressionFeedback.currentSource,false);
 w.operations.push(read('fresh'));assert.equal(repairPlanContext(w).repairs[0].expressionFeedback.currentSource,true);
 w.operations.push(read('changed',source+'// changed\n'));assert.equal(repairPlanContext(w).repairs[0].expressionFeedback.currentSource,false);
 w.operations.push({...read('failed'),status:'failed',result:{error:'unavailable'}});assert.equal(repairPlanContext(w).repairs[0].expressionFeedback.currentSource,false);
 w.revision++;assert.equal(repairPlanContext(w),null);
});
test('feedback appears once in active context and remains complete when old tool history is withheld',()=>{
 const w=fixture(),op=check(w,{...args(w),cases:[{inputs:{a:700,b:1280},expected:{width:700}}]}),history=[{role:'assistant',tool_calls:[{function:{name:op.name,arguments:op.arguments}}]},{role:'tool',tool_name:op.name,content:JSON.stringify({evidenceId:'E3',result:op.result})}];
 const build=()=>focusedRequest(w,{system:focusedProjectPrompt,history,context:JSON.stringify({goal:'Keep the entire goal',scope:'This project only',outputRequirements:w.requirements}),tools:focusedTools(w,[])});
 let r=build(),c=JSON.parse(r.messages.at(-1).content);assert.equal(JSON.stringify(r).split('Choose the result of the exact expression').length-1,1);assert(!c.repairPlan.repairs[0].expressionFeedback.field);assert(r.inputBytes<=24000);assert.deepEqual(c.outputRequirements,w.requirements);
 w.projectCheckpoint={id:'restart',operationCount:3};r=build();c=JSON.parse(r.messages.at(-1).content);assert(!r.messages.some(m=>m.role==='tool'));assert.equal(c.repairPlan.repairs[0].expressionFeedback.field,'cases[0].expected');assert.equal(c.repairPlan.repairs[0].expressionFeedback.currentSource,false);assert.equal(c.goal,'Keep the entire goal');
});
test('retained live calculator failures receive distinct feedback with no partial verdict or action',async()=>{
 const cases=JSON.parse(await readFile(new URL('fixtures/expression-feedback-replays.json',import.meta.url)));
 for(const c of cases){const before=JSON.stringify(c.workflow);assert.throws(()=>checkRepairExpression(c.workflow,c.arguments),e=>e.expressionFeedback.code===c.expected.code&&e.expressionFeedback.field===c.expected.field,c.name);assert.equal(JSON.stringify(c.workflow),before);}
});
test('two retained live errors fit the unchanged input bound with full task and field feedback',async()=>{
 const w=JSON.parse(await readFile(new URL('fixtures/expression-context-replay.json',import.meta.url))),original=JSON.stringify(w);
 const runner=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
 const r=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt,history:runner.executionHistory(w),context:runner.context(w),tools:runner.toolsFor(w)}),c=JSON.parse(r.messages.at(-1).content);
 assert(r.inputBytes<=24000);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);assert.equal(JSON.stringify(w),original);
 const feedback=r.messages.filter(m=>m.tool_name==='check_repair_expression').map(m=>JSON.parse(m.content).result);
 assert.equal(feedback.length,2);assert.deepEqual(feedback.map(f=>f.expressionFeedback.code),['source_expression','unsupported_expression']);assert(feedback.every(f=>f.expressionFeedback.observation&&!f.expressionFeedback.savedCorrection&&!f.expectedArguments));
 assert(w.operations.filter(o=>o.result?.expressionFeedback).every(o=>o.result.expressionFeedback.savedCorrection),'full journal/UI feedback is retained');
});
