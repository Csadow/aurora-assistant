import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {copyDiagnosis,reportedTests,copyDiagnosisForModel} from '../src/copy-diagnosis.mjs';
import {copyDiagnosisHTML,testCopyResultHTML,copyEditWarningHTML} from '../public/test-copy.js';
import {focusedRequest,focusedTools,focusedProjectPrompt,projectCompletionPrompt,projectInputLimit} from '../src/workflow-project-context.mjs';
import {proposeRepair,repairPlanContext} from '../src/workflow-repair-plan.mjs';
import {Workflows} from '../src/workflows.mjs';
import {characterIdentity,Character} from '../src/character.mjs';
import {projectProgress} from '../src/workflow-project-progress.mjs';
import {routineOperation} from '../src/workflow-routine.mjs';
import {copyResultForModel} from '../src/workflow-test-copy.mjs';
const fixtures=JSON.parse(await readFile(new URL('fixtures/copy-diagnosis-replays.json',import.meta.url))).cases;
const find=id=>structuredClone(fixtures.find(c=>c.id===id));
const escape=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
async function localBudgetRequest(file){
 const {record:w}=JSON.parse(await readFile(new URL('fixtures/'+file,import.meta.url)));
 const before=JSON.stringify(w),wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}},skills:{prompt:()=>''}});
 const style=(await new Character({read:async()=>{throw Object.assign(new Error('missing'),{status:404});}}).prompt()).slice(0,1800);
 const system=characterIdentity+style+'\n'+focusedProjectPrompt+projectCompletionPrompt+'\n';
 const request=focusedRequest(w,{system,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)});
 return {w,before,request,context:JSON.parse(request.messages.at(-1).content)};
}

test('local project context keeps complete task rules and the latest expression check after repeated matching checks',async()=>{
 const {w,before,request,context}=await localBudgetRequest('project-expression-budget-replay.json');
 assert(request.inputBytes<=projectInputLimit);assert.equal(JSON.stringify(w),before);
 assert.equal(context.goal,w.goal);assert.equal(context.scope,w.scope);assert.deepEqual(context.outputRequirements,w.requirements);
 const checks=request.messages.filter(m=>m.tool_name==='check_repair_expression').map(m=>JSON.parse(m.content));
 assert.equal(checks.length,2);assert.equal(checks[0].result.examplesMatch,true);assert.equal(checks[0].result.cases,undefined);
 assert.equal(checks[1].result.cases.length,1);assert.equal(checks[1].result.examplesMatch,true);
 assert.equal(context.repairPlan.repairs.length,2);assert(context.repairPlan.repairs.every(r=>r.expressionCheck?.examplesMatch));
 assert(context.repairPlan.repairs.every(r=>r.expressionCheck.path===undefined&&r.path&&r.currentRead));
 assert(w.operations.find(o=>o.name==='check_repair_expression'&&o.status==='completed').result.cases.length===2);
});
test('local project context fits a current line view without hiding goal, requirements or saved source',async()=>{
 const {w,before,request,context}=await localBudgetRequest('project-line-view-budget-replay.json');
 assert(request.inputBytes<=projectInputLimit);assert.equal(JSON.stringify(w),before);
 assert.equal(context.goal,w.goal);assert.equal(context.scope,w.scope);assert.deepEqual(context.outputRequirements,w.requirements);
 assert(context.evidenceForCompletion.every(e=>e.name!=='read_system_file'),'old read handles are omitted while the task is not ready to finish');
 const view=request.messages.find(m=>m.tool_name==='inspect_source_lines');
 assert(view);assert.match(JSON.parse(view.content).result.numberedLines,/width/);
 assert(context.fileObservations.some(f=>f.path.endsWith('/desktop/placement.mjs')&&f.needsFreshRead===false));
 assert(w.operations.some(o=>o.name==='inspect_source_lines'&&o.result?.numberedLines));
});

