// Read-only navigation hints. These never create a review or grant approval.
export function plannerAttention({link,task,issue,workflow,actions,health,now=Date.now()}){
 const item=(kind,label,detail,destination='planner',extra={})=>({kind,label,detail,destination,...extra});
 if(issue)return item('task_issue','Review task link',issue);
 if(link.review?.status==='pending')return item(link.review.intent?'completion_save':'completion_review','Review task completion',link.review.intent?'A completion save was interrupted. Review its saved decision before retrying or discarding.':'A saved completion review needs your decision.');
 if(link.attachment?.status==='pending')return item('attachment_review','Review follow-up attachment','A prepared follow-up is waiting to become the current attempt.');
 const pending=workflow?actions.filter(a=>a.workflow?.id===workflow.id&&a.status==='pending'):[];
 if(pending.length){const a=pending[0],expired=Date.parse(a.expires)<=now;return item('approval','Review action',expired?'This approval expired. Review the proposal and the current task before preparing another.':`${pending.length} proposed action${pending.length===1?' needs':'s need'} your review. Nothing is approved by opening this item.`,'workflow',{actionId:a.id});}
 if(task?.done)return null;
 if(!workflow){
  if(link.status==='linked')return item('missing_workflow','Review task link','The current workflow is missing. Review the saved link and attempt history.');
  if(link.status==='creating')return item('creation','Recover execution draft','Plan creation was interrupted. Reopen the saved inputs to review or retry.');
  return item('draft','Review execution draft',task?.revision!==link.task.revision?'The task note changed since this draft was prepared. Review its saved inputs against the current task.':'An execution draft is saved. Review the goal and conditions before preparing a plan.');
 }
 if(workflow.status==='completed')return item('completion','Review task completion','The current workflow finished. Review its results before completing this planner task.');
 if(workflow.status==='cancelled')return item('cancelled','Review stopped task','The current attempt was cancelled. Its results remain available; choose whether to prepare a follow-up or unlink it.');
 const code=health?.code;
 if(code==='waiting_input')return item('question','Answer Aurora',health.detail,'workflow');
 if(code==='needs_verification')return item('verification','Review uncertain result',health.detail,'workflow');
 if(code==='plan_review')return item('plan','Review execution plan',health.detail,'workflow');
 if(['limit','model_changed'].includes(code))return item(code,'Review blocked task',health.detail,'workflow');
 if(['paused','needs_help','waiting_input','needs_verification'].includes(workflow.status))return item('paused','Review paused task',health?.detail||workflow.error||'Review the saved work before continuing.','workflow');
 return null;
}
