import {isProjectRepair} from './workflow-prompt.mjs';
import {projectProgress} from './workflow-project-progress.mjs';
import {testedCopyForRepair,copyReadinessResolved} from './workflow-test-copy.mjs';
import {repairPlanContext} from './workflow-repair-plan.mjs';
import {AppError} from './vault.mjs';

export function validateRoutineContinuation(value,w){
  if(typeof value!=='boolean')throw new AppError('Routine continuation must be true or false.');
  if(value&&!isProjectRepair(w))throw new AppError('Routine continuation needs a project, explicit output files and selected saved checks, without source-reviewed documents.');
}

// An explicit, fixed per-task choice. This selects ordinary journaled tools;
// it cannot execute an action, approve a digest, or declare the goal complete.
export function routineOperation(w){
  if(w.version<15||w.routineContinuation!==true||!isProjectRepair(w)||w.status!=='running'||w.planApprovedRevision!==w.revision||(w.projectToolGroup||'project')!=='project')return null;
  if(w.operations.some(o=>['started','waiting_approval'].includes(o.status)))return null;
  const progress=projectProgress(w),next=progress.next;
  if(!['read_system_file','propose_test_copy','propose_repair','propose_check','verify_outcome'].includes(next?.tool))return null;
  const last=w.operations.at(-1);
  // Failures go back to diagnosis. Only structured copy preparation requests
  // can collect their missing observations before handing control back.
  if(last?.status==='failed'&&!(last.name==='propose_test_copy'&&last.result?.copyReadiness&&next.tool==='read_system_file'))return null;
  if(next.tool==='propose_repair'){
    if(!w.copyBeforeEdit)return null; // No implicit choice of test/edit order.
    const repair=repairPlanContext(w)?.repairs.find(r=>r.id===next.arguments.repair),copy=repair&&testedCopyForRepair(w,repair);
    // Partial candidates with remaining assertions need a model decision.
    if(!copy?.result?.cleanedUp||copy.result.originalSourcesCurrent!==true||copy.result.runs?.length!==2||copy.result.runs[1].outcome!=='passed')return null;
  }
  const boundary={revision:w.revision,checkpoint:w.projectCheckpoint?.id||null,
    plan:w.operations.findLast(o=>o.name==='record_repair_plan'&&o.status==='completed')?.id||null,
    effect:w.operations.findLast(o=>o.action&&['propose_file_edit','propose_command'].includes(o.name))?.id||null};
  const key=JSON.stringify([boundary,next.tool,next.arguments]);
  const previous=w.operations.findLast(o=>o.routine?.key===key);
  if(previous&&!(previous.name==='propose_test_copy'&&copyReadinessResolved(w,previous)))return null;
  return {function:{name:next.tool,arguments:structuredClone(next.arguments)},routine:{key,reason:next.message}};
}
