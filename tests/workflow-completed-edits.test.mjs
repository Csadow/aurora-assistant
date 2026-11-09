import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sha} from '../src/vault.mjs';
import {completedEditReceipts} from '../src/workflow-completed-edits.mjs';
import {Workflows} from '../src/workflows.mjs';
import {focusedRequest,focusedProjectPrompt} from '../src/workflow-project-context.mjs';
import {projectProgress} from '../src/workflow-project-progress.mjs';
import {recordRepairPlan,repairPlanContext,proposeRepair} from '../src/workflow-repair-plan.mjs';
import {characterIdentity,caringCharacter,Character} from '../src/character.mjs';

const retained=JSON.parse(await readFile(new URL('fixtures/completed-repair-stall.json',import.meta.url)));
const runner=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
const style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
const snapshot=(count=22)=>{const w=structuredClone(retained);w.version=10;w.operations=w.operations.slice(0,count);return w;};
const request=w=>focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt,history:runner.executionHistory(w),context:runner.context(w),tools:runner.toolsFor(w)});
const view=w=>JSON.parse(request(w).messages.at(-1).content);
function read(w,content,extra={}){const path=w.operations[6].expected.path;w.operations.push({id:'read-'+w.operations.length,name:'read_system_file',revision:w.revision,status:'completed',arguments:{path},result:{path,content,revision:sha(content),truncated:false},...extra});}
function remainingPlan(w){
 const file=w.requirements.files.find(f=>f.path.endsWith('quick-window.mjs')).path;
 const op={id:'remaining-plan',name:'record_repair_plan',revision:w.revision,status:'started'};w.operations.push(op);
 op.result=recordRepairPlan(w,{repairs:[{file,line:5,before:'Math.max(value.width,area.width)',after:'Math.min(value.width,area.width)',reason:'Bound width by available dimensions.'}]});op.status='completed';return op.result.repairs[0];
}

