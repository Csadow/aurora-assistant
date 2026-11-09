import {markPlanningReview} from './review-return.js';
import {cleanupRecovery,cleanupRecoveryHTML} from './cleanup-recovery.js';
import {workloadReflectionSection} from './workload-reflection.js';
import {guardPlanningDraft} from './planning-draft-guard.js';
import {dayHandoffHTML,eveningShortlist} from './day-handoff.js';
import {stepOutcomesReview} from './step-outcomes.js';
import {checkinReviewSection} from './checkin-review.js';
import {focusReviewSection,bindFocusReview} from './focus-review.js';
const stamp=task=>JSON.stringify([task.revision,task.focusChoice||null,(task.execution||[]).map(e=>[e.id,e.executionRevision]).sort((a,b)=>a[0].localeCompare(b[0]))]);
const identity=t=>t.id||t.path+'\n'+t.line;

export function eveningExecution(items,escape){
 return items.map(e=>{
  const r=e.results;
  return `<section class="evening-execution" data-evening-execution="${escape(e.id)}"><strong>${escape(e.detail)}</strong>${e.changed?'<p>Planner task changed since execution was prepared.</p>':''}${e.attention&&e.attention.detail!==r?.question?'<p>'+escape(e.attention.detail)+'</p>':''}${r?(r.question?'<p><strong>Aurora asks:</strong> '+escape(r.question)+'</p>':'')+(r.error?'<p>'+escape(r.error)+'</p>':'')+'<details><summary>Recorded progress · '+r.checksPassed+' / '+r.checksTotal+' checks passed</summary><p>'+escape(r.notice)+'</p>'+r.steps.map(s=>'<p><strong>'+escape(s.title)+' · '+escape(s.status)+'</strong><br>'+escape(s.summary||'No result recorded for this step.')+'</p>').join('')+(r.stepCount>r.steps.length?'<p>Showing the last '+r.steps.length+' of '+r.stepCount+' steps. Open the workflow for the full journal.</p>':'')+r.unresolved.map(s=>'<p class="planner-warning">'+escape(s)+'</p>').join('')+'</details>':''}${e.attention?'<button data-planner-attention="'+escape(e.id)+'">'+escape(e.attention.label)+'</button>':''}</section>`;
 }).join('');
}

