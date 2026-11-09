import {bindRepairExpression} from './repair-expression-binding.mjs';
import {randomUUID} from 'node:crypto';
import {AppError,sha} from './vault.mjs';
import {repairPlanContext} from './workflow-repair-plan.mjs';
import {exampleScope} from './workflow-example-ledger.mjs';
import {expressionExamples} from './repair-expression.mjs';
import {resolveEvidence} from './workflow-evidence.mjs';
const sample=c=>({inputs:c.inputs,expected:c.expected});
const text=(s,max,label)=>{if(typeof s!=='string'||!s.trim()||s.length>max)throw new AppError(`Supply ${label} (1–${max} characters).`);return s;};
export async function workflowExampleReview(service,w,input){
  if(w.version<11)throw new AppError('Example review is available for new tasks. This task retains its original behavior.',409);
  if(!['preview','apply'].includes(input.operation))throw new AppError('Choose preview or apply.');
  if(service.running.has(w.id)||service.reconciling.has(w.id)||!['paused','needs_help'].includes(w.status))throw new AppError('Pause the task before reviewing examples.',409);
  if(w.operations.some(o=>o.action&&['started','waiting_approval','interrupted'].includes(o.status)))throw new AppError('Resolve pending or interrupted actions before reviewing examples.',409);
  if(w.operations.length>=72)throw new AppError('This task has reached its operation limit.',409);
  if(input.revision!==w.revision)throw new AppError('The task revision changed. Open a new review.',409);
  const repair=repairPlanContext(w)?.repairs.find(r=>r.id===input.repair);
  if(!repair||['edit_applied','awaiting_action'].includes(repair.state))throw new AppError('Choose a remaining repair from the current list.',409);
  const entry=repair.exampleLedger?.cases.find(c=>c.id===input.caseId);
  if(!entry)throw new AppError('Choose an existing example from this repair.',409);
  const reason=text(input.reason,600,'a reason'),p=input.provenance;
  if(!p||!['goal','source'].includes(p.kind)||Object.keys(p).some(k=>!['kind','quote','evidence'].includes(k)))throw new AppError('Cite the task goal or an observed source.');
  const quote=text(p.quote,1200,'an exact source quote');let provenance;
  const current=async path=>{
    await service.projectWorkspaces?.target(w.project,path);
    const r=await service.actions.system.read(path);
    if(r.truncated||typeof r.content!=='string'||r.revision!==sha(r.content))throw new AppError('Review needs a complete unredacted current file.',409);
    return r;
  };
  if(p.kind==='goal'){
    if(p.evidence!==undefined||!w.goal.includes(quote))throw new AppError('The quote must occur exactly in the current task goal.');
    provenance={kind:'goal',quote,revision:w.revision};
  }else{
    const op=w.operations.find(o=>o.id===resolveEvidence(w,p.evidence));
    if(op?.name!=='read_system_file'||op.status!=='completed'||op.result?.error||op.arguments?.offset||op.result?.truncated||typeof op.result?.content!=='string'||op.result.revision!==sha(op.result.content)||!op.result.content.includes(quote))throw new AppError('Cite an exact quote from a complete observed file read.');
    const r=await current(op.result.path);
    if(r.revision!==op.result.revision)throw new AppError('The cited source changed. Read it again before reviewing.',409);
    provenance={kind:'source',quote,evidence:p.evidence,path:r.path,revision:r.revision};
  }
  const observation=w.operations.findLast(o=>o.name==='read_system_file'&&(o.result?.path||o.arguments?.path)===repair.path);
  const source=await current(repair.path);
  if(observation?.status!=='completed'||observation.arguments?.offset||observation.result?.truncated||source.revision!==observation.result?.revision)throw new AppError('The repair source changed or was not fully observed. Read it again before reviewing.',409);
  // Check the saved replacement against the actual line, not merely a hash of a
  // previous calculator result. This snapshot is never task completion evidence.
  const binding=bindRepairExpression({content:source.content,line:repair.line,before:repair.before,after:repair.after});
  if(binding.status!=='bound'||JSON.stringify([binding.before,binding.after,binding.column])!==JSON.stringify([repair.expressionBinding.before,repair.expressionBinding.after,repair.expressionBinding.column]))throw new AppError('The saved expression changed. Review the diagnosis first.',409);
  const verdict=expressionExamples(binding.before,binding.after,[{inputs:input.inputs,expected:input.expected}])[0],after=sample(verdict),before=entry.effective;
  if(JSON.stringify([Object.entries(before.inputs).sort(),before.expected])===JSON.stringify([Object.entries(after.inputs).sort(),after.expected]))throw new AppError('Change at least one input or the expected result.');
  const preview={repair:repair.id,caseId:entry.id,scope:exampleScope(repair),original:entry.original,before,after,verdict,reason,provenance,source:{path:source.path,revision:source.revision},expression:{before:binding.before,after:binding.after},notice:'Save changes only to this example. The original failure stays in the journal. This does not edit files, run commands, resume the task or verify completion.'};
  const digest=sha(JSON.stringify({preview,workflow:w}));
  if(input.operation==='preview'){
    const token=randomUUID();service.examplePreviews.set(w.id,{token,digest});return {...preview,token};
  }
  const prepared=service.examplePreviews.get(w.id);
  if(!prepared||prepared.token!==input.token||prepared.digest!==digest)throw new AppError('This preview is stale or was already saved. Preview the correction again.',409);
  w.operations.push({id:randomUUID(),name:'review_repair_example',actor:'user',revision:w.revision,status:'completed',at:new Date().toISOString(),arguments:{repair:repair.id,caseId:entry.id},result:preview});
  await service.save(w);service.examplePreviews.delete(w.id);
  return {saved:true,review:preview,workflow:await service.read(w.id)};
}
