import {mayChangeFiles} from './workflow-requirements.mjs';
import {verificationFloor} from './workflow-checkpoint.mjs';
import {missingOutcomes} from './workflow-evidence.mjs';

const successful=o=>o.status==='completed'&&!o.result?.error;
const short=(value,n=240)=>String(value||'').slice(0,n);
const age=(time,now)=>Number.isFinite(Date.parse(time))?Math.max(0,now-Date.parse(time)):0;
export const workflowLimits={calls:48,operations:72,activeMs:1800000};

export function unverifiedWrites(w){
  const latest=new Map();for(const op of w.operations)if(op.expected)latest.set(op.expected.path,op);
  return [...latest.values()].filter(edit=>{
    const read=w.operations.findLast(o=>successful(o)&&o.name==='read_system_file'&&o.result?.path===edit.expected.path);
    return !read||w.operations.indexOf(read)<verificationFloor(w)||read.result.revision!==edit.expected.revision||read.started<edit.finished||w.operations.slice(w.operations.indexOf(read)+1).some(mayChangeFiles);
  }).map(o=>o.expected);
}

function observation(op){
  if(!op)return null;
  const r=op.result||{},action=op.arguments?.operation;
  let text;
  if(op.name==='verify_outcome')text=`Checked ${r.kind?.replaceAll('_',' ')}: ${r.expected}`;
  else if(op.name==='read_system_file')text=`Read ${r.path}`;
  else if(op.name==='user_verification')text='Your observation: '+r.content;
  else if(op.name==='propose_file_edit')text=`Saved ${op.expected?.path||op.arguments?.path}; readback is checked separately.`;
  else if(op.name==='propose_command')text=`Command exited ${r.code}. Its output and intended result still need checking.`;
  else if(op.name==='computer_action'&&r.url)text=`Observed page: ${r.title||r.url}`;
  else if(op.name==='computer_action'&&action==='windows')text=`Observed ${r.windows?.length||0} open windows.`;
  else text=`${op.name.replaceAll('_',' ')} returned a result.`;
  return {id:op.id,at:op.finished||op.started,summary:short(text),source:op.name==='user_verification'?'user':'tool'};
}

