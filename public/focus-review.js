const nextDay=date=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);};
const taskInfo=(t,escape)=>t?escape(t.text)+' · '+escape(t.planDate||'Unscheduled')+(t.startTime?' '+escape(t.startTime):' · No reserved time')+' · '+t.duration+' min estimate · '+(t.done?'Marked complete':'Open'):'Unavailable in active notes';

export function focusReviewCatchup(days,today,escape){
 const missed=(days||[]).filter(d=>d.date<today&&d.pending);
 return missed.length?'<section class="focus-review-catchup"><h3>Focus reviews to catch up</h3><p>'+missed.length+' day(s) have intentions you have not reviewed. Nothing has been carried forward automatically.</p>'+missed.slice(0,14).map(d=>'<button data-focus-review-date="'+escape(d.date)+'">'+escape(d.date)+' · '+d.pending+' to review</button>').join('')+(missed.length>14?'<p>Showing the oldest 14 days. Use the review date picker to open another day.</p>':'')+'</section>':'';
}
export function focusReviewSection(r,escape,executionHTML){
 if(!r)return '';
 return focusReviewCatchup(r.days,r.today,escape)+`<section id="evening-focus-review"><h3>Focus intentions · ${escape(r.date)}</h3><p>Compare what you chose with the task and latest attempt now. Estimates, checkboxes and attempt results do not measure time spent or productivity.</p><p>${r.pending} intention(s) to review. Review decisions save immediately; task scheduling below has its own preview and save.</p><div id="focus-review-retry" hidden><p>A previous decision may already be saved. Check its receipt before making another choice.</p><button id="focus-review-retry-save">Retry previous decision</button><button id="focus-review-retry-clear">Discard retry and reload details</button></div>${r.rows.map(row=>`<article class="focus-card" data-focus-review-row="${escape(row.taskId)}"><h4>${escape(row.text)}</h4><p><strong>When chosen:</strong> ${taskInfo(row.intention.task,escape)}</p><p><strong>Current task:</strong> ${taskInfo(row.task,escape)}</p>${row.changed?'<p class="planner-warning">The current task differs from the saved intention.</p>':''}${row.identityIssue?'<p class="planner-warning">'+escape(row.identityIssue)+'</p>':''}${row.dependencyReasons.map(s=>'<p class="planner-warning">'+escape(s)+'</p>').join('')}${executionHTML(row.execution,escape)}${row.decision?'<p class="focus-review-saved">'+(row.decision.action==='reconsider'?'Reconsideration requested for '+escape(row.decision.until):'Reviewed; no reminder requested')+' · Saved '+escape(new Date(row.decision.at).toLocaleString())+'</p><details><summary>Task at review</summary><p>'+taskInfo(row.decision.task,escape)+'</p></details>':''}<div class="focus-actions"><button data-focus-review-action="reviewed">Mark intention reviewed</button><label>Reconsider on <input data-focus-review-until type="date" min="${nextDay(r.today)}" value="${escape(row.decision?.until>r.today?row.decision.until:nextDay(r.today))}"></label><button data-focus-review-action="reconsider" ${row.identityIssue||row.task?.done?'disabled':''}>Remind me to reconsider</button></div><p>Reviewing keeps the task and today’s focus unchanged. A reminder offers this task from the chosen day, including after days away. It does not reserve time.</p>${row.task&&!row.task.done&&!row.identityIssue?'<p>'+(row.task.planDate&&row.task.planDate!==r.date?'This task already belongs to '+escape(row.task.planDate)+'. Open that day to change its schedule.':'Use the unfinished task controls below to plan a future day or reduce this task.')+'</p>':''}</article>`).join('')||'<p>No focus intentions were saved for this date.</p>'}</section>`;
}

export function bindFocusReview({report,body,api,run,storageKey,capture,reload}){
 if(!report)return;
 const key=storageKey+':focus-review-request',retry=body.querySelector('#focus-review-retry');let pending;
 try{pending=JSON.parse(localStorage.getItem(key));}catch{}
 const controls=[...body.querySelectorAll('[data-focus-review-action]')];
 if(pending){retry.hidden=false;for(const button of controls)button.disabled=true;}
 const save=async input=>{
  capture();localStorage.setItem(key,JSON.stringify(input));pending=input;retry.hidden=false;for(const button of controls)button.disabled=true;
  await api('/api/daily-focus/review/decide',input);localStorage.removeItem(key);pending=null;await reload(report.date);
 };
 for(const button of controls)button.onclick=run(async()=>{
  const card=button.closest('[data-focus-review-row]'),row=report.rows.find(r=>r.taskId===card.dataset.focusReviewRow),action=button.dataset.focusReviewAction;
  await save({requestId:crypto.randomUUID(),date:report.date,today:report.today,timezone:report.timezone,revision:report.revision,taskId:row.taskId,contextRevision:row.contextRevision,action,until:action==='reconsider'?card.querySelector('[data-focus-review-until]').value:null});
 });
 body.querySelector('#focus-review-retry-save').onclick=run(async()=>{if(pending)await save(pending);});
 body.querySelector('#focus-review-retry-clear').onclick=run(async()=>{capture();localStorage.removeItem(key);await reload(report.date);});
}