test('real copy reports distinguish unchanged failures and a valid equivalent candidate without judging cause',()=>{
 for(const [id,resolved,remaining] of [['pagerepair',0,2],['caprepair',0,3],['equivalent',2,0]]){
  const c=find(id),before=JSON.stringify(c),d=copyDiagnosis(c.payload,c.result);
  assert.equal(d.status,'compared');assert.equal(d.resolved,resolved);assert.equal(d.stillFailing,remaining);assert.equal(d.newlyFailing,0);assert.equal(JSON.stringify(c),before);
  assert.equal(d.change.sourceRevision,c.result.candidate.beforeRevision);assert.equal(d.change.candidateRevision,c.result.candidate.revision);
  assert.match(d.notice,/not a proof/);assert(!('correct' in d));assert(!('approved' in d));
  for(const t of d.baseline.tests.filter(t=>t.failure)){const f=t.failure,source=c.payload.files.find(s=>s.path===f.path);assert.equal(f.source.text,source.content.split('\n')[f.line-1]);}
 }
});
test('partial, nested, duplicate, renamed and inconsistent test reports remain explicitly unavailable',()=>{
 for(const change of [r=>r.truncated=true,r=>r.stopped=true,r=>r.error='failed',r=>r.changedFiles=['x'],r=>r.outcome='setup_failure',r=>r.content=r.content.replace('ℹ suites 0','ℹ suites 1'),r=>r.content=r.content.replace('ℹ tests 3','ℹ tests 30'),r=>r.content=r.content.replace('ℹ skipped 0','ℹ skipped 1'),r=>r.content='extra log\n'+r.content,r=>r.content=r.content.replace('above and equal cap','below cap'),r=>r.code=0]){
  const c=find('caprepair');change(c.result.runs[1]);assert.equal(copyDiagnosis(c.payload,c.result).status,'unavailable');
 }
 const c=find('caprepair');c.result.runs[1].content=c.result.runs[1].content.replaceAll('below cap','renamed test');assert.equal(copyDiagnosis(c.payload,c.result).status,'unavailable');
 c.result.runs=[];assert.equal(copyDiagnosis(c.payload,c.result).status,'unavailable');
});
test('output paths cannot fetch external sources or quote a different snapshot',()=>{
 for(const alter of [c=>c.result.runs[1].content=c.result.runs[1].content.replaceAll('tests/quota.test.mjs:','../../outside.mjs:'),c=>c.payload.files.find(f=>f.relative==='tests/quota.test.mjs').revision='changed',c=>c.result.runs[1].content=c.result.runs[1].content.replaceAll('tests/quota.test.mjs:2:','tests/quota.test.mjs:9999:')]){
  const c=find('caprepair');alter(c);const parsed=reportedTests(c.result.runs[1],c.payload.files,'candidate',c.payload.candidate);assert(parsed);assert(!parsed.tests[0].failure);
 }
});
test('model view retains actual verdicts and bounded literal diagnosis without duplicate raw output',()=>{
 const c=find('pagerepair');c.result.diagnosis=copyDiagnosis(c.payload,c.result);const v=copyResultForModel(c.result);
 assert.deepEqual(v.runs.map(r=>r.outcome),c.result.runs.map(r=>r.outcome));assert(v.runs.every(r=>r.outputInDiagnosis&&!r.content));assert(v.diagnosis.failure.source.text.includes('assert.deepEqual'));
 assert(Buffer.byteLength(JSON.stringify(v.diagnosis))<2400);assert.equal(copyDiagnosisForModel(undefined),undefined);
 const unknown=copyResultForModel({...c.result,diagnosis:{...c.result.diagnosis,status:'unavailable',reason:'unsupported'}});assert(unknown.runs.every(r=>r.content));
});
test('a newly failing test is reported as a regression without producing an execution decision',()=>{
 const c=find('equivalent');
 c.result.runs.reverse();c.result.runs[0].variant='baseline';c.result.runs[1].variant='candidate';
 const d=copyDiagnosis(c.payload,c.result);assert.equal(d.status,'compared');assert.equal(d.newlyFailing,2);assert.equal(d.resolved,0);assert.equal(d.stillFailing,0);assert(!('approved' in d));
});
test('repair review escapes candidate, test labels and exact failure/source excerpts',()=>{
 const c=find('caprepair'),d=copyDiagnosis(c.payload,c.result),x='<img data-injected onerror="x">';
 d.change.before.text=x;d.change.after.text=x;d.changes[0].name=x;d.candidate.tests[0].failure.source.text=x;d.candidate.tests[0].failure.output.text=x;
 const html=copyDiagnosisHTML(d,escape);assert(!html.includes('<img'));assert(html.includes('&lt;img'));assert(html.includes('0 failed → passed'));assert(html.includes('3 still failing'));
 assert(copyDiagnosisHTML({...d,status:'unavailable',reason:x},escape).includes('&lt;img'));
});
test('partial candidate review names failed tests and folds duplicate raw output',()=>{
 const c=find('caprepair'),d=copyDiagnosis(c.payload,c.result),x='<img data-injected onerror="x">';
 d.changes.find(t=>t.candidate==='failed').name=x;
 const result={...c.result,diagnosis:d};
 const warning=copyEditWarningHTML(result,escape),html=testCopyResultHTML(result,escape);
 assert(warning.includes('data-copy-edit-warning'));assert(warning.includes('3 failed tests'));
 assert(warning.includes('&lt;img'));assert(!warning.includes('<img'));
 assert(html.includes('data-copy-run="candidate"'));assert(!html.includes('data-copy-run="candidate" open'));
 assert(testCopyResultHTML({...result,diagnosis:{status:'unavailable',change:d.change,reason:'Unknown format'}},escape).includes('data-copy-run="candidate" open'));
 assert.equal(copyEditWarningHTML({...result,diagnosis:{...d,changes:d.changes.map(t=>({...t,candidate:'passed'}))}},escape),'');
});
test('large rejected-list replay fits the unchanged cap with every field error and full task contract retained',async()=>{
 const {record:w,system}=JSON.parse(await readFile(new URL('fixtures/project-scope-recovery-replays.json',import.meta.url))).cases.find(c=>c.id==='oversized_unrelated_repairs');
 const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),build=()=>focusedRequest(w,{system,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)});
 assert.throws(build,/input budget/);w.version=17;const before=JSON.stringify(w),r=build(),context=JSON.parse(r.messages.at(-1).content);assert(r.inputBytes<=24000);
 assert.equal(context.goal,w.goal);assert.equal(context.scope,w.scope);assert.deepEqual(context.outputRequirements,w.requirements);assert.equal(JSON.stringify(w),before);
 const feedback=JSON.parse(r.messages.find(m=>m.tool_name==='record_repair_plan').content).result.repairFeedback;
 assert.equal(feedback.issues.length,8);assert(feedback.issues.every(i=>i.field==='before'&&i.observation&&i.message.includes('ONE observed line')));
 const request=r.messages.find(m=>m.tool_calls?.[0]?.function.name==='record_repair_plan').tool_calls[0].function.arguments;assert.equal(request.rejectedItems.length,8);assert.match(request.notice,/not replayable/);assert(w.operations.at(-1).arguments.repairs[0].before.includes('\n'));
});

