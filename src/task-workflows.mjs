import {randomUUID} from 'node:crypto';
import {AppError,sha,parseNote} from './vault.mjs';
import {tasksIn} from './task-meta.mjs';
import {taskSignature} from '../mobile/web/planner-core.js';
import {taskGraph,taskRef} from '../mobile/web/task-links.js';
import {prepareRequirements} from './workflow-requirements.mjs';
import {completionReview} from './workflow-completion.mjs';
import {plannerAttention} from './planner-attention.mjs';
import {workflowHealth} from './workflow-health.mjs';

const kind='task-workflows',stamp=()=>new Date().toISOString();
const workflowHash=w=>sha(JSON.stringify(w));
const attemptHash=w=>{const {updated,activeMs,...stable}=w;return sha(JSON.stringify(stable));};
const inputHash=d=>sha(JSON.stringify({goal:d.goal,scope:d.scope,requirements:d.requirements}));
const same=(a,b)=>a.path===b.path&&taskSignature(a)===taskSignature(b);
export class TaskWorkflows {
 constructor({vault,store,workflows}){Object.assign(this,{vault,store,workflows});this.locks=new Set();}
 async lock(id,fn){if(this.locks.has(id))throw new AppError('This planner link is being updated. Retry shortly.',409);this.locks.add(id);try{return await fn();}finally{this.locks.delete(id);}}
 async current(id,{expected,open=false,ready=false}={}){
  const tasks=await this.vault.tasks(),matches=tasks.filter(t=>t.id===id);
  if(!id||matches.length!==1||matches[0].scheduleError)throw new AppError('This task is missing or has an invalid or duplicate ID. Repair its Markdown metadata or save it through Edit / schedule.',409);
  const t=matches[0];if(expected&&(!same(t,expected)||t.revision!==expected.revision))throw new AppError('The planner task changed. Refresh and review its current version.',409);
  if(open&&t.done)throw new AppError('This planner task is already marked complete.',409);
  if(ready){const state=taskGraph(tasks).states.get(taskRef(t));if(state?.blocked)throw new AppError('Resolve the task prerequisites first: '+state.reasons.join('; '),409);}
  return t;
 }
 async child(d){try{return await this.store.get('workflows',d.childId);}catch(e){if(e.status!==404)throw e;return null;}}
 async record(id){return this.store.get(kind,id);}
 attempts(d){return d.attempts||[{workflowId:d.childId,number:1,attached:d.created,task:d.task}];}
 async control(ids,fn){const wf=this.workflows;if(ids.some(id=>wf.controls.has(id)))throw new AppError('A workflow is being updated. Retry shortly.',409);ids.forEach(id=>wf.controls.add(id));try{return await fn();}finally{ids.forEach(id=>wf.controls.delete(id));}}
 public(d){const {requestHash,...out}=d;if(out.firstStep){const {hash,...source}=out.firstStep;out.firstStep=source;}if(out.review){const {intent,...review}=out.review;out.review={...review,interrupted:!!intent&&review.status==='pending'};}return out;}
 async read(id){const d=await this.record(id),w=await this.child(d);let currentTask=null,taskIssue=null;try{currentTask=await this.current(d.task.id);}catch(e){if(e.status!==409)throw e;taskIssue=e.message;}const attempts=await Promise.all(this.attempts(d).map(async a=>{const prior=await this.store.get('workflows',a.workflowId).catch(e=>{if(e.status!==404)throw e;return null;});return {...a,current:a.workflowId===d.childId,status:prior?.status||'missing',goal:prior?.goal||'Workflow unavailable'};}));return {...this.public(d),attempts,currentTask,taskIssue,workflow:w?{id:w.id,status:w.status,current:w.current,total:w.steps.length,goal:w.goal}:null};}
 async input(data){
  if(typeof data.goal!=='string'||!data.goal.trim()||data.goal.length>6000||typeof data.scope!=='string'||data.scope.length>2000)throw new AppError('Review the goal (up to 6,000 characters) and workspace (up to 2,000).');
  return {goal:data.goal.trim(),scope:data.scope,requirements:await prepareRequirements(data.requirements,this.workflows.actions.system)};
 }
 async summary({includeResults=false}={}){
  const [records,tasks,workflows,actions]=await Promise.all([this.store.list(kind),this.vault.tasks(),this.store.list('workflows'),this.store.list('actions')]);
  return records.filter(d=>d.status!=='unlinked').map(d=>{const found=tasks.filter(t=>t.id===d.task.id),t=found.length===1?found[0]:null,w=workflows.find(w=>w.id===d.childId),changed=t?!same({...t,done:d.task.done},d.task):true;
   const issue=found.length!==1?'This planner task is missing or has a duplicate ID. Review its Markdown metadata.':t.scheduleError?'This task has invalid scheduling metadata. Repair it in the planner.':records.filter(r=>r.status!=='unlinked'&&r.task.id===d.task.id).length>1?'This task has more than one execution link. Review the links before continuing.':null;
   const wf=this.workflows,health=w?workflowHealth(w,{actions,desktop:wf.actions.computer.status?.(),runner:wf.running.get(w.id),busy:wf.assistant.busy.size>0,model:wf.assistant.ollama.model,generation:wf.assistant.ollama.generationOptions,segmentMs:wf.segmentMs}):null;
   const attention=plannerAttention({link:d,task:t,issue,workflow:w,actions,health});
   const attempts=this.attempts(d),number=attempts.find(a=>a.workflowId===d.childId)?.number||1,detail=found.length!==1?'Task identity needs attention':d.review?.intent&&d.review.status==='pending'?'Completion save interrupted · review required':t.done?'Planner task marked complete':!w&&d.status==='linked'?'Current workflow missing · link needs attention':w?.status==='completed'?'Workflow finished · review before completing task':w?`${w.status.replaceAll('_',' ')} · ${w.current}/${w.steps.length} steps`:d.status==='creating'?'Creation interrupted · reopen draft':'Saved execution draft';
   const result=includeResults&&w?completionReview(w):null;
   const review=includeResults?{executionRevision:sha(JSON.stringify([d,w?attemptHash(w):null,attention])),results:result?{notice:result.notice,question:result.question,error:result.error,steps:result.steps.slice(-6).map(s=>({title:s.title,status:s.status,summary:s.summary.slice(0,1200)})),stepCount:result.steps.length,checksPassed:result.checks.filter(c=>c.passed).length,checksTotal:result.checks.length,unresolved:[...result.checks.filter(c=>!c.passed).map(c=>c.detail),...result.missingOutcomes.map(o=>o.required),...result.pending.map(o=>'Pending operation: '+o.name)].slice(0,8)}:null}:{};
   return {...review,id:d.id,taskId:d.task.id,text:t?.text||d.task.text,path:t?.path||d.task.path,planDate:t?.planDate||null,due:t?.due||null,done:t?.done??null,changed,identityIssue:!!issue,workflowId:w?.id||null,status:w?.status||d.status,current:w?.current||0,total:w?.steps.length||0,attempt:number,attemptCount:attempts.length,attention,reviewPending:d.review?.status==='pending',attachmentPending:d.attachment?.status==='pending',detail:(w||d.status==='linked'?`Attempt ${number} of ${attempts.length} · `:'')+detail+(d.attachment?.status==='pending'?' · Follow-up attachment awaiting review':'')};
  });
 }
 async attention(id){await this.record(id);return (await this.summary()).find(d=>d.id===id)||null;}
 draft({task},{firstStep=null,beforeCommit}={}){return this.lock('task:'+task?.id,async()=>{
  const t=await this.current(task?.id,{expected:task,open:true,ready:true});
  const existing=(await this.store.list(kind)).filter(d=>d.task.id===t.id&&d.status!=='unlinked');
  if(existing.length>1)throw new AppError('Duplicate planner links need repair.',409);
  if(existing.length)return this.read(existing[0].id);
  const d={id:randomUUID(),childId:randomUUID(),task:t,revision:1,status:'draft',created:stamp(),updated:stamp(),goal:'Help complete this planner task: '+t.text+'\n\nInspect the relevant current files or applications, carry out the reviewed scope and report the observed result. Leave the planner checkbox for my completion review.',scope:t.project?'Project note: '+t.project:'',requirements:{files:[],commands:[]}};
  if(firstStep){d.firstStep=firstStep;d.goal='Help with this reviewed first step for '+t.text+':\n\n'+firstStep.text+'\n\nKeep the work within this step. Review the workspace and success conditions before preparing a plan. Leave planner completion for my separate review.';}
  await this.store.put(kind,d,{beforeCommit});return this.read(d.id);
 });}
 save(data){return this.lock(data.id,async()=>{const d=await this.record(data.id);if(d.status==='unlinked'||d.revision!==data.revision||await this.child(d))throw new AppError('This draft changed or already created a workflow. Reopen it.',409);Object.assign(d,await this.input(data),{status:'draft',revision:d.revision+1,updated:stamp()});delete d.request;delete d.requestHash;await this.store.put(kind,d);return this.read(d.id);});}
 start(data){return this.lock(data.id,async()=>{
  const d=await this.record(data.id);if(d.status==='unlinked')throw new AppError('This planner link was removed.',409);
  const w=await this.child(d),hash=inputHash(data);if(w){if(d.requestHash!==hash||w.plannerTask?.linkId!==d.id)throw new AppError('This draft already created a workflow with different inputs.',409);return {id:w.id};}
  if(d.revision!==data.revision||d.requestHash&&d.requestHash!==hash)throw new AppError('The saved draft changed. Reopen it.',409);
  if(data.acknowledge!==true)throw new AppError('Review the goal and success conditions first.');
  const input=await this.input(data),verify=()=>this.current(d.task.id,{expected:d.task,open:true,ready:true});await verify();
  Object.assign(d,input,{status:'creating',request:{goal:data.goal,scope:data.scope,requirements:data.requirements},requestHash:hash,updated:stamp()});await this.store.put(kind,d);
  const child=await this.workflows.start(input,{reservedId:d.childId,plannerTask:{linkId:d.id,taskId:d.task.id,path:d.task.path,text:d.task.text},beforeSave:verify});
  d.status='linked';await this.store.put(kind,d);return {id:child.id};
 });}
 async stopped(w){if(this.workflows.running.has(w.id)||this.workflows.reconciling.has(w.id)||['running','planning','queued','waiting_approval'].includes(w.status)||w.operations.some(o=>['started','waiting_approval'].includes(o.status))||(await this.store.list('actions')).some(a=>a.workflow?.id===w.id&&['pending','running'].includes(a.status)))throw new AppError('Stop the workflow and finish or dismiss pending actions first.',409);}
 unlink({id,revision}){return this.lock(id,async()=>{const d=await this.record(id);if(d.revision!==revision)throw new AppError('This link changed. Reopen it.',409);if(d.review?.status==='pending'||d.attachment?.status==='pending')throw new AppError('Finish or discard the pending completion or attachment review first.',409);const w=await this.child(d);if(w)await this.stopped(w);d.status='unlinked';d.revision++;d.updated=stamp();await this.store.put(kind,d);return {unlinked:true};});}
 async attachable(d,targetId){
  if(d.status==='unlinked')throw new AppError('This planner link was removed.',409);
  if(d.review?.status==='pending')throw new AppError('Finish or discard the completion review first.',409);
  const source=await this.child(d),target=await this.store.get('workflows',targetId);
  if(!source||target.followUp?.sourceId!==source.id||target.id===source.id)throw new AppError('Choose a direct follow-up of the current attempt.',409);
  await this.stopped(source);await this.stopped(target);
  if(!['plan_review','paused'].includes(target.status)||!target.planReviewRequired||target.planApprovedRevision!=null||target.needsPlan||target.current!==0||!target.steps.length||target.operations.length)throw new AppError('Choose a freshly prepared follow-up plan before approving or running it.',409);
  if((await this.store.list(kind)).some(link=>link.status!=='unlinked'&&this.attempts(link).some(a=>a.workflowId===target.id)))throw new AppError('This follow-up is already attached to a planner task.',409);
  const task=await this.current(d.task.id,{open:true,ready:true});return {source,target,task};
 }
 async candidates(id){const d=await this.record(id),all=await this.store.list('workflows'),items=[];for(const w of all.filter(w=>w.followUp?.sourceId===d.childId)){let issue=null;try{await this.attachable(d,w.id);}catch(e){if(![404,409].includes(e.status))throw e;issue=e.message;}items.push({id:w.id,goal:w.goal,status:w.status,issue});}return {revision:d.revision,sourceId:d.childId,items};}
 previewAttachment({id,revision,targetId}){return this.lock(id,async()=>{
  const d=await this.record(id);if(d.revision!==revision)throw new AppError('The current attempt changed. Reopen the planner link.',409);
  if(d.attachment?.status==='pending'){if(d.attachment.targetId===targetId)return this.read(id);throw new AppError('Discard the pending attachment review before choosing another follow-up.',409);}
  return this.control([d.childId,targetId],async()=>{const {source,target,task}=await this.attachable(d,targetId);
   if(d.attachment)(d.attachmentHistory??=[]).push(d.attachment);
   d.attachment={id:randomUUID(),status:'pending',created:stamp(),linkRevision:d.revision,sourceId:source.id,targetId,sourceHash:attemptHash(source),targetHash:attemptHash(target),sourceGoal:source.goal,targetGoal:target.goal,steps:target.steps.map(s=>({title:s.title,check:s.check})),task};
   d.updated=stamp();await this.store.put(kind,d);return this.read(id);
  });
 });}
 decideAttachment({id,reviewId,action,acknowledge}){return this.lock('attachments',()=>this.lock(id,async()=>{
  const d=await this.record(id),r=d.attachment;if(!r||r.id!==reviewId||d.status==='unlinked')throw new AppError('The attachment review changed. Reopen the planner link.',409);
  if(!['attach','discard'].includes(action))throw new AppError('Choose Attach or Discard.');
  if(r.status!=='pending'){if(action==='attach'&&r.status==='applied'&&d.childId===r.targetId&&d.revision===r.linkRevision+1)return this.read(id);throw new AppError('This attachment review was already handled.',409);}
  if(action==='discard'){r.status='discarded';r.updated=stamp();await this.store.put(kind,d);return this.read(id);}
  if(acknowledge!==true)throw new AppError('Review the current task and both attempts before attaching the follow-up.');
  if(d.revision!==r.linkRevision||d.childId!==r.sourceId)throw new AppError('The current attempt changed. Discard this review.',409);
  return this.control([r.sourceId,r.targetId],async()=>{
   const {source,target}=await this.attachable(d,r.targetId);await this.current(d.task.id,{expected:r.task,open:true,ready:true});
   if(attemptHash(source)!==r.sourceHash||attemptHash(target)!==r.targetHash)throw new AppError('The reviewed workflow changed. Discard this review and prepare a fresh one.',409);
   d.attempts=this.attempts(d);if(d.review){(d.reviewHistory??=[]).push({...this.public(d).review,workflowId:d.childId});delete d.review;}
   d.attempts.push({workflowId:target.id,number:d.attempts.length+1,sourceId:source.id,attached:stamp(),task:r.task,attachmentId:r.id});d.childId=target.id;d.status='linked';d.revision++;d.updated=stamp();r.status='applied';r.updated=stamp();
   // One atomic link write is the receipt. No workflow approval, inference or Markdown write.
   await this.store.put(kind,d);return this.read(id);
  });
 }));}
 preview({id}){return this.lock(id,async()=>{
  const d=await this.record(id);if(d.status==='unlinked')throw new AppError('This planner link was removed.',409);
  if(d.review?.status==='pending')return this.read(id);
  if(d.attachment?.status==='pending')throw new AppError('Finish or discard the attachment review first.',409);
  const task=await this.current(d.task.id,{open:true}),w=await this.child(d);
  if(!w||w.status!=='completed')throw new AppError('Finish the workflow and inspect its results before completing this planner task.',409);await this.stopped(w);
  if(d.review)(d.reviewHistory??=[]).push({id:d.review.id,status:d.review.status,at:d.review.updated||d.review.created});
  d.review={id:randomUUID(),status:'pending',created:stamp(),task,workflowId:d.childId,linkRevision:d.revision,changedSinceStart:!same(task,this.attempts(d).at(-1).task),workflowHash:workflowHash(w),workflowGoal:w.goal,completion:completionReview(w)};
  d.updated=stamp();await this.store.put(kind,d);return this.read(id);
 });}
 decide({id,reviewId,action,acknowledge}){return this.lock(id,async()=>{
  const d=await this.record(id),r=d.review;if(!r||r.id!==reviewId||d.status==='unlinked')throw new AppError('The completion review changed. Reopen it.',409);
  if((r.workflowId&&r.workflowId!==d.childId)||(r.linkRevision!=null&&r.linkRevision!==d.revision))throw new AppError('This completion review belongs to an earlier attempt.',409);
  if(!['complete','discard'].includes(action))throw new AppError('Choose Complete or Discard.');
  if(r.status!=='pending'){if(action==='complete'&&r.status==='applied')return this.read(id);throw new AppError('This review was already handled.',409);}
  if(action==='discard'){r.status='discarded';r.updated=stamp();await this.store.put(kind,d);return this.read(id);}
  if(acknowledge!==true)throw new AppError('Review the recorded results and current planner task before marking it complete.');
  const wf=this.workflows;if(wf.controls.has(d.childId))throw new AppError('The workflow is being updated. Retry shortly.',409);wf.controls.add(d.childId);
  try{
   const note=await this.vault.read(r.task.path);
   if(r.intent&&note.revision===r.intent.afterRevision){await this.current(r.task.id,{expected:r.intent.after});await this.vault.taskHistory?.report();r.status='applied';r.updated=stamp();await this.store.put(kind,d);return this.read(id);}
   const verify=async()=>{await this.current(r.task.id,{expected:r.task,open:true});const w=await this.child(d);if(!w||w.status!=='completed'||workflowHash(w)!==r.workflowHash)throw new AppError('The workflow results changed. Discard this review and prepare a fresh one.',409);await this.stopped(w);};
   await verify();
   if(!r.intent){const lines=note.content.split('\n');lines[r.task.line]=lines[r.task.line].replace(/\[ \]/,'[x]');const content=lines.join('\n'),afterNote=parseNote(note.path,content),after=tasksIn([afterNote]).find(t=>t.id===r.task.id);if(!after?.done)throw new AppError('The reviewed task line changed.',409);r.intent={content,afterRevision:afterNote.revision,after};await this.store.put(kind,d);}
   await this.vault.save(r.task.path,r.intent.content,r.task.revision,{beforeCommit:verify,taskSource:{kind:'workflow_completion',proposalId:r.id}});
   r.status='applied';r.updated=stamp();await this.store.put(kind,d);return this.read(id);
  }finally{wf.controls.delete(d.childId);}
 });}
}
