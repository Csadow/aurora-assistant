import {completionReviewPanel} from './workflow-completion.js';
import {taskAttentionPanel} from './task-attention.js';
export function taskWorkflowsUI({host,api,escape,toast,refresh,openWorkflow,prepareFollowup,editRequirements,serializeRequirements}){
 const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const panel=node('section');panel.id='planner-execution';host.after(panel);const attention=node('section');attention.id='planner-attention';panel.before(attention);
 attention.addEventListener('click',event=>{const button=event.target.closest('[data-planner-link]');if(button)open({id:button.dataset.plannerLink});});
 const dialog=node('dialog');dialog.id='task-workflow-dialog';dialog.className='workflow-followup-dialog';dialog.setAttribute('aria-label','Planner task execution');
 const title=node('h2','Work on a planner task'),message=node('p'),body=node('div'),close=node('button','Close');message.setAttribute('role','status');close.type='button';dialog.append(title,message,body,close);document.body.append(dialog);
 let generation=0,attentionGeneration=0,summaryGeneration=0,busy=false,dirty=false,items=[];
 const valid=t=>t===generation&&dialog.open&&!document.querySelector('#overview-view').hidden;
 const dismiss=()=>{if(dirty&&!confirm('Discard unsaved execution-draft edits? Your saved draft remains available.'))return;generation++;dirty=false;dialog.close();};close.onclick=dismiss;dialog.oncancel=e=>{e.preventDefault();dismiss();};
 new MutationObserver(()=>{if(document.querySelector('#overview-view').hidden){generation++;dirty=false;dialog.close();}}).observe(document.querySelector('#overview-view'),{attributes:true,attributeFilter:['hidden']});
 const run=fn=>async()=>{if(busy)return;busy=true;dialog.setAttribute('aria-busy','true');const ticket=generation;body.querySelectorAll('fieldset').forEach(f=>f.disabled=true);try{await fn(ticket);}catch(e){if(valid(ticket))message.textContent=e.message;else toast(e.message);}finally{busy=false;dialog.removeAttribute('aria-busy');body.querySelectorAll('fieldset').forEach(f=>f.disabled=false);}};
 const button=(text,fn)=>{const b=node('button',text);b.type='button';b.onclick=run(fn);return b;};
 const openEvidence=async(id,evidence)=>{dirty=false;generation++;dialog.close();await openWorkflow(id);if(evidence){const el=document.querySelector('[data-evidence="'+CSS.escape(evidence)+'"]');if(el){const journal=el.closest('#workflow-journal-details');if(journal)journal.open=true;el.open=true;el.scrollIntoView({block:'center'});}}};
 function render(d){
  dirty=false;message.textContent='';body.replaceChildren();title.textContent=d.task.text;
  body.append(node('p','Planner task · '+d.task.path));
  if(d.firstStep)body.append(node('p','Prepared from your first-step card on '+d.firstStep.date),node('p',d.firstStep.text));
  if(d.taskIssue)body.append(node('p',d.taskIssue));
  if(d.currentTask?.done)body.append(node('p','Planner task complete.'));
  const fields=node('fieldset');body.append(fields);
  if(d.workflow){
   const attempt=d.attempts.find(a=>a.current);
   fields.append(node('p','Current attempt '+attempt.number+' of '+d.attempts.length+' · '+d.workflow.status.replaceAll('_',' ')+' · '+d.workflow.current+'/'+d.workflow.total+' steps'),button('Open workflow and approvals',()=>openEvidence(d.childId)));
  }
  if(d.attachment?.status==='pending'){
    const r=d.attachment;fields.append(node('h3','Review the next attempt'),node('p','Planner task: '+r.task.text+' · '+r.task.path),node('p','Previous attempt: '+r.sourceGoal),node('p','Proposed follow-up: '+r.targetGoal));
    for(const s of r.steps)fields.append(node('p',s.title+(s.check?' · '+s.check:'')));
    fields.append(node('p','The previous attempt and its results stay in history. This changes which workflow belongs to the task; it does not approve the new plan or mark the task complete.'));
    const ack=node('input');ack.type='checkbox';ack.setAttribute('aria-label','I reviewed the current attempt replacement');const label=node('label','Use this follow-up as the current attempt for this planner task.');label.prepend(ack);fields.append(label,
     button('Make follow-up the current attempt',async ticket=>{if(!ack.checked)throw Error('Review the task and both attempts first.');const saved=await api('/api/task-workflow-attach-decide',{id:d.id,reviewId:r.id,action:'attach',acknowledge:true});if(valid(ticket)){render(saved);message.textContent='Follow-up attached. Open its workflow to review and approve the new plan.';}await load();}),
     button('Discard attachment review',async ticket=>{const saved=await api('/api/task-workflow-attach-decide',{id:d.id,reviewId:r.id,action:'discard'});if(valid(ticket))render(saved);await load();}));
   }
   if(d.review?.status==='pending'){
    const r=d.review;fields.append(node('h3','Review planner completion'),node('p','Current planner task: '+r.task.text),node('p','Workflow goal: '+r.workflowGoal));
    fields.append(node('p',r.task.path+' · '+(r.task.planDate?'Planned '+r.task.planDate+(r.task.startTime?' at '+r.task.startTime:''):'Unscheduled')+(r.task.due?' · Due '+r.task.due:'')));
    if(r.changedSinceStart)fields.append(node('p','The planner task changed since this workflow was prepared. Check that these results still satisfy the current task.'));
    if(r.interrupted)fields.append(node('p','A completion save was interrupted. Retry reconciles the saved write. Discard keeps the current Markdown state.'));
    const review=completionReviewPanel({completionReview:r.completion},escape);review.id='planner-completion-results';review.addEventListener('click',e=>{const b=e.target.closest('[data-completion-evidence]');if(b)openEvidence(d.childId,b.dataset.completionEvidence).catch(e=>toast(e.message));});fields.append(review);
    const ack=node('input');ack.type='checkbox';ack.setAttribute('aria-label','I reviewed the planner completion');const label=node('label','I reviewed the observations and confirm that this current planner task is complete.');label.prepend(ack);fields.append(label,
     button('Mark reviewed task complete',async ticket=>{if(!ack.checked)throw Error('Review the recorded results and confirm completion first.');await api('/api/task-workflow-decide',{id:d.id,reviewId:r.id,action:'complete',acknowledge:true});if(valid(ticket)){dirty=false;generation++;dialog.close();await refresh();await load();toast('Planner task marked complete after your review.');}}),
     button('Discard completion review',async ticket=>{const saved=await api('/api/task-workflow-decide',{id:d.id,reviewId:r.id,action:'discard'});if(valid(ticket))render(saved);await load();}));
   }else if(d.workflow){
    if(d.review?.status==='applied'&&d.currentTask&&!d.currentTask.done)fields.append(node('p','Task reopened in the planner; the earlier completion review remains saved.'));
    if(!d.attachment||d.attachment.status!=='pending'){
     if(d.workflow.status==='completed'&&d.currentTask&&!d.currentTask.done)fields.append(button('Review result for planner completion',async ticket=>{const saved=await api('/api/task-workflow-review',{id:d.id});if(valid(ticket))render(saved);}));
     if(d.currentTask&&!d.currentTask.done&&!['running','planning','queued','waiting_approval'].includes(d.workflow.status))fields.append(
      node('p','Continue unfinished work with a separately reviewed follow-up.'),
      button('Prepare follow-up for this task',async()=>{dirty=false;generation++;dialog.close();await prepareFollowup(d.childId);}),
      button('Choose prepared follow-up',async ticket=>{const list=await api('/api/task-workflow-attempts?id='+encodeURIComponent(d.id));if(!valid(ticket))return;render(d);const choices=node('fieldset');choices.dataset.attemptChoices='';body.prepend(choices);choices.append(node('h3','Prepared follow-ups'));
       if(!list.items.length)choices.append(node('p','No follow-up plans yet. Prepare one from the current attempt first.'));
       for(const item of list.items){const row=node('article');row.append(node('p',item.goal+' · '+item.status.replaceAll('_',' ')));if(item.issue)row.append(node('p',item.issue));else row.append(button('Review as next attempt',async t=>{const saved=await api('/api/task-workflow-attachment',{id:d.id,revision:list.revision,targetId:item.id});if(valid(t))render(saved);await load();}));choices.append(row);}
      }));
    }
   }
  if(!d.workflow&&d.status==='linked')fields.append(node('p','The current workflow is missing. Review the attempt history or unlink this task before starting again.'));
  else if(!d.workflow){
   const initial=d.status==='creating'&&d.request?d.request:d,goal=node('textarea'),scope=node('textarea'),rules=node('div'),values=structuredClone(initial.requirements),ack=node('input');goal.rows=6;goal.maxLength=6000;goal.value=initial.goal;goal.setAttribute('aria-label','Execution goal and success conditions');scope.rows=2;scope.maxLength=2000;scope.value=initial.scope;scope.setAttribute('aria-label','Execution workspace');ack.type='checkbox';ack.setAttribute('aria-label','I reviewed the execution inputs');
   const label=(text,input)=>{const l=node('label',text);l.append(input);return l;};
   fields.append(node('p','The planner task stays open until you review completion separately.'),label('Goal and success conditions · narrow this to work Aurora can perform',goal),label('Files, folders or applications to use',scope),node('h3','Optional checks for the result'),rules,label('I reviewed this task, scope and success conditions. Prepare a plan for my approval.',ack));
   editRequirements(rules,values,()=>{dirty=true;ack.checked=false;},true,false);fields.addEventListener('input',e=>{dirty=true;if(e.target!==ack)ack.checked=false;});
   const input=()=>({id:d.id,revision:d.revision,goal:goal.value,scope:scope.value,requirements:serializeRequirements(values)});
   fields.append(button('Save execution draft',async ticket=>{const saved=await api('/api/task-workflow-save',input());if(valid(ticket)){render(saved);message.textContent='Draft saved. No workflow started.';}await load();}),button('Prepare execution plan',async ticket=>{if(!ack.checked)throw Error('Review the execution inputs first.');const child=await api('/api/task-workflow-start',{...input(),acknowledge:true});if(valid(ticket))await openEvidence(child.id);await load();}));
  }
  if(d.attempts.length>1){const history=node('details');history.dataset.attemptHistory='';history.append(node('summary','Attempt history · '+d.attempts.length));for(const a of d.attempts){const row=node('article');row.append(node('p','Attempt '+a.number+(a.current?' · Current':' · Previous')+' · '+a.status.replaceAll('_',' ')),node('p',a.goal),button('Open attempt '+a.number,()=>openEvidence(a.workflowId)));history.append(row);}fields.append(history);}
  const linkOptions=node('details');linkOptions.dataset.linkOptions='';linkOptions.append(node('summary',d.workflow||d.status==='linked'?'Link options':'Draft options'),button(d.workflow||d.status==='linked'?'Unlink from planner':'Discard execution draft',async ticket=>{await api('/api/task-workflow-unlink',{id:d.id,revision:d.revision});if(valid(ticket)){dirty=false;generation++;dialog.close();}await load();}));fields.append(linkOptions);
 }
 const open=({task,id})=>{if(dirty&&!confirm('Discard unsaved execution-draft edits? Your saved draft remains available.'))return;generation++;return run(async ticket=>{dirty=false;title.textContent='Planner task execution';body.replaceChildren();message.textContent='Loading…';dialog.showModal();const d=id?await api('/api/task-workflow?id='+encodeURIComponent(id)):await api('/api/task-workflow-draft',{task});if(valid(ticket))render(d);})();};
 async function openAttention(id){
  if(busy)return;const navigation=++attentionGeneration,view=document.querySelector('#overview-view'),ticket=generation;let left=false;
  const observer=new MutationObserver(records=>{if(records.some(r=>r.oldValue===null))left=true;});observer.observe(view,{attributes:true,attributeFilter:['hidden'],attributeOldValue:true});
  try{const item=await api('/api/task-workflow-attention?id='+encodeURIComponent(id));if(left||view.hidden||ticket!==generation||navigation!==attentionGeneration)return;
   if(!item?.attention){toast('This task no longer needs a decision. The list has been refreshed.');await load();return;}
   if(item.attention.destination==='workflow'){if(dirty&&!confirm('Discard unsaved execution-draft edits? Your saved draft remains available.'))return;dirty=false;generation++;dialog.close();await openWorkflow(item.workflowId,item.attention);}
   else await open({id});
  }finally{observer.disconnect();}
 }
 async function load(){const ticket=++summaryGeneration;try{const list=await api('/api/task-workflows');if(ticket!==summaryGeneration)return;items=list;const current=list.filter(i=>!i.attention&&i.done!==true),history=list.filter(i=>!i.attention&&i.done===true),historyOpen=panel.querySelector('[data-execution-history]')?.open||false;attention.hidden=!list.some(i=>i.attention);panel.hidden=!current.length&&!history.length;attention.replaceChildren();if(!attention.hidden)attention.append(taskAttentionPanel(list));panel.replaceChildren();if(panel.hidden)return;panel.append(node('h2','Task execution'));
  const row=i=>{const item=node('article');item.dataset.plannerExecution=i.id;item.append(node('strong',i.text),node('p',i.detail+(i.changed?' · Planner task changed since preparation':'')));const b=node('button',i.workflowId?'Review linked workflow':'Reopen execution draft');b.type='button';b.onclick=()=>open({id:i.id});item.append(b);return item;};
  for(const i of current.slice(0,40))panel.append(row(i));if(current.length>40)panel.append(node('p','Showing 40 current links. Others can be opened from their planner tasks.'));
  if(history.length){const archived=node('details');archived.dataset.executionHistory='';archived.open=historyOpen;archived.append(node('summary','Completed planner tasks · '+history.length));for(const i of history.slice(0,40))archived.append(row(i));if(history.length>40)archived.append(node('p','Showing 40 completed links. Others can be opened from their planner tasks.'));panel.append(archived);}
 }catch(e){if(ticket===summaryGeneration){panel.hidden=false;attention.hidden=false;panel.replaceChildren(node('p','Task execution status unavailable: '+e.message));attention.replaceChildren(node('p','Attention list unavailable. Refresh Your day to try again.'));}}}
 const timer=setInterval(()=>{if(!document.hidden&&!document.querySelector('#overview-view').hidden)load();},15000);timer.unref?.();
 return {load,openAttention,openLink:id=>open({id}),openTask:t=>{const link=items.find(i=>i.taskId===t.id);return open(link?{id:link.id}:{task:t});}};
}