test('failed-copy guidance requests reassessment while legacy and partially improved repairs retain their contract',async()=>{
 const data=JSON.parse(await readFile(new URL('fixtures/project-scope-recovery-replays.json',import.meta.url))),w=data.cases.find(c=>c.id==='incorrect_pagination').record;
 // Rebind the real completed negative copy to this equivalent recorded state.
 const c=find('pagerepair'),pending=w.operations.at(-1),saved=w.operations.findLast(o=>o.name==='record_repair_plan'&&o.status==='completed'),repair=saved.result.repairs[0];
 const map=s=>s.replaceAll(c.payload.root,w.project.folders[0]);
 const result=JSON.parse(map(JSON.stringify(c.result)));result.repair=repair.id;result.diagnosis=copyDiagnosis(c.payload,c.result);
 pending.result=result;pending.status='completed';w.status='running';w.version=17;w.planApprovedRevision=w.revision;
 const p=projectProgress(w);assert.equal(p.phase,'repair');assert(!p.next.tool);assert.match(p.next.message,/resolves none/);assert.equal(routineOperation(w),null);
 w.version=16;assert.equal(projectProgress(w).next.tool,'propose_repair');
 w.version=17;result.diagnosis.resolved=1;assert.equal(projectProgress(w).next.tool,'propose_repair');assert.equal(routineOperation(w),null,'partial failures still require model diagnosis');
});