// Read-only projection. Polling never resumes, retries or grants an approval.
export function workflowHealth(w,{now=Date.now(),actions=[],desktop={online:false,enabled:false},runner=null,busy=false,model,generation,account=null,segmentMs=600000}={}){
  const linked=actions.filter(a=>a.workflow?.id===w.id),pending=linked.find(a=>a.status==='pending'),running=linked.find(a=>a.status==='running');
  const last=w.operations.findLast(o=>successful(o)&&!['finish_step','ask_user','request_help','consult_cloud'].includes(o.name));
  const completed=w.status==='completed',finished=completed||w.status==='cancelled';
  const elapsed=(w.activeMs||0)+(runner?Math.max(0,now-runner.startedAt):0);
  const limit=w.calls>=workflowLimits.calls||w.operations.length>=workflowLimits.operations||elapsed>=workflowLimits.activeMs;
  const mismatch=w.engine==='chatgpt'?(w.model!==model||w.chatgptClientId!==account):!!model&&(w.model!==model||JSON.stringify(w.generation||{})!==JSON.stringify(generation||{}));
  const phase=w.activity?.phase||('planning'===w.status?'planning':'reasoning');
  const since=running?.started||w.activity?.since||w.updated;
  const elapsedMs=age(since,now),slow=!!runner&&elapsedMs>=180000;
  const failed=w.operations.findLast(o=>o.status==='failed'||o.status==='interrupted');
  const choices=[];const choose=(id,label,detail,action)=>choices.push({id,label,detail,...action?{action}: {}});
  let code=w.status,headline='',detail='',attention='normal';
  if(finished){headline=completed?'Task completed':'Task cancelled';detail=completed?'Saved results and evidence are available below.':'Saved evidence remains available. No work will resume.';}
  else if(running){
    code='action_running';headline='An action is running';detail=running.kind==='computer'&&!desktop.online?'The desktop connection is unavailable. This action may have partly run; wait for its recorded outcome or stop it.':`Waiting for the ${running.kind==='command'?'command':running.kind==='cloud'?'reviewed consultation':running.kind==='write'?'file edit':'desktop action'} to finish.`;
    attention=running.kind==='computer'&&!desktop.online?'attention':elapsedMs>45000?'slow':'normal';
    choose('pause','Stop task','Stop current work and retain its evidence.');
  }else if(w.status==='needs_verification'){
    headline='Check what actually happened';attention='attention';detail=short(w.error||'An interrupted or failed action has an uncertain result. Nothing will replay automatically.',700);
    choose('verify','Record what you checked','Inspect the affected file or app, then save the actual outcome.');
  }else if(limit&&!runner){
    code='limit';headline='This task reached its work limit';detail='Keep its saved results and start a smaller follow-up. Resuming cannot reset the original budget.';attention='attention';choose('follow_up','Prepare a follow-up','Start a new focused task after reviewing the remaining work.');
  }else if(w.question){
    code='waiting_input';headline='Aurora needs your answer';detail=short(w.question,1000);attention='attention';choose('update','Answer or change the task','Your answer revises the remaining plan and retires outdated approvals.');
  }else if(mismatch&&!runner){
    code='model_changed';headline=w.engine==='chatgpt'?'The ChatGPT account or model changed':'The local model settings changed';detail=w.engine==='chatgpt'?'Select this task’s original ChatGPT account and model in Settings before resuming. Saved work and approvals remain in place.':'Review a model transition, or restore this task’s original model and reasoning settings.';attention='attention';choose(w.engine==='chatgpt'?'chatgpt':'model',w.engine==='chatgpt'?'Review ChatGPT connection':'Review model change','Completed work and execution limits are retained.');
  }else if(pending&&w.status==='waiting_approval'){
    code=Date.parse(pending.expires)<=now?'approval_expired':'approval';headline=code==='approval'?'Waiting for your approval':'The approval expired';attention='attention';
    detail=code==='approval'?'Review the exact proposed action. Waiting for approval is not a stalled task.':'This proposal cannot run. Review its outcome and update the task for a fresh proposal.';
    choose('review','Review action','Inspect the exact target, payload and approval status.',pending.id);choose('pause','Pause task','Keep the proposal and saved progress.');
  }else if(w.planReviewRequired&&w.planApprovedRevision!==w.revision&&!w.needsPlan&&w.current<w.steps.length&&!runner){
    code='plan_review';headline='Review the plan before starting';detail='Check the new inputs, proposed steps and outcome checks below. Approving the plan does not approve file edits, commands, input or cloud requests.';attention='attention';choose('approve_plan','Approve plan & start','Run this reviewed plan with the existing action approval rules.');choose('update','Revise the plan','Change the goal or constraints and review the new plan.');
  }else if(runner){
    code=slow?'slow':phase;headline=phase==='planning'?'Planning the remaining work':phase==='critique'?'Reviewing the draft against your requirements':phase==='verification'?'Checking whether the step is complete':phase==='tool'?'Waiting for a tool result':'Reasoning about the next action';
    detail=slow?(w.engine==='chatgpt'?'This is taking longer than usual. You can keep waiting or pause and narrow the task.':'This is taking longer than usual. The local model can be slow; you can keep waiting or pause and narrow the task.'):'The current step is active. New results appear when the operation finishes.';
    attention=slow?'slow':'normal';choose('pause','Pause task','Stop current generation; completed work stays saved.');
  }else if(w.status==='waiting_approval'){
    code='reconciling';headline='Recording the action result';detail='Aurora is updating the saved task before continuing. Completed actions are not repeated.';choose('pause','Pause task','Keep this task paused after recording the result.');
  }else if(w.status==='queued'){
    headline=busy?(w.engine==='chatgpt'?'Waiting for another response':'Waiting for the local model'):'Ready to continue';detail=busy?(w.engine==='chatgpt'?'Another response is using Aurora. This task keeps its place in the queue.':'Another local response is using the model. This task keeps its place in the queue.'):(w.engine==='chatgpt'?'Aurora will pick up the remaining plan when the selected ChatGPT model is available.':'Aurora will pick up the remaining plan when the local model is available.');choose('pause','Pause task','Leave it paused instead of continuing automatically.');
  }else{
    headline=w.status==='needs_help'?'Aurora needs help to continue':'Task paused';detail=short(w.error||'Review the saved work before continuing.',700);attention=w.status==='needs_help'?'attention':'normal';
    choose('resume',w.status==='needs_help'?(w.engine==='chatgpt'?'Continue with ChatGPT':'Continue locally'):'Resume task','Continue from the saved evidence with the same approvals.');
    choose('update','Adjust remaining work','Describe a smaller goal, a different app, or a corrected target.');
    if(w.status==='needs_help')choose('help','Review stronger help','Edit a local draft; nothing goes online before approval.');
  }
  const desktopRelevant=!finished&&(running?.kind==='computer'||pending?.kind==='computer'||failed?.name==='computer_action');
  if(desktopRelevant&&(!desktop.enabled||!desktop.online))choose('desktop',desktop.enabled?'Open Aurora desktop':'Review computer permissions',desktop.enabled?'Reconnecting alone will not repeat an interrupted action.':'Enable only the access you want, then review the task state.');
  return {code,headline,detail,attention,lastObserved:observation(last),currentStep:w.steps[w.current]?{title:w.steps[w.current].title,check:w.steps[w.current].check}:null,remaining:w.steps.filter(s=>s.status!=='completed').map(s=>s.title),needsPlan:!!w.needsPlan||!w.steps.length,wait:!finished&&(runner||running)?{since,seconds:Math.floor(elapsedMs/1000),slow,boundSeconds:runner?Math.ceil(Math.min(segmentMs,Math.max(0,workflowLimits.activeMs-(w.activeMs||0)))/1000):null}:null,budget:{calls:w.calls,operations:w.operations.length,activeSeconds:Math.floor(elapsed/1000),limits:workflowLimits},outstanding:finished?[]:[...unverifiedWrites(w).map(x=>({group:'file',path:x.path})),...(w.version>=2?missingOutcomes(w).map(x=>({group:x.group,required:x.required})):[])],choices};
}
