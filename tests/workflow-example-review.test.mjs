import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sha} from '../src/vault.mjs';
import {recordRepairPlan,repairPlanContext,checkRepairExpression,proposeRepair} from '../src/workflow-repair-plan.mjs';
import {unmappedExampleHistory} from '../src/workflow-example-ledger.mjs';
import {workflowExampleReview} from '../src/workflow-example-review.mjs';
import {Workflows} from '../src/workflows.mjs';
import {focusedRequest,focusedProjectPrompt,focusedTools} from '../src/workflow-project-context.mjs';
const path='/tmp/example-review/width.mjs',content='const result=width+left+right;\n';
function fixture(){
 const w={id:'fixture',version:11,revision:1,goal:'720 minus 10 on each side gives 700',status:'paused',project:{folders:['/tmp/example-review']},requirements:{files:[{path}],commands:[]},operations:[{id:'read',name:'read_system_file',revision:1,status:'completed',arguments:{path},result:{path,content,revision:sha(content),truncated:false}}]};
 const record=(after='width-left-right')=>{const o={id:'plan'+w.operations.length,name:'record_repair_plan',revision:1,status:'started'};w.operations.push(o);o.result=recordRepairPlan(w,{repairs:[{file:path,line:1,before:'width+left+right',after,reason:'Subtract both margins'}]});o.status='completed';return o.result.repairs[0].id;};
 const calculate=(repair,inputs={width:1280,left:10,right:10},expected=700)=>{const args={repair,cases:[{inputs,expected}]},op={id:'calc'+w.operations.length,revision:1,name:'check_repair_expression',arguments:args,status:'completed',result:checkRepairExpression(w,args)};w.operations.push(op);return op;};
 const repair=record();calculate(repair);
 const service={running:new Map(),reconciling:new Set(),examplePreviews:new Map(),actions:{system:{read:async p=>({path:p,content,revision:sha(content),truncated:false})}},save:async()=>{},read:async()=>w};
 const input={operation:'preview',revision:1,repair,caseId:'X3.1',inputs:{width:720,left:10,right:10},expected:700,reason:'Use the goal’s logical width, not the monitor pixel width.',provenance:{kind:'goal',quote:w.goal}};
 const preview=()=>workflowExampleReview(service,w,input),apply=async extra=>{const p=await preview();return workflowExampleReview(service,w,{...input,operation:'apply',token:p.token,...extra});};
 return {w,service,input,record,calculate,repair,preview,apply};
}
test('passing alternatives and replacement repair lists retain the failed original case',()=>{
 const f=fixture();f.calculate(f.repair,f.input.inputs);let ledger=repairPlanContext(f.w).repairs[0].exampleLedger;
 assert.equal(ledger.total,2);assert.equal(ledger.failed,1);assert(ledger.cases[0].retained);assert.throws(()=>proposeRepair(f.w,{repair:f.repair}),/failed an expression example/);
 const next=f.record();ledger=repairPlanContext(f.w).repairs[0].exampleLedger;assert.equal(ledger.failed,1);assert.equal(ledger.cases[0].id,'X3.1');assert.throws(()=>proposeRepair(f.w,{repair:next}),/failed an expression example/);
});
test('review changes only effective values, keeps original failure, requires fresh read after pause, and survives serialization',async()=>{
 const f=fixture(),original=structuredClone(f.w.operations);f.w.projectCheckpoint={id:'pause',operationCount:f.w.operations.length};
 const p=await f.preview();assert.equal(p.original.after.value,1260);assert.equal(p.verdict.after.value,700);assert.equal(f.w.operations.length,3);assert.throws(()=>proposeRepair(f.w,{repair:f.repair}),/current file/);
 await workflowExampleReview(f.service,f.w,{...f.input,operation:'apply',token:p.token});
 assert.deepEqual(f.w.operations.slice(0,3),original);assert.equal(f.w.status,'paused');assert(!f.w.operations.some(o=>o.action));
 const w=JSON.parse(JSON.stringify(f.w)),r=repairPlanContext(w).repairs[0];assert.equal(r.exampleLedger.failed,0);assert.equal(r.exampleLedger.cases[0].original.matches,false);assert.equal(r.exampleLedger.cases[0].effective.inputs.width,720);assert.equal(r.exampleLedger.cases[0].reviews[0].provenance.quote,w.goal);
 w.operations.push({...structuredClone(w.operations[0]),id:'fresh'});assert(proposeRepair(w,{repair:f.repair}));
 const runner=Object.create(Workflows.prototype);assert(!runner.completionRefs(w).items.enum.includes('E4'));assert(!focusedTools(w,[]).some(t=>t.function.name.includes('review_repair')));
});
test('corrected scenarios are not reverted by repeated raw examples and new distinct failures still block',async()=>{
 const f=fixture();await f.apply();f.calculate(f.repair);assert.equal(repairPlanContext(f.w).repairs[0].exampleLedger.failed,0);
 f.calculate(f.repair,{width:300,left:10,right:10},300);assert.equal(repairPlanContext(f.w).repairs[0].exampleLedger.failed,1);assert.throws(()=>proposeRepair(f.w,{repair:f.repair}),/failed an expression example/);
});
test('a real revised diagnosis is evaluated against retained examples, without silently remapping new inputs',()=>{
 const f=fixture();f.w.operations[2].result.cases[0].expected=1300;f.w.operations[2].result.cases[0].matches=false;
 const id=f.record('width+left+right+0');assert.equal(repairPlanContext(f.w).repairs[0].exampleLedger.failed,0);assert(proposeRepair(f.w,{repair:id}));
 f.record('width-left-right-reserve');const ledger=repairPlanContext(f.w).repairs[0].exampleLedger;assert.equal(ledger.failed,1);assert.match(ledger.cases[0].verdict.error,/missing inputs: reserve/);
});
test('preview requires a reason, exact provenance, valid scalars, a changed value and an existing case',async()=>{
 for(const edit of [{reason:''},{provenance:{kind:'goal',quote:'fabricated'}},{provenance:{kind:'source',quote:'made up',evidence:'E1'}},{inputs:{width:'720',left:10,right:10}},{expected:{value:700}},{inputs:{width:720}},{inputs:{width:1280,left:10,right:10}},{caseId:'X99.1'},{repair:'R99.1'},{revision:2}]){
  const f=fixture();await assert.rejects(workflowExampleReview(f.service,f.w,{...f.input,...edit}));assert.equal(f.w.operations.length,3);
 }
});
test('observed-file provenance is rechecked against the current file, not just a copied quote',async()=>{
 const f=fixture();f.input.provenance={kind:'source',evidence:'E1',quote:'width+left+right'};const p=await f.preview();assert.equal(p.provenance.path,path);
 f.service.actions.system.read=async()=>({path,content:'changed',revision:sha('changed')});await assert.rejects(f.preview(),/source changed/);assert.equal(f.w.operations.length,3);
});
test('edited payloads, changed tasks, changed files, reused tokens and restarted previews cannot apply',async()=>{
 for(const change of ['payload','goal','list','source','restart','status']){
  const f=fixture(),p=await f.preview();let args={...f.input,operation:'apply',token:p.token};
  if(change==='payload')args.reason='A different reason';
  if(change==='goal')f.w.goal+=' More scope.';
  if(change==='list')f.record();
  if(change==='source')f.service.actions.system.read=async()=>({path,content:content+'// changed\n',revision:sha(content+'// changed\n')});
  if(change==='restart')f.service.examplePreviews.clear();
  if(change==='status')f.w.status='completed';
  const count=f.w.operations.length;await assert.rejects(workflowExampleReview(f.service,f.w,args));assert.equal(f.w.operations.length,count);
 }
 const f=fixture(),p=await f.preview(),a={...f.input,operation:'apply',token:p.token};await workflowExampleReview(f.service,f.w,a);await assert.rejects(workflowExampleReview(f.service,f.w,a));assert.equal(f.w.operations.length,4);
});
test('busy, pending, interrupted, finished and legacy workflows reject review',async()=>{
 for(const state of ['running','reconciling','pending','interrupted','finished','legacy']){
  const f=fixture();if(state==='running')f.service.running.set(f.w.id,{});if(state==='reconciling')f.service.reconciling.add(f.w.id);
  if(['pending','interrupted'].includes(state))f.w.operations.push({action:'a',status:state==='pending'?'waiting_approval':'interrupted'});
  if(state==='finished')f.w.status='completed';if(state==='legacy')f.w.version=10;
  await assert.rejects(f.preview());
 }
});
test('reviewing an example that still fails never unblocks the saved repair',async()=>{
 const f=fixture();f.input.inputs.width=800;await f.apply();assert.equal(repairPlanContext(f.w).repairs[0].exampleLedger.failed,1);assert.throws(()=>proposeRepair(f.w,{repair:f.repair}),/failed an expression example/);
});
test('retained 1.39 wrong-width stall recovers through review with the original journal intact',async()=>{
 const w=JSON.parse(await readFile(new URL('fixtures/reviewed-example-stall.json',import.meta.url)));w.version=11;w.status='paused';const original=structuredClone(w.operations),r=repairPlanContext(w).repairs.find(r=>r.id==='R4.2');
 assert.equal(r.exampleLedger.failed,1);assert.equal(r.exampleLedger.total,3);assert.equal(r.exampleLedger.cases[0].id,'X7.1');assert.throws(()=>proposeRepair(w,{repair:r.id}),/failed an expression example/);
 const service={running:new Map(),reconciling:new Set(),examplePreviews:new Map(),actions:{system:{read:async path=>w.operations.findLast(o=>o.name==='read_system_file'&&o.result?.path===path).result}},save:async()=>{},read:async()=>w};
 const input={operation:'preview',revision:w.revision,repair:r.id,caseId:'X7.1',inputs:{left:10,right:10,width:720},expected:700,reason:'Use logical width 720 from the goal, not the unrelated 1280 screen width.',provenance:{kind:'goal',quote:'720 minus 10 on each side gives 700'}};
 const p=await workflowExampleReview(service,w,input);await workflowExampleReview(service,w,{...input,operation:'apply',token:p.token});
 assert.deepEqual(w.operations.slice(0,original.length),original);assert.equal(repairPlanContext(w).repairs.find(r=>r.id==='R4.1').state,'edit_applied');
 assert.equal(repairPlanContext(w).repairs[1].exampleLedger.failed,0);assert(proposeRepair(w,{repair:r.id}));
 const runner=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 const request=focusedRequest(w,{system:focusedProjectPrompt,history:runner.executionHistory(w),context:runner.context(w),tools:runner.toolsFor(w)});assert(request.inputBytes<=24000);
 const c=JSON.parse(request.messages.at(-1).content);assert.equal(c.goal,w.goal);assert.deepEqual(c.outputRequirements,w.requirements);assert(c.repairPlan.repairs.some(r=>r.exampleLedger?.reviewedCases?.[0]?.inputs.width===720));
});

test('removed or moved repairs keep their examples visible without guessing a new mapping',()=>{
 const f=fixture(),before=structuredClone(f.w.operations[2]);const op={id:'moved-plan',name:'record_repair_plan',status:'completed',revision:1,result:{repairs:[{...f.w.operations[1].result.repairs[0],id:'R9.1',line:2}]}};f.w.operations.push(op);
 assert.equal(repairPlanContext(f.w).repairs[0].exampleLedger,undefined);const history=unmappedExampleHistory(f.w);assert.equal(history.length,1);assert.equal(history[0].ledger.cases[0].id,'X3.1');assert.equal(history[0].ledger.failed,1);assert.deepEqual(f.w.operations[2],before);
});