test('retained unknown-ID and repeated-read states separate completed work without changing contract, journal or UI',()=>{
 for(const count of [8,12,13,18,22]){
  const w=snapshot(count),original=JSON.stringify(w),r=request(w),c=JSON.parse(r.messages.at(-1).content);
  assert(r.inputBytes<=24000);assert.equal(JSON.stringify(w),original);
  assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);
  assert.equal(c.completedEdits.length,1);assert.equal(c.completedEdits[0].repair,'R5.1');assert.equal(c.completedEdits[0].applied.after,'width-left-right');assert.equal(c.completedEdits[0].currentFile.state,'matches_write');
  assert.deepEqual(c.repairPlan.repairs,[]);assert.equal(c.projectProgress.readyToFinish,false);
  assert.equal(repairPlanContext(w).repairs[0].state,'edit_applied');assert.equal(repairPlanContext(w).repairs[0].expressionCheck.cases.length,2);
  assert(!r.messages.some(m=>m.tool_name==='check_repair_expression'));
  if(count>=12){assert(c.diagnosticCheck.output.includes('fail'));assert.equal(c.savedChecks[0].passed,false);}
  assert(!runner.toolsFor(w).some(t=>['propose_repair','check_repair_expression'].includes(t.function.name)));
 }
});
test('unknown repair feedback lists only remaining IDs and does not infer or stage a missing correction',()=>{
 const w=snapshot(13),original=JSON.stringify(w);
 assert.throws(()=>proposeRepair(w,{repair:'R5.2'}),/Unknown repair ID.*No unapplied repair is saved/);
 assert.throws(()=>proposeRepair(w,{repair:'R5.1'}),/completed or pending/);assert.equal(JSON.stringify(w),original);
 const repair=remainingPlan(w),before=JSON.stringify(w),patch=proposeRepair(w,{repair:repair.id});
 assert.equal(patch.path,repair.path);assert(patch.edits[0].after.includes('Math.min(value.width,area.width)'));
 assert.throws(()=>proposeRepair(w,{repair:'R5.2'}),e=>e.message.includes('Available remaining IDs: '+repair.id));
 assert.equal(JSON.stringify(w),before);assert.equal(w.operations.filter(o=>o.expected).length,1);
 const c=view(w);assert.deepEqual(c.projectProgress.remainingRepairs,[repair.id]);assert.equal(c.repairPlan.repairs[0].id,repair.id);assert.equal(c.completedEdits[0].repair,'R5.1');
});
test('completed receipts survive replaced lists and task revisions without claiming old source is current',()=>{
 let w=snapshot(13);remainingPlan(w);w.revision++;w=JSON.parse(JSON.stringify(w));w.projectCheckpoint={id:'restart',operationCount:w.operations.length};
 assert.equal(repairPlanContext(w),null);assert.equal(completedEditReceipts(w)[0].applied.after,'width-left-right');assert.equal(completedEditReceipts(w)[0].currentFile.state,'unobserved_since_write_or_restart');
 assert.equal(projectProgress(w).readyToFinish,false);read(w,retained.operations[7].result.content);assert.equal(completedEditReceipts(w)[0].currentFile.state,'matches_write');
 read(w,retained.operations[7].result.content+'// changed externally\n');assert.equal(completedEditReceipts(w)[0].currentFile.state,'changed_since_write');assert.equal(projectProgress(w).readyToFinish,false);
});
test('partial, failed, stale and forged readbacks never become current completed-write receipts',()=>{
 for(const alter of [o=>o.status='failed',o=>o.arguments.offset=1,o=>o.result.truncated=true,o=>o.result.revision='invalid',o=>o.result.error='unavailable']){
  const w=snapshot(8);read(w,w.operations[7].result.content);alter(w.operations.at(-1));assert.equal(completedEditReceipts(w)[0].currentFile.state,'unobserved_since_write_or_restart');
 }
 const w=snapshot(7);assert.equal(completedEditReceipts(w)[0].currentFile.state,'unobserved_since_write_or_restart');
});
test('pending, failed and interrupted writes stay outside completed receipts and pending repairs remain visible',()=>{
 for(const status of ['waiting_approval','failed','interrupted','started']){
  const w=snapshot(7);w.operations[6].status=status;assert.deepEqual(completedEditReceipts(w),[]);
  assert.equal(view(w).repairPlan.repairs.length,1);
  if(status!=='failed'){assert.equal(projectProgress(w).phase,'approval');assert.throws(()=>proposeRepair(w,{repair:'R5.1'}),/completed or pending/);}
 }
});
test('remaining failed examples stay active and block staging; completed summaries cannot erase them',()=>{
 const w=snapshot(6),op=w.operations[5];op.result.examplesMatch=false;op.result.cases[0].matches=false;op.result.cases[0].expected=42;
 const original=JSON.stringify(w),r=request(w),c=JSON.parse(r.messages.at(-1).content);
 assert.equal(c.completedEdits.length,0);assert(c.repairPlan.repairs[0].expressionCheck.hasFailedExamples);
 assert(r.messages.some(m=>m.tool_name==='check_repair_expression'&&JSON.parse(m.content).result.cases[0].expected===42));
 assert.throws(()=>proposeRepair(w,{repair:'R5.1'}),/failed an expression example/);assert.equal(JSON.stringify(w),original);
});
test('completed changes are bounded excerpts while generic writes retain their original receipts',()=>{
 const w=snapshot(8),repair=w.operations[4].result.repairs[0];delete repair.expressionBinding;repair.after='x'.repeat(500);
 const original=JSON.stringify(w),receipt=completedEditReceipts(w)[0];assert.equal(receipt.applied.after.length,240);assert.equal(receipt.applied.truncated,true);assert.equal(JSON.stringify(w),original);
 delete w.operations[6].repair;const generic=completedEditReceipts(w)[0];assert(!generic.applied);assert.equal(generic.path,w.operations[6].expected.path);assert.equal(generic.revision,w.operations[6].expected.revision);
});
test('legacy tasks retain their active repair format and feedback guidance',()=>{
 const w=structuredClone(retained),c=view(w);assert.equal(w.version,9);assert.equal(c.repairPlan.repairs[0].state,'edit_applied');assert(!c.completedWorkNotice);assert(!c.completedEdits[0].applied);
 assert.match(projectProgress(w).next.message,/resubmit the complete repair list/);
 assert.throws(()=>proposeRepair(w,{repair:'R5.2'}),/^Error: Choose a repair from the current saved repair list/);
 w.version=10;assert.match(projectProgress(w).next.message,/REMAINING corrections only/);
});
