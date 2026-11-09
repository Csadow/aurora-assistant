import {createReviewReturn,markPlanningReview} from './review-return.js';
import {createReminderCleanup} from './reminder-cleanup.js';
import {createReminderOverview} from './reminder-overview.js';
import {createReminderPlans} from './reminder-plans.js';
import {createWorkloadRevisits} from './workload-revisits.js';
import {createWorkloadRemaining} from './workload-remaining.js';
import {workloadStartHTML} from './workload-start.js';
import {createWorkloadNextView} from './workload-next.js';
import {createWorkloadFollow} from './workload-follow.js';
import {createWeekWorkload} from './week-workload.js';
import {createWeekCapacity} from './week-capacity.js';
import {createRemainingAdjustments} from './remaining-adjustments.js';
import {dayStartHTML} from './day-start.js';
import {dayHandoffHTML} from './day-handoff.js';
import {createReviewPosition} from './reading-position.js';
import {shortlistBriefing,createShortlistFollow} from './shortlist-follow.js';
import {createShortlistImport} from './capture-shortlist.js';
import {capturedTasksHTML,createCapturedTasks} from './captured-tasks.js';
import {createTaskDetails} from './task-details.js';
import {flushPlanningDraft} from './planning-draft-guard.js';
import {createEstimateAdjustment} from './estimate-adjustment.js';
import {createEstimateFollowThrough,estimateFollowSection,estimateFollowContext} from './estimate-follow-through.js';
import {createEstimateReview} from './estimate-review.js';
import {createSessionReviews} from './session-review.js';
import {createFocusSessions} from './focus-sessions.js';
import {createPlanFollowThrough,followThroughBriefing,followThroughContextHTML} from './plan-follow-through.js';
import {outcomeSourceHTML} from './outcome-planning.js';
import {createStepOutcomes} from './step-outcomes.js';
import {createFirstSteps,firstStepsBriefing} from './first-steps.js';
import {reflectionBriefing,createMorningReflection} from './morning-reflection.js';
import {createDailySummary} from './daily-summary.js';
import {createCheckin,checkinBriefingHTML} from './daily-checkin.js';
import {savedPlansHTML} from './saved-day-plans.js';
import {createRemainder} from './remainder-planning.js';
import {createNextDay} from './next-day.js';
import {createDailyFocus,focusBriefing} from './daily-focus.js';
import {createWeeklyReview} from './weekly-review.js';
import {createEveningReview,eveningExecution} from './evening-review.js';
import {taskAttentionPanel} from './task-attention.js';
import {planningWarningsHTML} from './continue-day.js';
export function dayPlanning({api,escape,toast,refresh,openExecution,openAttention,openContinueDay,openTaskSchedule,openTaskList,beforeNavigate=()=>{}}){
 const $=s=>document.querySelector(s);let busy=false,taskDetails=null,captures=null,reviewReturn=null;
 const panel=document.createElement('dialog');panel.id='day-planning-dialog';panel.setAttribute('aria-label','Daily planning and briefing');panel.innerHTML='<div class="day-planning-nav"><button id="day-planning-close">Close</button><button id="day-planning-source-back" hidden>Back to review</button><button id="day-planning-continue">Continue my day ↗</button><button id="day-planning-briefing">Briefing</button><button id="day-planning-evening">Evening review</button><button id="day-planning-task-back" hidden>Back to task details</button><details id="day-planning-tools"><summary>More planning tools</summary><div class="planning-tool-groups"><section><h3>Tasks and reminders</h3><button id="day-planning-list-back">Back to task list</button><button id="day-planning-captures">Captured tasks</button><button id="day-planning-cleanup">Daily cleanup</button></section><section><h3>Plan ahead</h3><button id="day-planning-week-capacity">Week ahead</button><button id="day-planning-workload">Workload comparison</button><button id="day-planning-workload-remaining">Remaining workload</button><button id="day-planning-workload-next">Unfinished work</button></section><section><h3>Saved plans</h3><button id="day-planning-workload-start">Follow-up plans</button><button id="day-planning-workload-follow">Saved workload plans</button><button id="day-planning-adjustments">Saved adjustments</button></section></div></details></div><div id="day-planning-body"></div><p id="day-planning-error" role="status"></p>';document.body.append(panel);
 const body=$('#day-planning-body'),error=$('#day-planning-error');
 body.addEventListener('click',event=>{if(event.target.closest('[data-briefing-note],[data-open-workflow],[data-planner-attention]')){if(busy){event.preventDefault();event.stopPropagation();return;}try{flushPlanningDraft(body);}catch(e){event.preventDefault();event.stopPropagation();error.textContent=e.message;return;}panel.close();}});
 const reading=createReviewPosition({api,body,panel});
 const run=fn=>async()=>{if(busy)return false;reading.capture();busy=true;body.inert=true;error.textContent='';panel.setAttribute('aria-busy','true');try{await reading.ready();await fn();$('#day-planning-tools').open=false;return true;}catch(e){error.textContent=e.message;open();return false;}finally{busy=false;body.inert=false;panel.removeAttribute('aria-busy');taskDetails?.restoreFocus();captures?.settleFocus();reading.restore();reviewReturn?.sync();reviewReturn?.settle();}};
 const leave=()=>{reading.capture();beforeNavigate();flushPlanningDraft(body);taskDetails?.capture();captures?.leave();reviewReturn?.capture();};
 $('#day-planning-close').onclick=()=>{if(!busy)try{leave();panel.close();}catch(e){error.textContent=e.message;}};panel.addEventListener('cancel',e=>{if(busy)e.preventDefault();else try{leave();}catch(x){e.preventDefault();error.textContent=x.message;}});
 const open=()=>{if(!panel.open)panel.showModal();taskDetails?.updateReturn();};
 const items=list=>list.length?'<ul>'+list.map(t=>'<li>'+escape(t.text)+(t.due?' · Due '+escape(t.due):'')+(t.id?'<button data-open-task-detail="'+escape(t.id)+'">Task details</button>':'')+'</li>').join('')+'</ul>':'<p>None.</p>';
 async function briefing(){const b=await api('/api/briefing'),boot=await api('/api/bootstrap');body.innerHTML=`<h2>Daily briefing · ${escape(b.date)}</h2><button data-continue-day class="primary">Continue my day</button><p>${escape(b.greeting)}</p><p>${escape(b.timezone)} · Updated ${escape(new Date(b.generatedAt).toLocaleTimeString())}</p>${b.day.unknown?'<p class="planner-warning">Class times are incomplete for today.</p>':''}${b.next?'<p><strong>Next / in progress:</strong> '+escape(b.next.time+' · '+b.next.title)+'</p>':''}${b.day.availability?'<p>Available: '+escape(b.day.availability.map(w=>w.join('–')).join(', ')||'Day off')+'</p>':''}<p>Recurring series: ${b.recurring.active} active · ${b.recurring.paused} paused. Occurrences appear below as ordinary tasks.</p><h3>Today’s schedule</h3>${b.day.blocks.length?'<ul>'+b.day.blocks.map(t=>'<li>'+escape(t.time+' · '+t.title+' · '+t.kind)+'</li>').join('')+'</ul>':'<p>No timed blocks saved.</p>'}${b.day.conflicts.length?'<p class="planner-warning">'+b.day.conflicts.length+' overlapping blocks need attention.</p>':''}<h3>Waiting on prerequisites</h3>${b.day.blocked.length?'<ul>'+b.day.blocked.map(t=>'<li>'+escape(t.text)+' · '+escape(t.reasons.join('; '))+'</li>').join('')+'</ul>':'<p>None.</p>'}<h3>Linked projects for today</h3>${b.projectContext.projects.map(p=>'<article class="briefing-project"><h4>'+escape(p.title)+'</h4><small>'+escape(p.path)+'</small>'+(!p.missing?'<button data-briefing-note data-note="'+escape(p.path)+'">Open project note</button>':'')+'<p>'+escape(p.excerpt)+'</p><p>'+p.taskCount+' relevant task(s).</p><strong>Ready next actions</strong>'+items(p.ready)+(p.blocked.length?'<p>Waiting: '+p.blocked.map(t=>escape(t.text)).join(', ')+'</p>':'')+'</article>').join('')||'<p>No projects linked to today’s tasks or overdue deadlines. Use Project tasks to add a link.</p>'}${b.projectContext.total>b.projectContext.projects.length?'<p>Showing four of '+b.projectContext.total+' relevant projects.</p>':''}<h3>Task execution</h3>${(b.execution||[]).filter(t=>!t.done).slice(0,40).map(t=>'<article><strong>'+escape(t.text)+'</strong><p>'+escape(t.detail)+(t.changed?' · Planner task changed since preparation':'')+'</p>'+(t.workflowId?'<button data-open-workflow="'+escape(t.workflowId)+'">Open workflow results</button>':'<p>Reopen this saved draft in Your day.</p>')+'</article>').join('')||'<p>No linked open tasks.</p>'}<h3>Due today</h3>${items(b.day.due)}<h3>Overdue deadlines</h3>${items(b.overdue)}<h3>Today, without a time</h3>${items(b.day.untimed)}<h3>Missed planned tasks</h3>${items(b.missed)}<p>No tasks have been changed. Choose a manageable first step; leave some breathing room.</p>`;const first=body.querySelector('h3');first.insertAdjacentHTML('beforebegin',dayHandoffHTML(b.handoff,b.handoffError,escape,{id:'briefing-handoff',compact:true})+await shortlistBriefing({api,vault:boot.vault,escape})+capturedTasksHTML(b.capturedTasks,b.capturedTasksError,escape,{brief:true,vault:boot.vault})+estimateFollowSection(b.estimateFollowThrough,b.estimateFollowThroughError,escape)+followThroughBriefing(b.followThrough,b.followThroughError,escape)+firstStepsBriefing(b.firstSteps,b.firstStepsError,boot.vault,escape)+reflectionBriefing(b.reflection,b.reflectionError,boot.vault,escape)+checkinBriefingHTML(b.checkins,escape)+(b.checkinsError?'<p class="planner-warning">Check-ins unavailable: '+escape(b.checkinsError)+'</p>':'')+savedPlansHTML(b.savedPlans,escape)+(b.savedPlansError?'<p class="planner-warning">Saved day plans unavailable: '+escape(b.savedPlansError)+'</p>':'')+focusBriefing(b.focus,escape)+(b.focusError?'<p class="planner-warning">Focus unavailable: '+escape(b.focusError)+'</p>':''));
  const detail=document.createElement('details');detail.id='briefing-details';detail.dataset.readingDetails='briefing-details';detail.innerHTML='<summary>Complete schedule, planning details and history</summary>';for(const child of [...body.children].slice(2))detail.append(child);
  const greeting=document.createElement('p');greeting.textContent=b.greeting+' '+b.timezone+' · Updated '+new Date(b.generatedAt).toLocaleTimeString();body.append(greeting);
  body.insertAdjacentHTML('beforeend',planningWarningsHTML(b.warnings,escape,{id:'briefing-calendar-coverage'})+dayStartHTML(b.start,b.startError,escape,{id:'briefing-overview'}));body.append(taskAttentionPanel(b.execution||[]),detail);markPlanningReview(body,body.querySelector('#briefing-overview'),{type:'briefing'},'briefing');open();return b;}
 $('#day-planning-list-back').onclick=run(async()=>{leave();panel.close();await openTaskList();});
 $('#day-planning-continue').onclick=run(async()=>{leave();panel.close();await openContinueDay();});
 body.addEventListener('click',e=>{if(e.target.closest('[data-continue-day]'))$('#day-planning-continue').click();});
 const cleanup=createReminderCleanup({api,escape,body,open,run});
 const reminderOverview=createReminderOverview({api,escape,body,open});
 const reminderPlans=createReminderPlans({api,escape,body,open,run,showReview});
 const revisits=createWorkloadRevisits({api,escape,body,open,run,leave});
 const adjustments=createRemainingAdjustments({api,escape,body,open,run});
 const remainder=createRemainder({api,escape,body,open,run,showReview});
 const followThrough=createPlanFollowThrough({api,escape,body,open,run,openAdjust:ref=>remainder.show(undefined,ref)});
 body.addEventListener('click',e=>{const b=e.target.closest('[data-follow-adjustment]');if(b)run(()=>remainder.show(undefined,{proposalId:b.dataset.followAdjustment,taskId:b.dataset.followTask}))();});
 const choose=()=>remainder.show();
 const checkin=createCheckin({api,escape,body,open,run,adjust:entry=>remainder.show(entry),showReview});
 $('#day-checkin').onclick=run(()=>checkin.show());
 body.addEventListener('click',e=>{if(e.target.closest('[data-adjust-today]'))run(choose)();if(e.target.closest('[data-briefing-today]'))run(briefing)();const previous=e.target.closest('[data-saved-plan-date]');if(previous)run(async()=>{body.innerHTML='<h2>Earlier day plan</h2>'+savedPlansHTML(await api('/api/saved-day-plans?date='+encodeURIComponent(previous.dataset.savedPlanDate)),escape);open();})();});
 const focus=createDailyFocus({api,escape,body,panel,open,run:fn=>run(async()=>{leave();return fn();}),toast,showReview,openExecution:async id=>{panel.close();await openExecution(id);}});
 const weekly=createWeeklyReview({api,escape,body,panel,open,run,showReview});
 async function history(){const r=await api('/api/task-history');const labels={appeared:'Task appeared',disappeared:'Task disappeared from active notes',marked_complete:'Marked complete',reopened:'Reopened',rescheduled:'Schedule changed',renamed:'Wording changed',estimate_changed:'Estimate changed',priority_changed:'Priority changed',deadline_changed:'Deadline changed',reminder_changed:'Reminder changed',note_changed:'Note changed',project_changed:'Project link changed',parent_changed:'Parent task changed',dependencies_changed:'Prerequisites changed'};
 const detail=t=>t?escape(t.text)+' · '+(t.done?'Marked complete':'Open')+' · '+escape(t.planDate||'Unscheduled')+(t.startTime?' '+escape(t.startTime):'')+' · '+t.duration+' min · '+escape(t.priority)+' priority'+(t.due?' · Due '+escape(t.due):'')+(t.remindAt?' · Reminder '+escape(t.remindAt):'')+(t.project?' · Project '+escape(t.project):'')+(t.parent?' · Parent '+escape(t.parent):'')+(t.dependsOn?.length?' · Prerequisites '+escape(t.dependsOn.join(', ')):''):'Not present';
 body.innerHTML=`<h2>Task history</h2><p>Recording since ${escape(new Date(r.startedAt).toLocaleString())}. Showing the latest ${r.events.length} of ${r.total} changes.</p>${r.limitations.map(t=>'<p class="panel-help">'+escape(t)+'</p>').join('')}${r.untracked?'<p class="planner-warning">'+r.untracked+' tasks have missing, invalid or duplicate IDs and cannot be reliably tracked.</p>':''}${r.events.map(e=>'<article class="proposal"><h3>'+escape(e.kinds.map(k=>labels[k]||k).join(' · '))+'</h3><p>'+escape(new Date(e.recordedAt).toLocaleString())+' · '+escape(e.source==='aurora_save'?'Saved through Aurora':e.source==='recovered_save'?'Recovered save · exact change time unknown':'Observed Markdown change · exact change time unknown')+(e.decision?' · '+escape(e.decision.kind):'')+'</p><p><strong>Before:</strong> '+detail(e.before)+'</p><p><strong>After:</strong> '+detail(e.after)+'</p></article>').join('')||'<p>No changes recorded yet. Existing tasks are the starting baseline.</p>'}`;open();}
 const nextDay=createNextDay({api,escape,body,panel,open,run,showReview});
 const workloadRemaining=createWorkloadRemaining({api,escape,body,open,run});
 const workloadNext=createWorkloadNextView({api,escape,body,open,run,showReview});
 const workloadFollow=createWorkloadFollow({api,escape,body,open,run});
 const weekWorkload=createWeekWorkload({api,escape,body,open,run,showReview});
 const weekCapacity=createWeekCapacity({api,escape,body,open,run,showReview,openWorkload:async source=>{leave();return weekWorkload.start(source);}});
 const shortlistImport=createShortlistImport({api,body,open,run,escape,openDay:()=>nextDay.show()});
 const shortlistFollow=createShortlistFollow({api,body,open,run,escape,onMerge:()=>shortlistImport.show({carry:true})});
 const outcomePlan=createNextDay({api,escape,body,panel,open,run,showReview,outcomes:true});
 body.addEventListener('click',e=>{if(e.target.closest('[data-outcome-plan]'))run(()=>outcomePlan.show())();});
 body.addEventListener('click',e=>{if(e.target.closest('[data-next-day]'))run(()=>nextDay.show())();});
 const summary=createDailySummary({api,escape,body,open,run});
 const reflection=createMorningReflection({api,escape,body,open,run});
 const estimateAdjustment=createEstimateAdjustment({api,escape,body,open,run,showReview});
 const estimateFollow=createEstimateFollowThrough({api,escape,body,open,run,openAdjust:ref=>estimateAdjustment.show(ref)});
 body.addEventListener('click',e=>{const b=e.target.closest('[data-estimate-return]');if(b)run(()=>estimateAdjustment.show({reviewId:b.dataset.estimateReturn,taskId:b.dataset.estimateTaskId}))();});
 const estimates=createEstimateReview({api,escape,body,open,run});
 const sessionReviews=createSessionReviews({api,escape,body,open,run});
 const sessions=createFocusSessions({api,escape,body,open,run});
 const outcomes=createStepOutcomes({api,escape,body,open,run});
 const firstSteps=createFirstSteps({api,escape,body,open,run,openExecution:async id=>{panel.close();await openExecution(id);}});
 const evening=createEveningReview({api,escape,body,panel,open,run,showReview});
 body.addEventListener('click',e=>{const button=e.target.closest('[data-focus-review-date]');if(button)run(()=>evening(button.dataset.focusReviewDate))();});
 async function showReview(p){
 const futureReview=p.kind==='future_schedule',focusReview=p.kind==='focus_schedule',timeReview=focusReview||futureReview,weeklyReview=p.kind==='weekly_review',eveningReview=timeReview||weeklyReview||p.kind==='evening_review';
 if(p.status!=='pending'){body.innerHTML='<h2>'+escape(p.title)+'</h2><p>This preview is '+escape(p.status)+'. Already saved task notes are kept.</p><button '+(p.reminderDecision?'data-reminder-plan-route="'+escape(JSON.stringify({type:'reminder-plan',decisionId:p.reminderDecision.id}))+'"':p.estimateFollowThrough?'data-estimate-return="'+escape(p.estimateFollowThrough.reviewId)+'" data-estimate-task-id="'+escape(p.estimateFollowThrough.taskId)+'"':p.followThrough?'data-follow-adjustment="'+escape(p.followThrough.proposalId)+'" data-follow-task="'+escape(p.followThrough.taskId)+'"':p.checkin?'data-checkin-open="'+escape(p.checkin.id)+'"':p.kind==='day_replan'?'data-adjust-today':p.outcomeSources?'data-outcome-plan':p.origin==='workload-next'?'data-workload-next':p.origin==='week-capacity'?'data-week-capacity':p.origin==='week-workload'?'data-week-workload':'data-next-day')+'>Return to planning draft</button>'+(p.workloadFrom?'<button data-workload-follow="'+escape(p.workloadFrom.proposalId)+'">Open source workload plan</button>':'')+(p.origin==='week-workload'?'<button data-workload-follow="'+escape(p.id)+'">Follow this workload plan</button>':'');open();return;}
 const taskDetail=t=>escape(t.text)+' · '+escape(t.planDate||'Unscheduled')+' · '+escape(t.startTime||'No reserved time')+' · '+t.duration+' min · '+escape(t.priority)+' priority'+(t.due?' · Due '+escape(t.due):'')+(t.remindAt?' · Reminder '+escape(new Date(t.remindAt).toLocaleString()):'');
 body.innerHTML=`<h2>${escape(p.title)}${timeReview&&!p.changes.length?' · no new time slots':' · not fully saved'}</h2><p>${futureReview?'Review the proposed day. Tasks without a slot keep their entire current schedule; existing commitments stay fixed.':focusReview?'Review today’s proposed times. Tasks without a slot keep their current schedule; existing blocks stay fixed.':weeklyReview?'Review wording, priorities, estimates, dates and any proposed time slots. Existing slots stay fixed unless the estimate or planned day changes.':eveningReview?'Review wording, dates, estimates and any proposed time slots.':'Review every change. Unplaced tasks stay on today’s list but lose their old reserved time.'} Deadlines and reminders stay unchanged.</p>${p.checkin?'<section class="focus-card"><h3>Adjustment for your check-in</h3><p>'+escape(p.checkin.note)+'</p><p>Requested work window '+escape(p.checkin.start+'–'+p.checkin.end)+'. This review does not mark the check-in reviewed or its tasks complete.</p>'+p.checkin.selected.map(s=>'<p><strong>At check-in:</strong> '+taskDetail(s.task)+'</p>'+(s.planned?'<p><strong>Original day plan:</strong> '+taskDetail(s.planned)+'</p>':'')).join('')+'</section>':''}${p.warnings.map(w=>'<p class="planner-warning">'+escape(w)+'</p>').join('')}${(p.targetDays||[]).map(d=>'<details data-evening-day><summary>Planning for '+escape(d.date)+'</summary><p>Search hours '+escape((d.hours||[]).join('–'))+' · Available within '+escape(d.windows.map(w=>w.join('–')).join(', ')||'day off')+' · '+d.breakMinutes+' minute breaks</p>'+(d.capacity?'<p>'+d.capacity.selectedMinutes+' selected task minutes · '+d.capacity.placedMinutes+' assigned to time slots · '+d.capacity.untimedMinutes+(timeReview?' without a new slot':' left untimed')+'. These are estimates for this suggestion.</p>':'')+(d.capacity?.availableMinutes!=null?'<p class="planning-capacity">'+d.capacity.windowMinutes+' minutes in available windows · '+d.capacity.busyMinutes+' occupied · '+d.capacity.bufferMinutes+' reserved for breaks around commitments · <strong>'+d.capacity.availableMinutes+' available before this selection</strong> · largest gap '+d.capacity.largestSlotMinutes+' min · '+d.capacity.remainingMinutes+' remaining after placement.</p><p>Free time may be split across small gaps; breaks around placed tasks are already reserved. Not every estimate will fit.</p>':'')+'<ul>'+d.busy.map(b=>'<li>'+escape(String(Math.floor(b.start/60)).padStart(2,'0')+':'+String(b.start%60).padStart(2,'0')+'–'+String(Math.floor(b.end/60)).padStart(2,'0')+':'+String(b.end%60).padStart(2,'0')+' · '+b.title)+'</li>').join('')+'</ul></details>').join('')}${timeReview&&p.held?.length?'<details id="focus-plan-held"><summary>Kept unchanged ('+p.held.length+')</summary>'+p.held.map(h=>'<p><strong>'+escape(h.text)+'</strong> · '+escape(h.reason)+'</p>').join('')+'</details>':''}${p.estimateFollowThrough?'<details><summary>Estimate context reviewed for this adjustment</summary>'+estimateFollowContext(p.estimateFollowThrough.snapshot,escape)+'</details>':''}${p.followThrough?'<details><summary>Follow-through context reviewed for this adjustment</summary>'+followThroughContextHTML(p.followThrough.snapshot,escape)+'</details>':''}${(p.outcomeSources||[]).map(s=>outcomeSourceHTML(s,escape)).join('')}<div class="task-review-table"><table><thead><tr><th>Task</th><th>Before</th><th>After</th></tr></thead><tbody>${p.changes.map(c=>'<tr><th>'+escape(c.before.text)+'</th><td>'+(eveningReview?taskDetail(c.before):escape(c.before.startTime||'No time'))+'</td><td>'+(eveningReview?taskDetail(c.after):escape(c.unplaced?'Does not fit · no reserved time':c.after.startTime)+' · '+c.after.duration+' min')+(p.saved.includes(c.before.path)?' · Saved':'')+'</td></tr>').join('')}</tbody></table></div>${p.changes.some(c=>c.execution?.length)?'<details class="evening-preview-results"><summary>Current attempts considered in this preview</summary>'+p.changes.filter(c=>c.execution?.length).map(c=>'<h4>'+escape(c.before.text)+'</h4>'+eveningExecution(c.execution,escape)).join('')+'</details>':''}<p>Saved ${p.saved.length} of ${new Set(p.changes.map(c=>c.before.path)).size} task notes. Changes are saved one note at a time; interrupted work remains visible here.</p><button id="replan-accept" class="primary" ${timeReview&&!p.changes.length?'disabled':''}>${futureReview?'Save reviewed day times':focusReview?'Save focused task times':weeklyReview?'Save weekly decisions':eveningReview?'Save evening decisions':'Save reviewed plan'}</button><button id="replan-dismiss">Dismiss remaining changes</button>`;open();
 if(p.reminderDecision)body.insertAdjacentHTML('afterbegin','<button data-reminder-plan-route="'+escape(JSON.stringify({type:'reminder-plan',decisionId:p.reminderDecision.id}))+'">Return to reminder review</button><p>This preview is linked to your explicitly reviewed reminder task. Only saving it records a placement.</p>');
 else if(p.workloadFrom)body.insertAdjacentHTML('afterbegin','<button data-workload-next>Return to unfinished-work draft</button><button data-workload-follow="'+escape(p.workloadFrom.proposalId)+'">Open source workload plan</button>');
 if(p.origin==='week-workload')body.insertAdjacentHTML('afterbegin','<button data-workload-follow="'+escape(p.id)+'">Follow this workload plan</button>');
 $('#replan-accept').onclick=run(async()=>{try{await api('/api/replan/decide',{id:p.id,action:'accept'});await refresh();if(p.reminderDecision)await reminderPlans.fromDecision(p.reminderDecision.id);else if(p.origin==='week-workload')await workloadFollow.show({proposalId:p.id});else if(p.origin==='workload-next')await workloadNext.show();else panel.close();toast(futureReview?'Day times saved. Choose focus separately when that day arrives.':focusReview?'Focused task times saved. Reload focus to review the updated schedule.':weeklyReview?'Weekly decisions saved.':eveningReview?'Evening decisions saved.':'Reviewed day plan saved.');}catch(e){const list=await api('/api/proposals'),latest=list.find(x=>x.id===p.id);if(latest)await showReview(latest);throw e;}});
 $('#replan-dismiss').onclick=run(async()=>{const result=await api('/api/replan/decide',{id:p.id,action:'dismiss'});await refresh();if(p.reminderDecision)await reminderPlans.fromDecision(p.reminderDecision.id);else if(p.origin==='week-workload')await workloadFollow.show({proposalId:p.id});else if(p.origin==='workload-next')await workloadNext.show();else panel.close();toast(result.status==='accepted'?'The reviewed plan was already saved.':result.saved.length?'Remaining changes dismissed; already saved task notes are kept.':'Replan dismissed.');});
 }
 $('#day-next').onclick=run(()=>nextDay.show());
 $('#day-focus').onclick=run(()=>focus.show());
 $('#day-weekly-review').onclick=run(()=>weekly());
 $('#day-history').onclick=run(history);
 $('#day-evening').onclick=run(()=>evening());
 $('#day-replan').onclick=run(choose);$('#day-briefing').onclick=run(async()=>{await briefing();reviewReturn?.clear();});
 document.addEventListener('click',e=>{const el=e.target.closest('[data-day-review]');if(el)run(async()=>{leave();const p=(await api('/api/proposals')).find(p=>p.id===el.dataset.dayReview);if(!p)throw Error('This review was already handled.');await showReview(p);})();});
 // A quiet banner offers the briefing once daily without interrupting drafts or focus.
 const banner=document.createElement('aside');banner.id='morning-briefing';banner.hidden=true;banner.innerHTML='<span>Your daily briefing is ready.</span> <button id="morning-open">Open briefing</button> <button id="morning-dismiss">Later</button>';document.querySelector('main > header').after(banner);
 let seenKey='',checking=false;
 async function check(){if(checking||document.hidden)return;checking=true;try{const b=await api('/api/briefing'),boot=await api('/api/bootstrap');seenKey='aurora-briefing-seen:'+boot.vault;banner.hidden=localStorage.getItem(seenKey)===b.date;banner.dataset.date=b.date;const counts=[b.day.classes.length&&`${b.day.classes.length} classes`,b.day.blocks.filter(x=>x.kind==='task').length&&`${b.day.blocks.filter(x=>x.kind==='task').length} task blocks`,b.day.due.length&&`${b.day.due.length} due today`,b.overdue.length&&`${b.overdue.length} overdue`].filter(Boolean);banner.querySelector('span').textContent='Daily briefing ready'+(counts.length?' · '+counts.join(' · '):'')+'.';}catch{}finally{checking=false;}}
 $('#morning-open').onclick=run(async()=>{const b=await briefing();reviewReturn?.clear();localStorage.setItem(seenKey,b.date);banner.hidden=true;});$('#morning-dismiss').onclick=()=>{localStorage.setItem(seenKey,banner.dataset.date);banner.hidden=true;};
 document.addEventListener('visibilitychange',check);window.addEventListener('focus',check);const timer=setInterval(check,60000);timer.unref?.();check();
 const dispatch=async route=>{
  leave();
  switch(route.type){
   case 'captures':return captures.show();
   case 'shortlist-plan':return shortlistImport.show();
   case 'shortlist-follow':return shortlistFollow.show();
   case 'captured-task':return capturedTask(route);
   case 'task-detail':return taskDetails.show(route.taskId);
   case 'handoff-task':return taskDetails.show(route.taskId,{date:route.date,proposalId:route.proposalId});
   case 'task-schedule':panel.close();return openTaskSchedule(route.taskId);
   case 'estimate-list':return estimates.list();
   case 'estimate':return estimates.show(route.taskId);
   case 'estimate-review':return estimates.recover(route.id);
   case 'session-review':return sessionReviews.show(route.period,route.date);
   case 'session-summary':return sessionReviews.edit(route.period,route.date);
   case 'session-summary-review':return sessionReviews.recover(route.period,route.id);
   case 'focus-session':return sessions.show(route);
   case 'focus-sessions':return sessions.list();
   case 'focus':return focus.show(route.taskId);
   case 'first-step':return firstSteps.show(route.taskId);
   case 'outcome':return outcomes.show(route.taskId,route.sequence);
   case 'reminder-cleanup':return cleanup.show(route);
   case 'cleanup-history':return cleanup.history(route);
   case 'reminder-overview':return reminderOverview.show(route);
   case 'reminder-plan':return route.decisionId?reminderPlans.fromDecision(route.decisionId):reminderPlans.show(route);
   case 'workload-revisits':return revisits.show(route);
   case 'workload-remaining':return workloadRemaining.show(route);
   case 'workload-start':{const q=new URLSearchParams();for(const k of ['date','proposalId','offset'])if(route[k]!==undefined)q.set(k,route[k]);body.innerHTML=workloadStartHTML(await api('/api/workload-start?'+q),escape);open();return;}
   case 'workload-next':return route.proposalId?workloadNext.start(route.proposalId,{date:route.date}):workloadNext.show();
   case 'workload-follow':return workloadFollow.show(route);
   case 'saved-plans':body.innerHTML='<h2>Saved day plans</h2>'+savedPlansHTML(await api('/api/saved-day-plans?date='+encodeURIComponent(route.date)),escape);open();return;
   case 'week-workload':return weekWorkload.show();
   case 'week-capacity':return weekCapacity.show();
   case 'next':return nextDay.show();
   case 'outcome-plan':return outcomePlan.show();
   case 'remainder':return remainder.show();
   case 'adjustments':return adjustments.show(route);
   case 'follow-adjust':return remainder.show(undefined,route);
   case 'checkin-adjust':{const r=await api('/api/check-ins'),c=r.entries.find(c=>c.id===route.id);if(!c)throw Error('This check-in is unavailable. Inspect its saved preview in Review inbox.');return remainder.show(c);}
   case 'estimate-follow':return estimateFollow.show({reviewId:route.reviewId});
   case 'estimate-adjust':return estimateAdjustment.show({reviewId:route.reviewId,taskId:route.taskId});
   case 'follow-through':return followThrough.show(route.proposalId);
   case 'reflection':return reflection.show(route.date);
   case 'summary':return summary.show(route.date);
   case 'summary-review':return summary.recover(route.id);
   case 'checkin':return checkin.show();
   case 'checkins':return checkin.list();
   case 'checkin-detail':return checkin.detail(route.id);
   case 'evening':{const r=await evening(route.date,{workloadOffset:route.workloadOffset});if(route.handoffProposalId){const d=[...body.querySelectorAll('[data-handoff-decision]')].find(d=>d.dataset.handoffDecision===route.handoffProposalId);if(d){d.open=true;d.querySelector('summary').scrollIntoView({block:'center'});}}return r;}
   case 'weekly':return weekly(route.date,{workloadOffset:route.workloadOffset});
   case 'briefing':return briefing();
   case 'proposal':{const p=(await api('/api/proposals')).find(p=>p.id===route.id);if(!p)throw Error('This review was already handled or is unavailable. Reload Continue my day.');return showReview(p);}
   case 'execution':panel.close();return openExecution(route.id);
   case 'attention':panel.close();return openAttention(route.id);
   default:throw Error('This review is unavailable. Reload Continue my day.');
  }
 };
 async function capturedTask(route){
  const r=await taskDetails.show(route.taskId);
  if(['first-step','focus','task-schedule'].includes(route.target)){
   if(r.identityIssue||!r.task||r.task.done){error.textContent=r.identityIssue||'This task is marked complete. Its details remain available; reopen it explicitly before editing or choosing new work.';return;}
   if(route.target==='first-step')await firstSteps.show(route.taskId);
   else if(route.target==='focus')await focus.show(route.taskId);
   else{panel.close();await openTaskSchedule(route.taskId);}
  }
 }
 captures=createCapturedTasks({api,body,panel,open,escape,run,onPlan:()=>navigate({type:'shortlist-plan'})});
 const navigate=route=>run(async()=>{await dispatch(route);if(route.type==='briefing')reviewReturn.clear();})();
 const openCaptured=(route,prepare)=>run(async()=>{leave();await prepare?.();await capturedTask({taskId:route.taskId,target:route.type});})();
 reviewReturn=createReviewReturn({body,panel,button:$('#day-planning-source-back'),dispatch});
 $('#day-planning-source-back').onclick=run(()=>reviewReturn.back());
 $('#day-planning-evening').onclick=()=>navigate({type:'evening'});
 $('#day-planning-cleanup').onclick=()=>navigate({type:'reminder-cleanup'});
 body.addEventListener('click',e=>{const b=e.target.closest('[data-cleanup-route]');if(b)navigate(JSON.parse(b.dataset.cleanupRoute));});
 $('#day-planning-captures').onclick=()=>navigate({type:'captures'});
 $('#day-planning-briefing').onclick=()=>navigate({type:'briefing'});
 $('#day-planning-workload-remaining').onclick=()=>navigate({type:'workload-remaining'});
 body.addEventListener('click',e=>{const b=e.target.closest('[data-reminder-overview-route]');if(b)navigate(JSON.parse(b.dataset.reminderOverviewRoute));});
 body.addEventListener('click',e=>{const b=e.target.closest('[data-reminder-plan-route]');if(b)navigate(JSON.parse(b.dataset.reminderPlanRoute));});
 body.addEventListener('click',e=>{const b=e.target.closest('[data-workload-revisit-route]');if(b)navigate(JSON.parse(b.dataset.workloadRevisitRoute));});
 body.addEventListener('click',e=>{const b=e.target.closest('[data-workload-reflection-route]');if(b)navigate(JSON.parse(b.dataset.workloadReflectionRoute));});
 body.addEventListener('click',e=>{const b=e.target.closest('[data-workload-remaining-route]');if(b)navigate(JSON.parse(b.dataset.workloadRemainingRoute));});
 $('#day-planning-workload-start').onclick=()=>navigate({type:'workload-start'});
 body.addEventListener('click',e=>{if(e.target.closest('[data-workload-start-date]'))navigate({type:'workload-start',date:$('#workload-start-date').value});});
 $('#day-planning-workload-next').onclick=()=>navigate({type:'workload-next'});
 body.addEventListener('click',e=>{const b=e.target.closest('[data-workload-next],[data-workload-next-route]');if(b)navigate(b.dataset.workloadNextRoute?JSON.parse(b.dataset.workloadNextRoute):{type:'workload-next',...(b.dataset.workloadNext?{proposalId:b.dataset.workloadNext}:{})});});
 $('#day-planning-workload-follow').onclick=()=>navigate({type:'workload-follow'});
 body.addEventListener('click',e=>{const b=e.target.closest('[data-workload-follow],[data-workload-follow-route]');if(b)navigate(b.dataset.workloadFollowRoute?JSON.parse(b.dataset.workloadFollowRoute):{type:'workload-follow',...(b.dataset.workloadFollow?{proposalId:b.dataset.workloadFollow}:{all:true})});});
 $('#day-planning-workload').onclick=()=>navigate({type:'week-workload'});
 body.addEventListener('click',e=>{const b=e.target.closest('[data-week-workload],[data-workload-route]');if(b)navigate(b.dataset.workloadRoute?JSON.parse(b.dataset.workloadRoute):{type:'week-workload'});});
 $('#day-planning-week-capacity').onclick=()=>navigate({type:'week-capacity'});
 body.addEventListener('click',e=>{if(e.target.closest('[data-week-capacity]'))navigate({type:'week-capacity'});});
 $('#day-planning-adjustments').onclick=()=>navigate({type:'adjustments'});
 body.addEventListener('click',e=>{const start=e.target.closest('[data-day-start-route],[data-remaining-route],[data-adjustment-route]');if(start){run(()=>dispatch(JSON.parse(start.dataset.dayStartRoute||start.dataset.remainingRoute||start.dataset.adjustmentRoute)))();return;}const h=e.target.closest('[data-handoff-evening]');if(h)navigate({type:'evening',date:h.dataset.handoffEvening||undefined});const b=e.target.closest('[data-captured-open]');if(b)navigate({type:'captured-task',taskId:b.dataset.capturedOpen,target:b.dataset.capturedTarget});if(e.target.closest('[data-captures-list]'))navigate({type:'captures'});if(e.target.closest('[data-shortlist-follow]'))navigate({type:'shortlist-follow'});const p=e.target.closest('[data-shortlist-plan-review]');if(p)navigate({type:'proposal',id:p.dataset.shortlistPlanReview});});
 const workloadEntry=document.createElement('button');workloadEntry.id='day-workload';workloadEntry.textContent='Workload comparison';workloadEntry.onclick=()=>navigate({type:'week-workload'});$('#day-briefing').after(workloadEntry);
 const weekEntry=document.createElement('button');weekEntry.id='day-week-capacity';weekEntry.textContent='Week ahead';weekEntry.onclick=()=>navigate({type:'week-capacity'});$('#day-briefing').after(weekEntry);
 const captureEntry=document.createElement('button');captureEntry.id='day-captured-tasks';captureEntry.textContent='Captured tasks';captureEntry.onclick=()=>navigate({type:'captures'});$('#day-briefing').after(captureEntry);
 const last=document.createElement('button');last.id='day-task-last';last.textContent='Last task details';last.hidden=true;$('#day-briefing').after(last);
 taskDetails=createTaskDetails({api,escape,body,panel,open,run:fn=>run(async()=>{leave();return fn();}),dispatch,backButton:$('#day-planning-task-back'),lastButton:last});
 taskDetails.init().catch(()=>{});
 document.addEventListener('click',e=>{const h=e.target.closest('[data-handoff-task]');if(h){run(()=>dispatch(JSON.parse(h.dataset.handoffTask)))();return;}const b=e.target.closest('[data-open-task-detail]');if(b)navigate({type:'task-detail',taskId:b.dataset.openTaskDetail});});
 return {briefing,choose,navigate,openCaptured};
}