export function createEveningReview({api,escape,body,panel,open,run,showReview}){
 let capture=null,keyPromise;
 panel.addEventListener('close',()=>capture?.());
 body.addEventListener('click',e=>{if(e.target.closest('[data-follow-through],[data-outcome-plan],[data-step-outcome],[data-first-step],[data-planner-attention],[data-checkin-open],[data-daily-summary],[data-day-review],[data-briefing-note],[data-open-workflow]'))capture?.();});
 return async function evening(date,{workloadOffset=0}={}){
  const r=await api('/api/evening'+(date?'?date='+encodeURIComponent(date):''));
  keyPromise??=api('/api/bootstrap').then(b=>'aurora-evening-choices:'+b.vault+':').catch(e=>{keyPromise=null;throw e;});
  const key=(await keyPromise)+r.date;let handoff,handoffError;try{handoff=await api('/api/day-handoff?date='+encodeURIComponent(r.date));}catch(e){handoffError=e.message;}
  const shortlist=await eveningShortlist({api,vault:(await api('/api/bootstrap')).vault,date:r.date,today:r.today,escape});
  const workloads=await workloadReflectionSection({api,escape,period:'day',date:r.date,offset:workloadOffset});
  const cleanup=await cleanupRecovery({api,storage:localStorage,vault:(await api('/api/bootstrap')).vault,date:r.date});
  const cleanupHTML=cleanupRecoveryHTML(cleanup,escape,(label,route)=>'<button data-cleanup-route="'+escape(JSON.stringify(route))+'">'+escape(label)+'</button>',{id:'evening-cleanup-recovery'});
  let draft;try{draft=JSON.parse(localStorage.getItem(key));}catch{}
  if(draft?.version!==1||!Array.isArray(draft.choices))draft=null;
  const tomorrow=new Date(r.today+'T12:00:00Z');tomorrow.setUTCDate(tomorrow.getUTCDate()+1);const next=tomorrow.toISOString().slice(0,10);
  const bases=new Map(),orphaned=(draft?.choices||[]).filter(c=>!r.unfinished.some(t=>identity(t)===identity(c.task)));
  body.innerHTML=`<h2>Evening review</h2><button data-daily-summary="${escape(r.date)}">Review daily summary</button><button data-next-day>Plan tomorrow / reopen day draft</button><p>Review Aurora’s latest attempt, then choose what to carry forward. Opening a question or result keeps these choices. Scheduling does not resume execution.</p><label>Review date <input id="evening-date" type="date" max="${escape(r.today)}" value="${escape(r.date)}"></label><button id="evening-load">Load day</button><p id="evening-draft-status" role="status"></p><button id="evening-clear">Discard saved choices</button>${orphaned.length?'<p class="planner-warning">Saved choices for tasks no longer unfinished on this day will not be applied: '+orphaned.map(c=>escape(c.text||c.task.text)).join(', ')+'. Discard saved choices when you no longer need them.</p>':''}${cleanupHTML}${workloads}${dayHandoffHTML(handoff,handoffError,escape,{id:'evening-handoff'})}${shortlist}${focusReviewSection(r.focusReview,escape,eveningExecution)}${checkinReviewSection(r.checkins,r.checkinsError,escape)}${stepOutcomesReview(r.stepOutcomes,r.stepOutcomesError,escape)}<h3>Currently marked complete</h3>${r.completed.length?'<ul>'+r.completed.map(t=>'<li>'+escape(t.text)+'</li>').join('')+'</ul>':'<p>None.</p>'}<p>Tasks planned for this day and unscheduled focus tasks are included. These are current checkbox states, not completion times.</p><h3>Unfinished</h3><div id="evening-choices">${r.unfinished.map((t,i)=>`<fieldset data-evening-row="${i}"><legend>${escape(t.text)}</legend><p>${escape(t.startTime||'No time')} · ${t.duration} min · ${escape(t.due?'Due '+t.due:'No deadline')}${t.locked?' · In progress or invalid identity / metadata; unchanged':!t.planDate?' · Unscheduled focus intention':''}</p>${(t.dependencyReasons||[]).map(s=>'<p class="planner-warning">'+escape(s)+'</p>').join('')}${eveningExecution(t.execution||[],escape)}<p data-evening-stale class="planner-warning" hidden>Task or execution changed since these choices were saved. Compare the current task and results above before keeping your choices.</p><button data-evening-current hidden>Use current task and results with these choices</button><label>Decision <select data-evening-action ${t.locked?'disabled':''}><option value="keep">Leave unchanged</option><option value="move">Carry forward</option><option value="unschedule">Leave unscheduled</option><option value="reduce">Make a smaller step · unscheduled</option></select></label><label>Carry to <input data-evening-date type="date" min="${next}" value="${next}"></label><label>Task / smaller step <input data-evening-text value="${escape(t.text)}" maxlength="600"></label><label>Estimate (minutes) <input data-evening-duration type="number" min="5" max="${t.duration}" value="${t.duration}"></label></fieldset>`).join('')||'<p>No unfinished tasks planned for this day.</p>'}</div><fieldset><legend>Plan carried-forward work</legend><label class="check-row"><input id="evening-reserve" type="checkbox">Find time around classes, prerequisites and Google Calendar</label><p>Tasks that do not fit stay on the chosen day without a reserved time. Existing blocks stay fixed. Saved availability and breaks also apply.</p><label>Start after <input id="evening-start" type="time" value="09:00"></label><label>Finish by <input id="evening-end" type="time" value="18:00"></label><label>Break (minutes) <input id="evening-gap" type="number" min="0" max="120" value="10"></label></fieldset><button id="evening-preview" class="primary">Preview chosen changes</button>`;
  const $=s=>body.querySelector(s),rows=[...body.querySelectorAll('[data-evening-row]')];
  const choices=(includeLocked=false)=>rows.filter(row=>row.querySelector('[data-evening-action]').value!=='keep'&&(includeLocked||!row.querySelector('[data-evening-action]').disabled)).map(row=>({task:bases.get(row),action:row.querySelector('[data-evening-action]').value,date:row.querySelector('[data-evening-date]').value,text:row.querySelector('[data-evening-text]').value,duration:Number(row.querySelector('[data-evening-duration]').value)}));
  const options=()=>({reserveTimes:$('#evening-reserve').checked,start:$('#evening-start').value,end:$('#evening-end').value,gap:Number($('#evening-gap').value)});
  const status=$('#evening-draft-status');
  capture=(strict=false)=>{
   if(!body.contains(status))return;
   try{const selected=[...choices(true),...orphaned];if(selected.length){localStorage.setItem(key,JSON.stringify({version:1,choices:selected,options:options()}));status.textContent='Choices saved on this desktop. No task changes yet.';}else{localStorage.removeItem(key);status.textContent='No task changes selected.';}}
   catch{status.textContent='Choices could not be stored on this desktop. Keep this view open and retry.';if(strict)throw Error(status.textContent);}
  };
  for(const row of rows){
   const t=r.unfinished[Number(row.dataset.eveningRow)],saved=draft?.choices.find(c=>identity(c.task)===identity(t));bases.set(row,saved?.task||t);
   if(saved)for(const field of ['action','date','text','duration'])if(saved[field]!=null)row.querySelector('[data-evening-'+field+']').value=saved[field];
   const select=row.querySelector('[data-evening-action]'),stale=row.querySelector('[data-evening-stale]'),current=row.querySelector('[data-evening-current]');
   const update=()=>{row.querySelector('[data-evening-date]').disabled=select.disabled||select.value!=='move';for(const field of ['text','duration'])row.querySelector('[data-evening-'+field+']').disabled=select.disabled||select.value==='keep';stale.hidden=current.hidden=select.value==='keep'||select.disabled||stamp(bases.get(row))===stamp(t);};
   current.onclick=()=>{bases.set(row,t);update();capture();};select.onchange=()=>{update();capture();};update();
  }
  if(draft?.options){$('#evening-reserve').checked=draft.options.reserveTimes===true;for(const field of ['start','end','gap'])if(draft.options[field]!=null)$('#evening-'+field).value=draft.options[field];}
  const timing=()=>{for(const field of ['start','end','gap'])$('#evening-'+field).disabled=!$('#evening-reserve').checked;};timing();
  body.oninput=body.onchange=()=>{if(body.contains(status)){timing();capture?.();}};
  status.textContent=draft?'Restored your saved choices. Review current results before previewing.':'Nothing changes until you preview and save.';
  bindFocusReview({report:r.focusReview,body,api,run,storageKey:key,capture:()=>capture?.(),reload:evening});
  $('#evening-clear').onclick=run(async()=>{if(!confirm('Discard saved evening choices for this day?'))return;localStorage.removeItem(key);capture=null;await evening(r.date);});
  $('#evening-load').onclick=run(async()=>{capture();await evening($('#evening-date').value);});
  $('#evening-preview').onclick=run(async()=>{
   if(rows.some(row=>!row.querySelector('[data-evening-stale]').hidden))throw Error('Review the changed task or attempt above, then choose “Use current task and results with these choices”.');
   capture();const p=await api('/api/evening/preview',{date:r.date,choices:choices(),...options()});
   capture=null;body.oninput=body.onchange=null;
   // The proposal is now durable in Review inbox; do not recreate its decisions.
   try{const remaining=[...choices(true).filter(c=>r.unfinished.find(t=>identity(t)===identity(c.task))?.locked),...orphaned];if(remaining.length)localStorage.setItem(key,JSON.stringify({version:1,choices:remaining,options:options()}));else localStorage.removeItem(key);}catch{}
   await showReview(p);
  });
  guardPlanningDraft(body,status,()=>capture(true));
  markPlanningReview(body,status,{type:'evening',date:r.date,workloadOffset},'evening review · '+r.date);
  open();return r;
 };
}
