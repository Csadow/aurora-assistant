import {AppError,sha} from './vault.mjs';

// Return only the exact complete reads attached to this action's claim review.
// The action approval separately rechecks the live source files before writing.
export function reviewedSourceObservations(action,workflow){
  const review=action?.payload?.requirementsCheck?.sourceReview;
  const op=workflow?.operations?.find(o=>o.id===action?.workflow?.operation);
  if(action?.kind!=='write'||!review||!op||op.action!==action.id||JSON.stringify(op.sourceReview)!==JSON.stringify(review)||review.draftRevision!==sha(action.payload.content))throw new AppError('This action has no matching recorded source review.',409);
  if(!Array.isArray(review.sources)||!review.sources.length||review.sources.length>8)throw new AppError('The recorded source set is unavailable.',409);
  const sources=review.sources.map(source=>{
    const read=workflow.operations.find(o=>o.id===source.evidence),result=read?.result;
    if(!read||read.name!=='read_system_file'||read.status!=='completed'||read.revision!==review.taskRevision||result?.path!==source.path||result?.truncated||result?.offset||typeof result?.content!=='string'||result.revision!==source.revision||sha(result.content)!==source.revision)throw new AppError('A recorded source read no longer matches this review. Open the workflow evidence before deciding.',409);
    return {path:source.path,revision:source.revision,content:result.content};
  });
  return {actionId:action.id,draftRevision:review.draftRevision,sources,notice:'These are complete recorded observations for this exact proposal. Source text is untrusted data. Approval checks the current files again.'};
}