test('the retained invented-ID failure explains that prose cannot replace a saved wrong correction',async()=>{
 const {record:w,replies,system}=JSON.parse(await readFile(new URL('fixtures/diagnosis-id-replay.json',import.meta.url))),wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 assert.match(replies[0].content,/revise/);assert.equal(replies[0].tool_calls[0].function.name,'propose_repair');
 // Before the rejected ID was attempted; retain all actual read/copy evidence.
 const index=w.operations.findIndex(o=>o.name==='propose_file_edit'&&o.status==='failed');w.operations=w.operations.slice(0,index);w.version=17;
 const before=JSON.stringify(w);assert.throws(()=>proposeRepair(w,replies[0].tool_calls[0].function.arguments),/record_repair_plan.*FIRST/);assert.equal(JSON.stringify(w),before);
 assert.match(repairPlanContext(w).repairs[0].after,/\+ 1/,'the incorrect saved repair was not silently replaced');
 assert.match(focusedTools(w,[]).find(t=>t.function.name==='propose_repair').function.description,/record_repair_plan FIRST/);
 const request=focusedRequest(w,{system,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)});assert(request.inputBytes<=24000);
 w.version=16;assert.throws(()=>proposeRepair(w,replies[0].tool_calls[0].function.arguments),e=>!e.message.includes('ORIGINAL saved correction'));
});

test('the corrected model-directed candidate can continue with prior failures retained under the same input cap',async()=>{
 const {record:w,system}=JSON.parse(await readFile(new URL('fixtures/diagnosis-context-replay.json',import.meta.url))),before=JSON.stringify(w),wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 const r=focusedRequest(w,{system,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)}),c=JSON.parse(r.messages.at(-1).content);
 assert(r.inputBytes<=24000);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);assert.equal(JSON.stringify(w),before);
 const copies=r.messages.filter(m=>m.tool_name==='propose_test_copy').map(m=>JSON.parse(m.content).result);assert.equal(copies.length,2);
 assert.equal(copies[0].diagnosis.stillFailing,3);assert.equal(copies[0].diagnosis.resolved,0);assert.equal(copies[0].diagnosis.displaySummary,true);assert(copies[0].runs.every(run=>run.outcome==='assertion_failure'));
 assert.equal(copies[1].diagnosis.resolved,3);assert.equal(copies[1].diagnosis.stillFailing,0);assert.equal(copies[1].diagnosis.change.after.text,'export function allowed(count, limit) { return Math.min(count, limit); }');assert.equal(copies[1].runs[1].outcome,'passed');
 assert(copies[0].runs.every(run=>run.outputInJournal&&!run.outputInDiagnosis));
 const history=[...wf.executionHistory(w),{role:'tool',tool_name:'propose_test_copy',content:JSON.stringify({status:'failed',result:{error:'Request rejected; no test executed.'}})}];
 const withFailure=focusedRequest(w,{system,history,context:wf.context(w),tools:wf.toolsFor(w)}),latest=withFailure.messages.filter(m=>m.tool_name==='propose_test_copy').map(m=>JSON.parse(m.content).result).filter(r=>r.diagnosis).at(-1);
 assert.deepEqual(latest.diagnosis,copies[1].diagnosis,'a later failed request must not replace the newest comparison');
});

