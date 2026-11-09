import {mountSelection,readSelection} from './planning-selection.js';

const time=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
export function createWeekCapacity({api,escape,body,open,run,showReview,openWorkload}){
 let keyPromise;
 async function show(target){
  keyPromise??=api('/api/bootstrap').then(b=>'aurora-week-capacity-draft:'+b.vault).catch(e=>{keyPromise=null;throw e;});const key=await keyPromise;
  let draft,error;try{draft=readSelection(localStorage,key);}catch(e){error=e.message;}
  const pending=error?null:draft?.pending;
  let report;try{report=await api('/api/week-capacity'+(target||draft?.date?'?date='+encodeURIComponent(target||draft.date):''));}
  catch(e){
   if(!pending)throw e;
   body.innerHTML='<h2>Week ahead · recover preview</h2><p>'+escape(e.message)+'</p><p>Your exact preview request is kept.</p><button id="week-capacity-resume">Reopen previous preview</button>';open();
   body.querySelector('#week-capacity-resume').onclick=run(async()=>showReview(await api('/api/next-day/preview',pending)));return;
  }
  if(target&&draft&&!error&&!pending){draft={...draft,date:report.date};localStorage.setItem(key,JSON.stringify(draft));}
  body.innerHTML=`<section id="week-capacity" data-date="${escape(report.date)}"><h2>Week ahead · ${escape(report.date)} to ${escape(report.dates.at(-1))}</h2><p>Compare the same unfinished work on each day before choosing a date. Each card is an alternative; tasks are not spread across the week.</p><p>Estimates describe planned work, not measured effort. Deadlines stay unchanged. Saved availability and breaks take precedence over the hours below.</p><label>First day <input id="week-capacity-date" type="date" value="${escape(report.date)}"></label><button id="week-capacity-load">Compare from this date</button><button id="week-capacity-reload">Reload current details</button>${report.date<report.today?'<p class="planner-warning">Your saved week has not been rolled forward. Choose a new first day explicitly when ready.</p>':''}${report.warnings.map(w=>'<p class="planner-warning">'+escape(w)+'</p>').join('')}<div id="week-capacity-pending" ${pending?'':'hidden'}><p>This draft has a saved preview or interrupted request. Reopen the exact request to check its progress.</p><button id="week-capacity-resume">Reopen previous preview</button><button id="week-capacity-edit">Edit comparison for a new preview</button></div><details id="week-capacity-choices" open><summary>Tasks and search hours</summary><div id="week-capacity-draft"></div></details><button id="week-capacity-compare" class="primary">Compare seven days</button><button id="week-capacity-smaller">Try a smaller workload</button><button data-week-workload>Reopen workload comparison</button><p id="week-capacity-status" role="status"></p><div id="week-capacity-results"></div></section>`;
  const $=s=>body.querySelector(s),root=$('#week-capacity-draft'),status=$('#week-capacity-status'),results=$('#week-capacity-results');
  // A locked request has no live selection editor. Opening it must not merge new
  // candidate rows into the retained draft or register an autosave/toggle guard.
  let selection=null;
  if(pending)root.innerHTML='<p>Retained choices · '+escape(draft.start+'–'+draft.end)+' · '+draft.gap+' minute breaks</p>'+draft.rows.filter(r=>r.selected).map(r=>'<p>'+escape(r.text)+' · '+escape(String(r.task?.duration??'?'))+' min estimate</p>').join('');
  else selection=mountSelection({root,report,storage:localStorage,key,escape,prefix:'week-capacity',attribute:'data-week-capacity-task',loadedDraft:draft,loadError:error,rowDetails:row=>row?.task?'<p>Deadline: '+escape(row.task.due||'None')+(row.eligibleDates.length?' · Eligible days: '+escape(row.eligibleDates.join(', ')):'')+'</p>':''});
  root.dataset.readingContext='week-capacity:'+report.date;root.dataset.readingDisabled=String(!!error);
  let comparison=null,signature=null,locked=!!pending||!!error;
  const lock=()=>{root.inert=!!pending;for(const id of ['compare','load','smaller'])$('#week-capacity-'+id).disabled=locked;};lock();
  const input=()=>{const selected=selection.selected({allowEmpty:true,persist:false}),d=selection.read();return {date:report.date,today:report.today,timezone:report.timezone,selected,start:d.start,end:d.end,gap:d.gap};};
  const invalidate=()=>{if(!comparison)return;comparison=null;signature=null;status.textContent='Choices changed. Compare again before choosing a day.';for(const b of results.querySelectorAll('[data-week-capacity-preview]'))b.disabled=true;results.setAttribute('aria-label','Previous comparison; choices have changed');};
  root.addEventListener('input',invalidate);root.addEventListener('change',invalidate);root.addEventListener('click',e=>{if(e.target.closest('[data-selection-confirm],[data-selection-date-confirm]'))invalidate();});
  root.addEventListener('selection-reset',run(()=>show()));
  $('#week-capacity-load').onclick=run(async()=>{selection.save();await show($('#week-capacity-date').value);});
  $('#week-capacity-reload').onclick=run(async()=>{if(!error&&!pending)selection.save();await show();});
  const compare=async()=>{
   const request=input();comparison=null;signature=null;results.replaceChildren();
   const report=await api('/api/week-capacity/assess',request);comparison=report;signature=JSON.stringify(request);results.removeAttribute('aria-label');
   status.textContent=report.selected.length+' selected task(s) · '+report.selectedMinutes+' estimated minutes on each alternative day. Updated '+new Date(report.generatedAt).toLocaleTimeString()+'. Comparison has made no task or Calendar changes.';
   results.innerHTML=weekCapacityCards(report,escape);
  };
  $('#week-capacity-smaller').onclick=run(async()=>{selection.selected();const d=selection.save();await openWorkload({...d,rows:d.rows.filter(r=>r.selected)});});
  $('#week-capacity-compare').onclick=run(async()=>{selection.save();await compare();});
  const preview=async request=>{
   if(!pending){selection.save();selection.setPending(request);}locked=true;root.inert=true;for(const id of ['compare','load','smaller'])$('#week-capacity-'+id).disabled=true;$('#week-capacity-pending').hidden=false;for(const b of results.querySelectorAll('[data-week-capacity-preview]'))b.disabled=true;
   // The regular day preview refreshes Calendar and checks current tasks/classes;
   // the user reviews those current placements before any schedule can be saved.
   await showReview(await api('/api/next-day/preview',request));
  };
  results.addEventListener('click',e=>{const button=e.target.closest('[data-week-capacity-preview]');if(button)run(async()=>{if(!comparison||JSON.stringify(input())!==signature)throw Error('Choices changed. Compare again before choosing a day.');const day=comparison.days.find(d=>d.date===button.dataset.weekCapacityPreview);if(!day?.preview||!day.fits.length)throw Error('Compare available days first.');await preview({...day.preview,requestId:crypto.randomUUID()});})();});
  $('#week-capacity-resume').onclick=run(async()=>{const saved=readSelection(localStorage,key);if(saved?.pending)await preview(saved.pending);});
  $('#week-capacity-edit').onclick=run(async()=>{const d=readSelection(localStorage,key);if(d){delete d.pending;localStorage.setItem(key,JSON.stringify(d));}await show();});
  open();if(!locked)try{await compare();}catch(e){status.textContent=e.message;}
  return report;
 }
 return {show};
}

