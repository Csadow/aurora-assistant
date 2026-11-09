import {isProjectRepair} from './workflow-prompt.mjs';
import {requirementStatus} from './workflow-requirements.mjs';
import {repairPlanContext,repairFeedback} from './workflow-repair-plan.mjs';
import {missingOutcomes,evidenceHandle} from './workflow-evidence.mjs';
import {unverifiedWrites} from './workflow-health.mjs';
import {recoveryReads,recoveryContext} from './workflow-recovery.mjs';
import {verificationFloor} from './workflow-checkpoint.mjs';
import {observationNeedsFreshRead} from './workflow-tools.mjs';
import {sha} from './vault.mjs';
import {supportsCopyCheck,testedCopyForRepair,unfinishedSoleRepair,copyReadinessResolved,copyReadinessOutstanding} from './workflow-test-copy.mjs';
import {copyNoBenefitReview} from './workflow-copy-no-benefit.mjs';

// Derived from the journal on every request, never stored as a second source of
// truth. These are next-step suggestions, not approval or proof of the full goal.
export function projectProgress(w){
  if(w.version<7||!isProjectRepair(w))return null;
  const statuses=requirementStatus(w),repairs=repairPlanContext(w)?.repairs||[];
  const files=statuses.filter(s=>s.kind==='file').map(s=>{
    const index=w.operations.findLastIndex(o=>o.name==='read_system_file'&&(o.result?.path||o.arguments?.path)===s.path),op=w.operations[index],r=op?.result;
    const complete=op?.status==='completed'&&!r?.error&&!op.arguments?.offset&&!r?.truncated&&typeof r?.content==='string'&&r.revision===sha(r.content);
    return {path:s.path,passed:s.passed,source:complete&&!observationNeedsFreshRead(w,index,s.path)?evidenceHandle(w,op.id):null,
      observedSinceCheckpoint:!!complete&&index>=verificationFloor(w),...(!s.passed?{detail:s.detail}:{})};
  });
  const checks=statuses.filter(s=>s.kind==='command').map((s,i)=>({id:`C${i+1}`,passed:s.passed,evidence:s.evidence?evidenceHandle(w,s.evidence):null,marker:s.outputIncludes}));
  const outcomes=missingOutcomes(w),readbacks=unverifiedWrites(w),recovery=recoveryReads(w);
  const pending=w.operations.find(o=>o.action&&['started','waiting_approval','interrupted'].includes(o.status));
  const remaining=repairs.filter(r=>!['edit_applied','awaiting_action'].includes(r.state));
  const feedback=repairFeedback(w);
  const ready=!feedback&&!pending&&!remaining.length&&!recovery.length&&!readbacks.length&&!outcomes.length&&statuses.length>0&&statuses.every(s=>s.passed);
  const result={phase:'inspect',readyToFinish:ready,files,checks,remainingRepairs:remaining.map(r=>r.id),next:null,
    notice:'Journal-derived guidance. Check the complete goal before finishing; saved repairs and tests cover only their stated cases. Exact approvals and completion validation still apply.'};
  const next=(phase,message,tool,args)=>Object.assign(result,{phase,next:{message,...tool?{tool,arguments:args}:{}}});
  const read=(path,message)=>next('read',message,'read_system_file',{path});
  if(pending)return next('approval','The saved action is awaiting review or reconciliation. Do not propose it again.');
  if(recovery.length)return read(recovery[0],w.version>=21&&w.engine!=='chatgpt'?`Inspect ${recovery.length} still-missing current ${recovery.length===1?'file':'files'} after the failed saved check before another action. The focused read tool lists up to four remaining paths; request distinct ones together. Repeating an already read file cannot advance recovery.`:'Inspect the current files after the failed check before another action.');
  const discovery=w.operations.findLast(o=>o.revision===w.revision&&o.result?.copyReadiness);
  if(discovery&&!copyReadinessResolved(w,discovery)&&!w.operations.slice(w.operations.indexOf(discovery)+1).some(o=>o.name==='propose_test_copy'&&o.status==='completed')){
    const d=discovery.result.copyReadiness;
    if(d.missing.length)return next('repair','Required source is missing. Ask for the correct file/path; do not fabricate an implementation.','request_help',{reason:'Missing copy dependency',question:'Required source is missing: '+d.missing.join(', ')+'. Where is the correct dependency?'});
    if(w.version>=22&&w.engine!=='chatgpt'){
      const pending=copyReadinessOutstanding(w,discovery).filter(path=>d.neededReads.includes(path));
      if(pending.length){result.copyNeededReads=pending;return read(pending[0],`Read ${pending.length} still-missing copy ${pending.length===1?'source':'sources'} completely. The focused read tool lists up to four distinct paths; a repeat of an already observed file cannot prepare this copy.`);}
    }
    const unread=d.neededReads.find(path=>!w.operations.slice(w.operations.indexOf(discovery)+1).some(o=>o.name==='read_system_file'&&o.status==='completed'&&o.result?.path===path&&!o.result.truncated));
    if(unread)return read(unread,'Read this discovered supporting dependency before requesting the copy again.');
  }
  if(feedback&&w.version>=25&&w.engine==='local'){
    const failedIndex=w.operations.findLastIndex(o=>o.name==='record_repair_plan'&&o.status==='failed'&&o.revision===w.revision);
    const copyIndex=w.operations.findLastIndex((o,i)=>i<failedIndex&&o.name==='propose_test_copy'&&o.status==='completed'&&o.revision===w.revision&&o.result?.diagnosis?.status==='compared');
    const copy=w.operations[copyIndex],d=copy?.result?.diagnosis;
    if(d?.newlyFailing>0&&d.change?.path&&Array.isArray(feedback.issues)&&feedback.issues.some(i=>i.currentSource&&i.path===d.change.path&&i.sourceRevision===d.change.sourceRevision)){
      const names=(baseline,candidate)=>(Array.isArray(d.changes)?d.changes:[]).filter(c=>c.baseline===baseline&&c.candidate===candidate).slice(0,4).map(c=>String(c.name).slice(0,80));
      result.copyDiagnosisReview={copy:evidenceHandle(w,copy.id),repair:copy.result.repair,newlyFailing:{count:d.newlyFailing,tests:names('passed','failed')},resolved:{count:d.resolved,tests:names('failed','passed')},notice:'Reported test statuses for this exact candidate, not a causal verdict or edit approval. Keep the new failure visible while revising the rejected plan.'};
      return next('repair','The last copy introduced a newly failing test while resolving others. The later repair list was rejected without saving. Correct repairFeedback with actual changed source fragments; an unchanged item is not a correction. Source-matched items are still unverified hypotheses. If the goal and tests specify the desired behavior but the source cause remains uncertain, use request_help for local reasoning rather than asking the user to choose a code candidate. Test a distinct revised candidate through review.','record_repair_plan');
    }
  }
  if(feedback&&w.version>=31&&w.engine==='local'&&feedback.issues?.some(i=>i.code==='output_file')&&files.length&&files.every(f=>f.source))return next('repair','The rejected list targeted a supporting test, outside the saved output scope. Choose an allowed output file from repairFeedback, diagnose its current source against the goal and tests, and resubmit the remaining corrections. Do not paste test-helper code into the source or reread unchanged files.','record_repair_plan');
  if(feedback)return next('repair',w.version>=10?'Correct repairFeedback using current source; save the complete list of REMAINING corrections only. Do not re-list completed edits. A source-matched item is still a hypothesis, not a verified diagnosis.':'Correct the fields identified by repairFeedback and resubmit the complete repair list; read current files first if its observations are historical. Source-matched items and the previous list are hypotheses; preserve unrelated corrections and completed actions.');
  if(ready){
    // Prefer current file reads and the check itself; old source handles and
    // example calculations are never suggested as final evidence.
    result.finishEvidence=[...new Set([...files.map(f=>f.source),...checks.map(c=>c.evidence)].filter(Boolean))];
    return next('finish','All recorded requirements, outcome checks and readbacks are satisfied. If the complete goal is met, call finish_step now with finishEvidence. Do not rerun checks or reread unchanged files just to finish. If you found an uncovered issue, select files tools and investigate it.');
  }
  const repair=remaining[0];
  if(repair){
    const noBenefit=copyNoBenefitReview(w,repair);
    if(noBenefit){
      result.copyNoBenefitReview=noBenefit;
      return next('repair','The previous edit already left all saved copy tests passing. This next candidate also passes the same tests without changing any reported outcome. Reconsider its source rationale before another edit. '+(remaining.length===1?'If no other observed requirement needs it, withdraw this sole remaining correction with record_repair_plan({repairs:[]}), then run the original saved check.':'If it is unnecessary, record a revised list containing the OTHER remaining corrections only.')+' If the goal includes untested behavior, select files tools for evidence or request_help; the passing copy alone does not support this edit.','record_repair_plan',remaining.length===1?{repairs:[]}:undefined);
    }
    if(repair.needsFreshRead)return read(repair.path,'Read this repair’s current source once; its saved correction and completed actions are retained.');
    if(repair.exampleLedger?.failed||repair.expressionCheck?.hasFailedExamples)return next('repair',w.version>=11?'Retained examples failed. Correct the diagnosis or request_help for a user example review in Planned repairs; a new passing scenario does not erase a failure.':'This saved correction failed an example. Review the diagnosis and record a corrected repair list; do not repeat the failed proposal.');
    if(w.copyBeforeEdit){
      const done=testedCopyForRepair(w,repair);
      if(done&&done.result.runs?.some(r=>!['passed','assertion_failure'].includes(r.outcome)))return next('repair','The copy has setup or incomplete results. Inspect its dependency/error output and correct the cause, or request_help. Do not propose an edit or repeat unchanged copies.');
      if(done&&w.version>=17&&done.result.diagnosis?.status==='compared'&&(done.result.diagnosis.newlyFailing||done.result.diagnosis.stillFailing&&!done.result.diagnosis.resolved)){
        const guidance='The candidate still reports failures and either resolves none or introduces a new failure. Review its diagnosis comparison, exact source change and observed tests against the goal. Save a revised correction with record_repair_plan FIRST, then use its returned ID; existing IDs still stage the old correction. Or request help. An unchanged copy is not a new experiment. This is guidance, not a correctness verdict or an approval.';
        if(w.version>=21&&w.engine!=='chatgpt'){result.copyDiagnosisReview={repair:repair.id,source:repair.currentRead};return next('repair',guidance+' Current source is already observed; use inspect_source_lines for a needed excerpt, not another unchanged disk read.','record_repair_plan');}
        return next('repair',guidance);
      }
      const unfinished=done&&unfinishedSoleRepair(w,repair,done.result);
      if(unfinished){const d=done.result.diagnosis,resolved=(Array.isArray(d.changes)?d.changes:[]).filter(t=>t.baseline==='failed'&&t.candidate==='passed');result.copyDiagnosisReview={copy:evidenceHandle(w,done.id),repair:repair.id,source:repair.currentRead,resolved:{count:d.resolved,tests:resolved.slice(0,6).map(t=>String(t.name).slice(0,80)),testsExcerpted:resolved.length>6},unresolved:unfinished,candidateApplied:false};return next('repair',`The sole remaining repair improves the copy but still fails ${unfinished.count} saved ${unfinished.count===1?'test':'tests'}. This candidate has not been applied to the original file. Compare the named failure and observed test source with the candidate. record_repair_plan REPLACES the previous list: include every still-needed correction, including the un-applied change that improved the copy if its evidence still supports it, plus any distinct fix for the remaining failure. Test and review each saved correction separately. The copy is partial evidence, not an edit or completion verdict.`,'record_repair_plan');}
      if(done)return next('repair','This exact candidate already has copy results, even if its repair ID changed. Inspect the results and request separate edit review. Assertion failures can remain until other planned repairs are applied; original project checks must eventually pass.','propose_repair',{repair:repair.id});
      const index=w.requirements.commands.findIndex(c=>JSON.stringify(c)===JSON.stringify(w.copyBeforeEdit.check));
      return next('repair',w.version>=22&&w.engine!=='chatgpt'?'This task requires testing each exact candidate before editing. After reading the target and saved test, request the copy review once to discover a bounded list of local imports and manifests; read all named existing files completely, then retry the same candidate. No copy runs until those reads are complete. Numerical examples remain useful when supported.':'This task requires testing each exact candidate before editing. Read required tests/dependencies when prompted; numerical examples remain useful when supported.','propose_test_copy',{repair:repair.id,check:'C'+(index+1)});
    }
    if(w.version>=12&&w.project?.checks?.some(supportsCopyCheck)){
      const copyRequested=/\b(?:temporary|disposable|isolated)\s+cop(?:y|ies)\b|\bcopy[- ]first\b/i.test((w.goal||'')+' '+(w.scope||''));
      if(w.version<19||copyRequested||w.operations.some(o=>o.name==='propose_test_copy'))return next('repair',`Current source is already observed for ${repair.id}; rereading unchanged files does not advance it. If the goal requires a temporary-copy test before editing, use propose_test_copy for THIS repair first and read only any dependencies it requests. Otherwise check numerical examples when supported, then use propose_repair to request exact edit review. A copy result for a different candidate does not test this one. No repair list or copy result is completion proof.`);
      return next('repair',`Current source is already observed for ${repair.id}; rereading unchanged files does not advance it. No copy-first check is saved for this task. If the goal explicitly requires a temporary-copy test before editing, use propose_test_copy for THIS repair and read only dependencies it requests. Otherwise use propose_repair now for exact edit review, then run the saved project check after the edits. A copy result for a different candidate does not test this one. No repair list or copy result is completion proof.`,'propose_repair',{repair:repair.id});
    }
    return next('repair',repair.expressionCheck?.examplesMatch?'Examples match for this correction. Stage the saved repair; do not repeat its examples or source read.':'Stage the next saved correction after checking numerical examples when supported. Reuse its current source handle; do not reread unchanged source.','propose_repair',{repair:repair.id});
  }
  if(recoveryContext(w)?.state==='review_correction')return next('repair',w.version>=26&&w.engine==='local'?'The saved check failed. Its current source and previously observed supporting files were reread after the command. Use the diagnostic and these observations to record the remaining source corrections now. If another file is truly needed, select files tools to inspect it. Repeating the same reads or the unchanged check cannot advance this repair.'+(w.version>=28?' The goal and tests specify the required behavior; choose the code approach from their evidence. Use request_help for uncertain implementation reasoning, and ask_user only for a genuinely missing preference or conflicting requirement.':''):'The saved check failed on the current code. Use its diagnostic and the current source to record a corrected repair list before another check.',w.version>=26&&w.engine==='local'?'record_repair_plan':undefined);
  const rejectedCopy=w.version>=29&&w.engine==='local'&&w.copyBeforeEdit&&!repairs.length&&w.operations.findLast(o=>o.name==='propose_test_copy'&&o.revision===w.revision&&o.status==='failed'&&!o.action&&o.result?.error?.includes('record_repair_plan'));
  if(rejectedCopy&&files.length&&files.every(f=>f.source)&&w.operations.some(o=>o.name==='read_system_file'&&o.status==='completed'&&!o.result?.truncated&&typeof o.result?.content==='string'&&!files.some(f=>f.path===o.result.path)))return next('repair','The copy request failed because no repair is saved. The current target and a supporting test are observed. Record the exact source correction first; use its returned R-number for the copy review. Further discovery remains in Files tools.','record_repair_plan');
  const unchecked=checks.find(c=>!c.passed);
  if(unchecked){
    const unread=files.find(f=>!f.observedSinceCheckpoint);
    if(unread)return read(unread.path,'Inspect required source before diagnosing repairs or running the saved check.');
    if(!repairs.length&&!w.operations.some(o=>o.status==='completed'&&o.expected))return next('inspect','Inspect the relevant tests and record observed repairs. If the source already satisfies the goal, run the saved check.');
    return next('check',repairs.length?'All saved repairs have been applied. Run this saved check once through approval.':'No saved repairs remain. Run this saved check once through approval.','propose_check',{check:unchecked.id,reason:'Verify the current project against the saved requirements.'});
  }
  if(outcomes.length){
    const outcome=outcomes[0],check=checks.find(c=>c.evidence===evidenceHandle(w,outcome.availableObservation?.evidence));
    if(outcome.group==='command'&&check)return next('verify','Verify the actual pass marker from this fresh command result once.','verify_outcome',{evidence:check.evidence,kind:'command_output',expected:check.marker});
    return next('verify',outcome.required);
  }
  const unread=files.find(f=>!f.passed);
  if(unread){
    if(unread.source)return next('repair','The fresh output does not meet its saved requirements. Inspect the reported mismatch and correct it through review. Rereading unchanged text will not resolve it.');
    return read(unread.path,'Read this final output after the last check. Already verified outputs do not need another read.');
  }
  if(readbacks.length){
    const current=files.find(f=>f.path===readbacks[0].path&&f.source);
    if(current)return next('repair','The current file differs from the last approved edit. Investigate the change before claiming completion.');
    return read(readbacks[0].path,'Read back the edited file after the latest action.');
  }
  const desktop=statuses.find(s=>['browser','window'].includes(s.kind)&&!s.passed);
  if(desktop)return next('verify','Select desktop tools if needed. '+desktop.detail);
  return next('inspect','Review the complete goal and the remaining observed work.');
}