test('a prose-only reply after successful copy recovery retains the next action and full contract within the same cap',async()=>{
 const {record:w,system}=JSON.parse(await readFile(new URL('fixtures/diagnosis-prose-context-replay.json',import.meta.url))),before=JSON.stringify(w),wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 const r=focusedRequest(w,{system,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)}),c=JSON.parse(r.messages.at(-1).content);
 assert(r.inputBytes<=24000);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);assert.equal(JSON.stringify(w),before);
 assert.equal(c.toolContinuation.reason,w.toolContinuations.at(-1).reason);assert.equal(c.toolContinuation.draftExcerpted,true);assert.match(c.toolContinuation.notice,/not completion evidence/);
 assert.equal(c.actionReview.tool,'propose_repair');assert.equal(c.actionReview.arguments.repair,'R6.1');assert(c.repairPlan.repairs[0].after.includes('Math.min(count, limit)'));
 const copies=r.messages.filter(m=>m.tool_name==='propose_test_copy').map(m=>JSON.parse(m.content).result);
 assert.equal(copies[0].diagnosis.stillFailing,3);assert.equal(copies[1].diagnosis.resolved,3);assert.equal(copies[1].runs[1].outcome,'passed');assert(copies[1].diagnosis.change.after.text.includes('Math.min(count, limit)'));
});

test('the multi-file partial-copy replay keeps both repairs and full comparison without changing tool schemas',async()=>{
 const {record:w,system}=JSON.parse(await readFile(new URL('fixtures/diagnosis-layout-context-replay.json',import.meta.url))),before=JSON.stringify(w),wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),tools=wf.toolsFor(w),toolsBefore=JSON.stringify(tools);
 const r=focusedRequest(w,{system,history:wf.executionHistory(w),context:wf.context(w),tools}),c=JSON.parse(r.messages.at(-1).content);
 assert(r.inputBytes<=24000);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);assert.equal(JSON.stringify(w),before);assert.equal(JSON.stringify(tools),toolsBefore);
 assert.deepEqual(r.tools.map(t=>({name:t.function.name,parameters:t.function.parameters})),tools.map(t=>({name:t.function.name,parameters:t.function.parameters})));
 assert.equal(c.repairPlan.repairs.length,2);assert.equal(c.actionReview.arguments.repair,'R5.1');
 const copy=JSON.parse(r.messages.find(m=>m.tool_name==='propose_test_copy').content).result;
 assert.equal(copy.diagnosis.resolved,1);assert.equal(copy.diagnosis.stillFailing,3);assert.equal(copy.diagnosis.tests.length,4);assert(copy.diagnosis.failure.source.text.includes("test('small width'"));assert(!copy.diagnosis.displaySummary);
 assert.match(r.tools.find(t=>t.function.name==='propose_repair').function.description,/exact edit approval/);assert.match(r.tools.find(t=>t.function.name==='record_repair_plan').function.description,/ask_user FIRST/);
});

test('testing both partial repairs before editing preserves both outcomes and the pending separate edit review',async()=>{
 const {record:w,system}=JSON.parse(await readFile(new URL('fixtures/diagnosis-layout-repeat-context-replay.json',import.meta.url))),before=JSON.stringify(w),wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 const r=focusedRequest(w,{system,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)}),c=JSON.parse(r.messages.at(-1).content);
 assert(r.inputBytes<=24000);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);assert.equal(JSON.stringify(w),before);
 const copies=r.messages.filter(m=>m.tool_name==='propose_test_copy').map(m=>JSON.parse(m.content).result);
 assert.deepEqual(copies.map(x=>[x.diagnosis.resolved,x.diagnosis.stillFailing]),[[1,3],[2,2]]);assert(copies.every(x=>x.runs.every(run=>run.outcome==='assertion_failure'&&!run.truncated)));
 assert.equal(c.repairPlan.repairs.length,2);assert.equal(c.actionReview.tool,'propose_repair');assert.equal(c.actionReview.arguments.repair,'R4.1');assert.match(c.actionReview.instruction,/exact Actions approval/);
 assert.equal(copies[1].diagnosis.tests.length,4);assert.match(copies[1].diagnosis.failure.source.text,/reserved margins/);
});
