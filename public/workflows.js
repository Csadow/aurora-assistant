import {followupsUI} from './workflow-followups.js';
import {completionReviewPanel} from './workflow-completion.js';
import {workflowReviewUI} from './workflow-review.js';
import {workflowProjectsUI} from './project-workspaces.js';
import {readAloudButton} from './speech.js';
import {renderMarkdown} from './markdown.js';
import {handoffsUI} from './workflow-handoffs.js';
import {requirementsUI} from './workflow-requirements.js';
import {taskSkillsUI} from './task-skills.js';
export function workflowsWorkspace({api,escape,toast,state,reviewAction,refreshSkills}){
  const $=s=>document.querySelector(s);let selected=localStorage.getItem('aurora-workflow'),loading=false,loadPromise=null,reloadPending=false,version='',current;const drafts=new Map(),memories=new Map(),models=new Map();
  const safe=fn=>async event=>{try{await fn(event);}catch(e){toast(e.message);}};
  const status=s=>String(s).replaceAll('_',' ');
  const fileReview=workflowReviewUI({api,escape,toast});
  let requirements,handoffs,project;
  const updateStart=()=>{$('#workflow-start').textContent=requirements?.has()||handoffs?.has()||project?.has()||taskSkills.isTask()?'Prepare plan':'Start workflow';};
  const taskSkills=taskSkillsUI({api,escape,toast,refreshSkills,planRequired:()=>requirements?.has()||handoffs?.has()||project?.has(),newInputs:()=>{requirements?.clear();handoffs?.clear();project?.clear();},reload:async()=>{version='';await load();}});
  requirements=requirementsUI({api,escape,toast,reload:async()=>{version='';await load();},changed:updateStart});
  const followups=followupsUI({api,escape,toast,requirements,openWorkflow:async id=>{selected=id;version='';await load();}});
  handoffs=handoffsUI({api,escape,toast,changed:updateStart,reload:async()=>{version='';await load();},newInputs:()=>{project?.clear();requirements.clear();$('#workflow-skill').value='';taskSkills.loadSelection();}});
  project=workflowProjectsUI({api,escape,toast,changed:updateStart});
  project.refresh().catch(e=>toast(e.message));
  handoffs.refresh().catch(e=>toast(e.message));
  function health(w){
    const host=$('#workflow-health'),h=w.health;if(!host||!h)return;
    const displayedRevision=Number($('#workflow-detail').dataset.planRevision);
    const minutes=seconds=>seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${seconds%60}s`;
    const time=h.wait?Math.floor(h.wait.seconds/5)*5:null;
    const signature=JSON.stringify({...h,displayedRevision,wait:h.wait?{...h.wait,seconds:time}:null,budget:{...h.budget,activeSeconds:Math.floor(h.budget.activeSeconds/5)*5}});
    if(host.dataset.signature===signature)return;host.dataset.signature=signature;host.dataset.attention=h.attention;
    const detailsOpen=host.querySelector('[data-health-more]')?.open||false;
    const controls=h.choices.map(c=>c.id==='approve_plan'&&displayedRevision!==w.revision?'<button data-workflow-recovery=review_plan>Show revised plan</button>':`<button ${c.id==='approve_plan'?`data-workflow-id="${escape(w.id)}" data-workflow-revision="${w.revision}"`:''} ${c.id==='review'?`data-workflow-action="${escape(c.action)}"`:['pause','resume','approve_plan'].includes(c.id)?`data-workflow-control="${c.id}"`:`data-workflow-recovery="${c.id}"`} title="${escape(c.detail)}">${escape(c.label)}</button>`).join('');
    const outstanding=h.outstanding.length?[...new Set(h.outstanding.map(x=>({file:'edited file readback',browser:'browser result',window:'application window',screen:'screen result',command:'command result'})[x.group]||x.group))].join(', '):'';
    host.innerHTML=`<div class="panel-heading"><h3>${escape(h.headline)}</h3>${time!==null?`<span class="panel-help">${minutes(time)} on this operation</span>`:''}</div><p>${escape(h.detail)}</p>${h.currentStep?`<p class="panel-help"><strong>Now:</strong> ${escape(h.currentStep.title)}</p>`:''}${outstanding?`<p class="panel-help">Still to verify: ${escape(outstanding)}.</p>`:''}<div class="action-buttons">${controls}</div><details data-health-more ${detailsOpen?'open':''}><summary>Activity details</summary><p><strong>Last observed result:</strong> ${escape(h.lastObserved?.summary||'No tool result recorded yet.')}</p>${h.remaining.length?`<p>${h.remaining.length} remaining step${h.remaining.length===1?'':'s'}</p><ol>${h.remaining.map(s=>`<li>${escape(s)}</li>`).join('')}</ol>`:h.needsPlan&&!['completed','cancelled'].includes(w.status)?'<p class="panel-help">The remaining plan has not been created yet.</p>':''}${w.error&&w.error!==h.detail?`<p class="permission-notice">${escape(w.error)}</p>`:''}<p class="panel-help">${h.budget.calls}/${h.budget.limits.calls} model calls · ${minutes(h.budget.activeSeconds)} active work · ${Math.round(h.budget.limits.activeMs/60000)}m total work limit</p></details>`;
  }
  function render(w){
    current=w;followups.selection(w.id);
    if(version===w.id+w.updated){health(w);return;}
    // Keep an observation draft and expanded evidence intact while polling.
    if(version.startsWith(w.id)&&document.activeElement?.matches('#workflow-detail textarea, #workflow-detail input, #workflow-detail select')){health(w);return;}
    const healthMoreOpen=version.startsWith(w.id)&&!!$('#workflow-health [data-health-more]')?.open;
    version=w.id+w.updated;
    const open=new Set([...document.querySelectorAll('#workflow-detail details[data-evidence][open]')].map(d=>d.dataset.evidence));
    const previousCompletion=$('#workflow-completion-review');
    const completionOpen=previousCompletion?.dataset.completionReview===w.completionReview?.mode?previousCompletion.open:undefined;
    const previousJournal=$('#workflow-journal-details');
    const journalOpen=previousJournal?.dataset.workflowId===w.id&&previousJournal.dataset.workflowStatus===w.status?previousJournal.open:!['completed','cancelled'].includes(w.status);
    const previousSteps=$('#workflow-steps-details');
    const stepsOpen=previousSteps?.dataset.workflowId===w.id&&previousSteps.dataset.workflowStatus===w.status?previousSteps.open:w.status==='plan_review';
    const previousScope=$('#workflow-scope-details');
    const sameScope=previousScope?.dataset.workflowId===w.id;
    const scopeOpen=sameScope&&$('#workflow-detail').dataset.workflowStatus===w.status?previousScope.open:w.status==='plan_review'||sameScope&&previousScope.open;
    const aftercareOpen=$('#workflow-aftercare')?.dataset.workflowId===w.id&&$('#workflow-aftercare').open;
    const active=['planning','running','queued','waiting_approval'].includes(w.status),finished=['completed','cancelled'].includes(w.status);
    $('#workflow-detail').innerHTML=`<div class="panel-heading"><h3>${escape(w.goal)}</h3><span class="action-status" role="status">${escape(status(w.status))}</span></div><p class="panel-help">${w.engine==='chatgpt'?'ChatGPT · ':'Local · '}${escape(w.model)} · ${w.current} / ${w.steps.length} steps · ${w.calls} model calls</p>${w.scope?`<details id="workflow-scope-details" class="workflow-scope" data-workflow-id="${escape(w.id)}" ${scopeOpen?'open':''}><summary>Task scope</summary><p class="panel-help">${escape(w.scope)}</p></details>`:''}<div class="action-buttons">${w.health?'':active?'<button data-workflow-control="pause" class="danger">Stop</button>':!finished&&!w.question&&!['needs_verification','waiting_input'].includes(w.status)?`<button data-workflow-control="resume" class="primary">${w.status==='needs_help'?(w.engine==='chatgpt'?'Continue with ChatGPT':'Continue locally'):'Resume'}</button>`:''}${!finished?'<button data-workflow-control="cancel">Cancel workflow</button>':''}</div>${w.error&&!w.health?`<p class="permission-notice">${escape(w.error)}</p>`:''}${w.status==='needs_verification'?'<form id="workflow-resolve"><label>What did you check, and what actually happened?<textarea id="workflow-observation" rows="3" minlength="8" maxlength="2000" required></textarea></label><button>Save observation</button></form>':''}<details id="workflow-steps-details" data-workflow-id="${escape(w.id)}" data-workflow-status="${escape(w.status)}" ${stepsOpen?'open':''}><summary>Plan & steps · ${w.steps.filter(s=>s.status==='completed').length}/${w.steps.length} complete</summary><ol class="workflow-steps">${w.steps.map(s=>`<li class="workflow-step ${escape(s.status)}"><strong>${escape(s.title)}</strong><span>${escape(status(s.status))}</span><p class="panel-help">Check: ${escape(s.check)}</p>${s.summary?`<div class="markdown-body">${renderMarkdown(s.summary)}</div>`:''}</li>`).join('')}</ol></details><details id="workflow-journal-details" data-workflow-id="${escape(w.id)}" data-workflow-status="${escape(w.status)}" ${journalOpen?'open':''}><summary>Evidence & actions · ${w.operations.length} record${w.operations.length===1?'':'s'}</summary>${w.operations.map((o,index)=>`<details data-evidence="${o.id}" ${open.has(o.id)?'open':''}><summary>${escape(o.name.replaceAll('_',' '))}${o.routine?' · Routine continuation':''} · ${escape(status(o.status))}</summary><small>Evidence E${index+1} · ${o.id}</small><pre>${escape(JSON.stringify({input:o.arguments,routineReason:o.routine?.reason,questionSource:o.questionSource,contentSource:o.contentSource,citationRepairs:o.citationRepairs,sourceExcerpts:o.sourceExcerpts,sourceCalculations:o.sourceCalculations,sourceReview:o.sourceReview,requestedTool:o.requestedTool,requestedInput:o.requestedArguments,result:o.result},null,2))}</pre></details>${o.action?`<button data-workflow-action="${o.action}">${o.status==='waiting_approval'?'Review action':'Action details'}</button>`:''}`).join('')||'<p class="panel-help">Aurora is preparing the plan.</p>'}</details>${w.result?`<h3>Result</h3><div class="markdown-body">${renderMarkdown(w.result)}</div><p class="panel-help">Step conclusions are Aurora’s assessment of the saved evidence. Open the evidence above to inspect exact tool results.</p>`:''}`;
    $('#workflow-steps-details').before(fileReview.render(w));
    $('#workflow-detail').dataset.planRevision=String(w.revision||1);
    $('#workflow-detail').dataset.workflowStatus=w.status;
    if(w.status==='completed'&&w.result){const read=readAloudButton(w.result,toast);if(read)$('#workflow-detail').append(read);}
    if($('#workflow-resolve'))$('#workflow-resolve').onsubmit=safe(async e=>{e.preventDefault();await api('/api/workflow-control',{id:selected,operation:'resolve',observation:$('#workflow-observation').value});version='';await load();});
    const extra=document.createElement('section');extra.className='workflow-updates';
    extra.innerHTML=`${w.question?`<p class="permission-notice"><strong>Aurora needs your input:</strong> ${escape(w.question)}</p>`:''}${!finished?`<form id="workflow-update-form"><label>Update this task<textarea id="workflow-update" rows="2" maxlength="2000" required placeholder="Use a different folder, skip a step, or answer Aurora’s question…"></textarea></label><button class="primary">Update remaining plan</button><p class="panel-help">Completed work stays recorded. Pending approvals from the old plan are retired. Running actions stop and may need verification.</p></form>`:''}${w.directives?.length?`<details><summary>Plan changes · revision ${w.revision}</summary>${w.directives.map(d=>`<p>${escape(d.instruction)}</p>`).join('')}</details>`:''}${w.status==='completed'?`<details id="workflow-aftercare" data-workflow-id="${escape(w.id)}" ${aftercareOpen?'open':''}><summary>Save what worked</summary><button id="workflow-memory-draft">Draft project memory</button></details>`:''}`;
    $('#workflow-detail .action-buttons').after(extra);
    if(!finished&&!active){
      const panel=document.createElement('section');panel.className='workflow-help';
      const canHelp=['paused','needs_help'].includes(w.status)&&!w.question&&!w.operations.some(o=>['started','waiting_approval'].includes(o.status));
      const target=models.get(w.id);
      panel.innerHTML=`${canHelp?`<details ${w.status==='needs_help'?'open':''}><summary>Stronger help</summary><p class="panel-help">Edit a focused question and only the context you want to share. The next screen shows the destination and exact outgoing text. Cloud help must first be configured in Settings → Access & cloud.</p><form id="workflow-help-form"><label>Question<textarea id="workflow-help-question" rows="3" maxlength="12000" required>${escape(w.help?.question||'How can I make progress on this task? '+w.goal)}</textarea></label><label>Context to send<textarea id="workflow-help-context" rows="5" maxlength="12000">${escape(w.help?.context||'')}</textarea></label><button class="primary">Preview cloud consultation</button></form><p class="panel-help">Use ${w.status==='needs_help'?(w.engine==='chatgpt'?'Continue with ChatGPT':'Continue locally'):'Resume'} above to continue with the selected model. Advice cannot approve actions or replace outcome checks. Up to three consultations per task.</p></details>`:''}<button id="workflow-model-review">${w.engine==='chatgpt'?'Review ChatGPT connection':'Review local model change'}</button><p class="panel-help">${w.engine==='chatgpt'?'Select this task’s original ChatGPT account and model in Settings before resuming.':'Choose another installed model in Settings first. Moving this task retires old approvals and revises only its remaining plan.'}</p>${target?`<p>Move from <strong>${escape(w.model)}</strong> to <strong>${escape(target.model)}</strong> · reasoning ${target.thinking?'on':'off'}?</p><button id="workflow-model-apply">Use ${escape(target.model)} for this task</button>`:''}`;
      extra.after(panel);
      if($('#workflow-help-form'))$('#workflow-help-form').onsubmit=safe(async e=>{e.preventDefault();const result=await api('/api/workflow-help',{id:w.id,revision:w.revision||1,question:$('#workflow-help-question').value,context:$('#workflow-help-context').value});version='';await load();await reviewAction(result.action.id);});
      $('#workflow-model-review').onclick=safe(async()=>{if(w.engine==='chatgpt'){$('#settings').click();return;}models.set(w.id,await api('/api/local-model'));version='';await load();});
      if($('#workflow-model-apply'))$('#workflow-model-apply').onclick=safe(async()=>{await api('/api/workflow-model',{id:w.id,revision:w.revision||1,model:target.model,generation:target.generation});models.delete(w.id);version='';toast('Model transition recorded. Aurora will revise the remaining plan.');await load();});
    }
    if(w.modelTransitions?.length){const log=document.createElement('details');log.innerHTML=`<summary>Local model history</summary>${w.modelTransitions.map(m=>`<p>${escape(m.from.model)} → ${escape(m.to.model)} · revision ${m.revision}</p>`).join('')}`;extra.after(log);}
    if(w.toolContinuations?.length){const recovery=document.createElement('details');recovery.innerHTML=`<summary>Tool recovery · ${w.toolContinuations.length}/2 additional attempts used</summary><p class="panel-help">These unsaved drafts are model text, not actions or evidence. Recovery never grants approval.</p>${w.toolContinuations.map(r=>`<p>${escape(r.reason)}</p><pre>${escape(r.draft)}</pre>`).join('')}`;extra.after(recovery);}
    if(w.chatgptUsage?.length){const usage=document.createElement('p');usage.className='panel-help';usage.textContent=`Recorded ChatGPT output: ${w.chatgptUsage.reduce((n,u)=>n+(u.tokens||0),0)} tokens · active task time: ${Math.round(w.activeMs/1000)} seconds`;$('#workflow-detail').append(usage);}
    if(w.localUsage?.length){const usage=document.createElement('p');usage.className='panel-help';usage.textContent=`Recorded local output: ${w.localUsage.reduce((n,u)=>n+(u.tokens||0),0)} tokens · active task time: ${Math.round(w.activeMs/1000)} seconds · cloud consultations: ${w.operations.filter(o=>o.name==='consult_cloud').length}`;$('#workflow-detail').append(usage);}
    const memory=memories.get(w.id);
    if(memory){const form=document.createElement('form');form.id='workflow-memory-form';form.innerHTML=`<h3>Review project memory</h3><label>Title<input id="workflow-memory-title" maxlength="100" required value="${escape(memory.title)}"></label><label>Related note (optional vault path)<input id="workflow-memory-project" placeholder="20 Projects/My project.md" value="${escape(memory.project||'')}"></label><label>Memory draft<textarea id="workflow-memory-body" rows="12" maxlength="16000" required>${escape(memory.body)}</textarea></label><button>Send to review inbox</button><p class="panel-help">This creates a draft. It becomes memory only after you accept it in the review inbox.</p>`;$('#workflow-aftercare').append(form);form.onsubmit=safe(async e=>{e.preventDefault();const proposal=await api('/api/workflow-memory',{id:w.id,title:$('#workflow-memory-title').value,body:$('#workflow-memory-body').value,project:$('#workflow-memory-project').value});toast(proposal.status==='accepted'?'This task already has an accepted memory note.':'Project memory is ready in the review inbox.');memories.delete(w.id);version='';await load();});}
    if(w.project){const panel=document.createElement('section');panel.className='workflow-project';panel.innerHTML=`<h3>Project · ${escape(w.project.name)}</h3>${w.routineContinuation?'<p data-routine-policy class="permission-notice">Routine continuation enabled. Required reads, review preparation and declared result checks can proceed between model decisions. Every edit and command still needs exact approval. The model assesses the full goal before completion. Fixed for this task.</p>':''}${w.copyBeforeEdit?`<p data-copy-policy class="permission-notice">Test before editing required · ${escape(w.copyBeforeEdit.name)}. Each exact candidate needs completed copy tests and separate edit review. This choice is fixed for this task.</p>`:''}<p class="panel-help">Saved settings revision ${w.project.revision} · fixed for this task. Requirement edits below apply only to this task.</p><button data-note="${escape(w.project.notePath)}">Open project note</button><pre>${escape(JSON.stringify({folders:w.project.folders,selectedChecks:w.project.checks},null,2))}</pre>`;$('#workflow-detail .workflow-steps').before(panel);}
    requirements.render(w);taskSkills.render(w);handoffs.render(w);
    for(const [id,value] of Object.entries(drafts.get(w.id)||{})){const field=document.getElementById(id);if(field)field.value=value;}
    const healthPanel=document.createElement('section');healthPanel.id='workflow-health';healthPanel.setAttribute('aria-label','Task progress and recovery');$('#workflow-detail .panel-heading').after(healthPanel);health(w);if(healthMoreOpen)healthPanel.querySelector('[data-health-more]')?.setAttribute('open','');const results=completionReviewPanel(w,escape);if(completionOpen!==undefined&&results instanceof HTMLDetailsElement)results.open=completionOpen;healthPanel.after(results);followups.render(w,results);
    if($('#workflow-update-form'))$('#workflow-update-form').onsubmit=safe(async e=>{e.preventDefault();await api('/api/workflow-steer',{id:w.id,instruction:$('#workflow-update').value,revision:w.revision||1});drafts.delete(w.id);version='';toast('Update saved. Aurora will revise the remaining plan.');await load();});
    if($('#workflow-memory-draft'))$('#workflow-memory-draft').onclick=safe(async()=>{memories.set(w.id,await api('/api/workflow-memory',{id:w.id}));version='';await load();});
  }
  $('#workflow-detail').addEventListener('input',e=>{if(current&&e.target.id&&e.target.matches('textarea,input'))drafts.set(current.id,{...drafts.get(current.id),[e.target.id]:e.target.value});});
  async function load(waitForCurrent=false){
    if(loading){reloadPending=true;return waitForCurrent?loadPromise:undefined;}loading=true;
    loadPromise=(async()=>{do{
      reloadPending=false;const requestedSelection=selected,list=await api('/api/workflows');
      if(selected!==requestedSelection){reloadPending=true;continue;}
      $('#workflow-list').innerHTML=list.map(w=>`<article class="action-card"><span class="panel-help">${escape(status(w.status))} · ${w.engine==='chatgpt'?'ChatGPT':'Local'} · ${w.current}/${w.steps}</span><h3>${escape(w.goal)}</h3><button data-workflow-open="${w.id}">View workflow</button></article>`).join('');
      // An explicit selection can be older than the recent-list limit.
      if(!selected)selected=list[0]?.id||null;
      if(selected){const id=selected;let w;try{w=await api('/api/workflow?id='+id);}catch(e){if(selected!==id){reloadPending=true;continue;}current=null;version='';$('#workflow-detail').textContent='This workflow is unavailable. Choose another task or review its planner link.';throw e;}
        if(selected!==id){reloadPending=true;continue;}localStorage.setItem('aurora-workflow',id);render(w);
      }
    }while(reloadPending);})();
    try{return await loadPromise;}finally{loading=false;}
  }
  async function openWorkflow(id,focus){
    selected=id;version='';await load(true);if(selected!==id||current?.id!==id||state.view!=='workflows')return;
    let element;
    if(focus?.kind==='approval'){
      if(current.operations.some(o=>o.action===focus.actionId&&o.status==='waiting_approval')){await reviewAction(focus.actionId);return;}
      toast('The action state changed. Review the current workflow status.');
    }
    if(focus?.kind==='question'&&current.question)element=$('#workflow-update');
    else if(focus?.kind==='verification'&&current.status==='needs_verification')element=$('#workflow-observation');
    else if(focus?.kind==='plan')element=$('#workflow-detail .workflow-steps');
    else if(focus)element=$('#workflow-health');
    if(focus&&!element)element=$('#workflow-health');
    if(element){if(!element.matches('textarea,input,button,select'))element.tabIndex=-1;element.focus({preventScroll:true});element.scrollIntoView({block:'center'});}
  }
  $('#workflow-form').onsubmit=safe(async e=>{e.preventDefault();$('#workflow-start').disabled=true;try{const w=await api('/api/workflow-start',{goal:$('#workflow-goal').value,scope:$('#workflow-scope').value,engine:$('#workflow-engine').value,skills:$('#workflow-skill').value?[$('#workflow-skill').value]:[],...taskSkills.parameters(),...handoffs.parameters(),...project.parameters(),requirements:requirements.parameters()});$('#workflow-goal').value='';$('#workflow-scope').value='';taskSkills.clearInputs();requirements.clear();handoffs.clear();project.clear();selected=w.id;version='';await load();}finally{$('#workflow-start').disabled=false;}});
  $('#workflow-list').onclick=safe(async e=>{const id=e.target.closest('button')?.dataset.workflowOpen;if(id){selected=id;version='';await load();}});
  $('#workflow-detail').onclick=safe(async e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.workflowAction)await reviewAction(b.dataset.workflowAction);if(b.dataset.workflowControl){b.disabled=true;try{await api('/api/workflow-control',{id:b.dataset.workflowId||selected,operation:b.dataset.workflowControl,...b.dataset.workflowControl==='approve_plan'?{revision:Number(b.dataset.workflowRevision)}:{}});version='';await load();}finally{b.disabled=false;}}
    const recovery=b.dataset.workflowRecovery;
    if(recovery==='verify'||recovery==='update'){const field=$(recovery==='verify'?'#workflow-observation':'#workflow-update');if(field){field.scrollIntoView({block:'center'});field.focus();}else{version='';await load();toast('Task state changed. Review its current progress.');}}
    if(recovery==='review_plan'){version='';await load();}
    if(recovery==='model')$('#workflow-model-review')?.click();
    if(recovery==='chatgpt'){$('#settings').click();toast('Select this task’s original ChatGPT account and model in Settings.');}
    if(recovery==='help'){const form=$('#workflow-help-form');if(form){form.closest('details').open=true;form.scrollIntoView({block:'center'});$('#workflow-help-question').focus();}}
    if(recovery==='desktop'){$('#settings').click();toast(window.asterDesktop?'Review the desktop connection and computer permissions.':'Open Aurora from the Linux application menu to reconnect desktop controls.');}
    if(recovery==='follow_up'&&current)await followups.open(current.id);
  });
  setInterval(()=>{if(state.view==='workflows'&&!document.hidden)load().catch(()=>{});},1000);
  return {load,prepareFollowup:async id=>{selected=id;version='';await load(true);await followups.open(id);},editRequirements:requirements.editor,serializeRequirements:requirements.serialize,prepareProject:async(id,handoff)=>{requirements.clear();handoffs.clear();project.clear();$('#workflow-skill').value='';await taskSkills.loadSelection();$('#workflow-goal').value='';$('#workflow-scope').value='';if(handoff)await handoffs.select(handoff);await project.choose(id);$('#workflow-goal').focus();},open:openWorkflow};
}
