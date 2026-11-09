import {AppError} from './vault.mjs';

export function taskIntent(message,mode){
  const text=message.trim(),plain=text.replace(/[.!?]+$/,'').toLowerCase();
  for(const [operation,pattern] of [['pause',/^(?:\/pause|(?:please )?(?:pause|stop)(?: (?:the |this |current )?task)?(?: please)?)$/],['resume',/^(?:\/resume|(?:please )?(?:resume|continue)(?: (?:the |this |current )?task)?)$/],['cancel',/^(?:\/cancel|cancel (?:the |this |current )?task)$/],['status',/^(?:\/status|(?:task )?status|how is (?:the |this |that )?task going|what is the task status)$/]])if(pattern.test(plain))return {operation};
  if(mode==='act'&&!text.startsWith('/'))return null;
  if(/^\/steer\s+/i.test(text))return {operation:'steer',instruction:text.replace(/^\/steer\s+/i,'')};
  if(mode==='steer'||/^(?:please )?(?:skip (?:that |this |the current )step|(?:use|save|put|write|switch|change|move)\b.*\binstead\b)/i.test(text))return {operation:'steer',instruction:text};
  return null;
}

// User messages reach this route before the inference lock. Web pages and model
// tool calls cannot invoke it or authorize a task change.
export async function taskChat(assistant,input,signal,emit){
  const {id,message,mode,workflowId,actionId}=input,intent=!actionId&&taskIntent(message,mode);
  if(!intent)return false;
  const c=await assistant.store.get('conversations',id),target=workflowId||[...c.messages].reverse().find(m=>m.workflow)?.workflow;
  if(!target){if(mode==='steer'||/^\/(pause|resume|cancel|status|steer)\b/i.test(message))throw new AppError('Start or open a saved task before updating it.');return false;}
  let w=await assistant.store.get('workflows',target);
  if(w.conversation!==id)throw new AppError('This task belongs to another conversation. Open its workflow to update it.',403);
  assistant.taskChats??=new Set();
  if(assistant.taskChats.has(id)||assistant.busy.has(id))throw new AppError('Wait for this conversation update to finish.',409);
  assistant.taskChats.add(id);
  try{
    signal?.throwIfAborted();if(c.messages.length>=400)throw new AppError('Use the workflow workspace to update this task; the conversation is full.');
    if(intent.operation==='steer')w=await assistant.workflows.steer(target,intent.instruction);
    else if(intent.operation!=='status')w=await assistant.workflows.control(target,intent.operation);
    if(intent.operation==='status')w=await assistant.workflows.read(target);
    const answer=intent.operation==='steer'?`I’ve saved your update and retired pending approvals from the old plan. ${w.status==='needs_verification'?'Check the interrupted action before resuming.':'I’ll revise the remaining steps and keep completed work.'}`:intent.operation==='status'?`Task: ${w.status.replaceAll('_',' ')}. ${w.current}/${w.steps.length} steps completed.${w.health?'\n\n'+w.health.headline+'. '+w.health.detail+(w.health.currentStep?'\nCurrent step: '+w.health.currentStep.title:'')+(w.health.lastObserved?'\nLast observed result: '+w.health.lastObserved.summary:'')+(w.health.choices.length?'\nNext: '+w.health.choices.map(c=>c.label).join(' · '):''):''}${w.question?'\n\n'+w.question:''}${w.error?'\n\n'+w.error:''}${w.status==='completed'?'\n\n'+w.result:''}`:`Task ${w.status.replaceAll('_',' ')}. ${w.error||'The saved progress is available in Workflows.'}`;
    c.messages.push({role:'user',content:message,at:new Date().toISOString()},{role:'assistant',content:answer,workflow:target,sources:[],at:new Date().toISOString()});c.updated=new Date().toISOString();
    await assistant.store.put('conversations',c);await assistant.store.journal(assistant.vault,c);
    emit({type:'workflow',workflow:{id:target,status:w.status,control:true}});emit({type:'chunk',text:answer});emit({type:'done',conversation:c});return true;
  }finally{assistant.taskChats.delete(id);}
}