export function weekCapacityCards(report,escape,attribute='data-week-capacity-preview'){
 return '<div class="week-capacity-grid">'+report.days.map(day=>{
    const cap=day.capacity,deadline=day.deadlines.filter(d=>d.afterDeadline),fits=day.fits.length,held=day.held.length;
    return '<article class="focus-card" data-week-capacity-day="'+escape(day.date)+'"><h3>'+escape(new Date(day.date+'T12:00:00').toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'}))+'</h3>'+(!day.available?'<p class="planner-warning">Capacity unavailable: '+escape(day.error)+'</p>':'<p><strong>'+cap.availableMinutes+' min free · largest slot '+cap.largestSlotMinutes+' min</strong></p><p>'+fits+' of '+report.selected.length+' tasks fit · '+cap.placedMinutes+' estimated minutes placed · '+(day.selectedMinutes-cap.placedMinutes)+' minutes without a new slot.</p><p>'+cap.windowMinutes+' minutes in available windows · '+cap.busyMinutes+' occupied · '+cap.bufferMinutes+' for breaks around commitments · '+day.breakMinutes+' minute breaks</p>'+(cap.availableMinutes>cap.largestSlotMinutes?'<p>Free time is split across several slots. A long task may not fit even when total free minutes look sufficient.</p>':'')+'<details><summary>Free slots and commitments</summary><p>Search hours '+escape(day.hours.join('–'))+' · Saved windows '+escape(day.windows.map(w=>w.join('–')).join(', ')||'day off')+'</p><p>Free before selected work: '+escape(cap.freeSlots.map(([s,e])=>time(s)+'–'+time(e)).join(', ')||'none')+'</p>'+day.busy.map(b=>'<p>'+escape(time(b.start)+'–'+time(b.end)+' · '+b.title+' · '+b.kind)+'</p>').join('')+'</details>')+(deadline.length?'<p class="planner-warning">After unchanged deadline: '+deadline.map(d=>escape(d.text+' (due '+d.due+')')).join('; ')+'.</p>':'')+(held?'<details><summary>'+held+' task(s) kept unchanged</summary>'+day.held.map(h=>'<p>'+escape(h.text+': '+h.reason)+'</p>').join('')+'</details>':'')+(day.available?'<details><summary>Placement and planning notes</summary>'+day.fits.map(f=>'<p>'+escape(f.startTime+' · '+f.text+' · '+f.duration+' min')+'</p>').join('')+day.warnings.map(w=>'<p>'+escape(w)+'</p>').join('')+'</details><button '+attribute+'="'+escape(day.date)+'" '+(!fits?'disabled':'')+'>Preview this day</button>':'')+'</article>';
   }).join('')+'</div>';
}
