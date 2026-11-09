import {mountSelection} from './planning-selection.js';
import {createWorkload,readWorkload,writeWorkload,workloadContext} from './week-workload-draft.js';

const time=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
export function createWeekWorkload({api,escape:e,body,open,run,showReview}){
 let keyPromise;
 const keyFor=()=>keyPromise??=api('/api/bootstrap').then(b=>'aurora-week-workload:'+b.vault).catch(x=>{keyPromise=null;throw x;});
 const back='<button data-workload-follow>Saved workload plans</button><button data-week-capacity>Back to full week shortlist</button>';
 async function start(source){const key=await keyFor(),kept=localStorage.getItem(key)!==null;if(!kept)writeWorkload(localStorage,key,null,createWorkload(source));return show({kept});}
 async function show({kept=false}={}){
  const key=await keyFor();let expected=localStorage.getItem(key),draft;
  const $=s=>body.querySelector(s),discard=()=>{$('#workload-discard').onclick=run(async()=>{if(!confirm('Discard this comparison and its local subset choices? The full week draft, saved previews and all tasks are kept.'))return;if(localStorage.getItem(key)!==expected)throw Error('The comparison changed. Reload it before discarding.');localStorage.removeItem(key);await show();});};
  try{draft=readWorkload(localStorage,key);}catch(x){body.innerHTML='<h2>Workload comparison needs attention</h2><p>'+e(x.message)+'</p><button id="workload-discard">Discard unreadable comparison</button>'+back;open();discard();return;}
  if(!draft){body.innerHTML='<h2>Try a smaller workload</h2><p>Choose tasks in Week ahead, then use Try a smaller workload. The full shortlist will be kept while you compare a subset.</p>'+back;open();return;}
  const source=draft.source,pending=draft.selection.pending,ids=source.rows.map(r=>r.taskId);
  const store=current=>{const updated={...draft,selection:current};expected=writeWorkload(localStorage,key,expected,updated);draft=updated;};
  const original='<details id="workload-original"><summary>Retained full shortlist · '+ids.length+' tasks · started from '+e(source.date)+'</summary><p>Original search hours '+e(source.start+'–'+source.end)+' · '+source.gap+' minute breaks. Current comparison uses the hours below and current task estimates.</p>'+source.rows.map(r=>'<p>'+e(r.text)+' · '+e(String(r.task.duration))+' min when retained · deadline '+e(r.task.due||'none')+'</p>').join('')+'</details>';
  if(pending){
   body.innerHTML='<section id="week-workload" data-date="'+e(draft.selection.date)+'"><h2>Recover smaller-workload preview</h2>'+original+'<p>The exact preview request and both sets of choices are kept. Reopening does not roll the week forward.</p><h3>Revised comparison choices</h3>'+draft.selection.rows.filter(r=>r.selected).map(r=>'<p>'+e(r.text)+' · '+e(String(r.task?.duration??'?'))+' min estimate</p>').join('')+'<button data-workload-follow="'+e(pending.requestId)+'">Follow this workload plan</button><button id="workload-resume">Reopen exact preview</button><button id="workload-edit">Edit comparison for a new preview</button>'+back+'</section>';open();
   $('#workload-resume').onclick=run(async()=>{await showReview(await api('/api/next-day/preview',pending));});
   $('#workload-edit').onclick=run(async()=>{const current={...draft.selection};delete current.pending;store(current);await show();});return;
  }
  let report;try{report=await api('/api/week-capacity?date='+encodeURIComponent(draft.selection.date));}catch(x){body.innerHTML='<h2>Workload sources unavailable</h2>'+original+'<p>'+e(x.message)+'</p><button data-week-workload>Reload saved comparison</button>'+back;open();return;}
  const scoped={...report,rows:report.rows.filter(r=>ids.includes(r.taskId))};
  body.innerHTML='<section id="week-workload" data-date="'+e(report.date)+'"><h2>Try a smaller workload</h2><p>Keep tasks checked for the revised workload. Unchecked tasks stay in the full shortlist and keep their current schedules.</p>'+(kept?'<p class="planner-warning">Your earlier workload comparison is kept. Discard it explicitly before starting from different week choices.</p>':'')+original+(report.date<report.today?'<p class="planner-warning">This comparison keeps its original week. Choose a new first day explicitly when ready.</p>':'')+'<label>First day <input id="workload-date" type="date" value="'+e(report.date)+'"></label><button id="workload-load">Use this first day</button><button id="workload-reload">Reload saved comparison</button><div id="workload-choices"></div><button id="workload-compare" class="primary">Compare full shortlist and subset</button><p id="workload-status" role="status"></p><div id="workload-results"></div><button id="workload-discard">Discard this comparison</button>'+back+'</section>';
  const root=$('#workload-choices'),results=$('#workload-results'),status=$('#workload-status');let comparison=null,signature=null;
  const adapter={getItem:()=>JSON.stringify(draft.selection),setItem:(_key,value)=>store(JSON.parse(value)),removeItem:()=>{throw Error('Use Discard this comparison to remove the retained shortlist.');}};
  const selection=mountSelection({root,report:scoped,storage:adapter,key,escape:e,prefix:'workload',attribute:'data-workload-task',loadedDraft:draft.selection,rowDetails:(row,saved)=>{
   const original=source.rows.find(r=>r.taskId===saved.taskId);
   return '<p>Retained estimate: '+e(String(original.task.duration))+' min · Current deadline: '+e(row?.task?(row.task.due||'none'):'unavailable')+'</p><button data-workload-route="'+e(JSON.stringify({type:'first-step',taskId:saved.taskId}))+'">First step</button><button data-workload-route="'+e(JSON.stringify({type:'estimate',taskId:saved.taskId}))+'">Review recorded estimate</button><button data-workload-route="'+e(JSON.stringify({type:'task-schedule',taskId:saved.taskId}))+'">Edit task / estimate</button>';
  }});
  root.querySelector('[data-selection-reset]').hidden=true;root.dataset.readingContext='workload:'+report.date;
  const input=()=>{const selected=selection.selected({allowEmpty:true,persist:false}),d=selection.read();return {date:report.date,today:report.today,timezone:report.timezone,shortlistIds:ids,selected,start:d.start,end:d.end,gap:d.gap};};
  const invalidate=()=>{if(!comparison)return;comparison=null;signature=null;status.textContent='Choices changed. Compare again before previewing a day.';for(const b of results.querySelectorAll('[data-workload-preview]'))b.disabled=true;};
  root.addEventListener('input',invalidate);root.addEventListener('change',invalidate);root.addEventListener('click',event=>{if(event.target.closest('[data-selection-confirm],[data-selection-date-confirm]'))invalidate();});
  $('#workload-reload').onclick=run(()=>show());
  $('#workload-load').onclick=run(async()=>{selection.save();store({...draft.selection,date:$('#workload-date').value});await show();});
  const totals=r=>r.selectedMinutes+' estimated min'+(r.unknownEstimates?' + '+r.unknownEstimates+' unknown estimate(s)':'');
  const details=(day,label)=>'<details><summary>'+label+' · '+day.fits.length+' task(s) fit</summary>'+day.fits.map(r=>'<p>'+e(r.startTime+' · '+r.text+' · '+r.duration+' min')+'</p>').join('')+day.held.map(r=>'<p>Kept unchanged: '+e(r.text+' · '+r.reason)+'</p>').join('')+day.deadlines.filter(r=>r.afterDeadline).map(r=>'<p class="planner-warning">After unchanged deadline: '+e(r.text+' · '+r.due)+'</p>').join('')+'</details>';
  const compare=async()=>{
   comparison=null;signature=null;results.replaceChildren();const request=input(),r=await api('/api/week-workload/assess',request);comparison=r;signature=JSON.stringify(request);
   status.textContent='Full shortlist: '+r.full.selectedCount+' tasks · '+totals(r.full)+'. Revised selection: '+r.revised.selectedCount+' tasks · '+totals(r.revised)+'. Both use current estimates and the same commitments. No task changes made.';
   results.innerHTML='<div class="week-capacity-grid">'+r.revised.days.map((day,i)=>{
    const full=r.full.days[i];return '<article class="focus-card" data-workload-day="'+e(day.date)+'"><h3>'+e(day.date)+'</h3>'+(!day.available?'<p class="planner-warning">Capacity unavailable: '+e(day.error)+'</p>':'<p><strong>'+day.capacity.availableMinutes+' min free · largest slot '+day.capacity.largestSlotMinutes+' min</strong></p><p>Full shortlist: '+full.fits.length+'/'+r.full.selectedCount+' fit · '+(full.available?full.capacity.placedMinutes+' min placed':'capacity unavailable: '+e(full.error))+'</p><p>Revised: '+day.fits.length+'/'+r.revised.selectedCount+' fit · '+day.capacity.placedMinutes+' min placed · '+day.capacity.remainingMinutes+' min remain after placement and breaks</p>'+details(full,'Full shortlist')+details(day,'Revised placements')+'<details><summary>Commitments and planning notes</summary><p>'+e(day.hours.join('–'))+' search hours · '+day.breakMinutes+' minute breaks</p>'+day.busy.map(b=>'<p>'+e(b.title)+' · '+e(time(b.start)+'–'+time(b.end))+'</p>').join('')+day.warnings.map(w=>'<p>'+e(w)+'</p>').join('')+'</details><button data-workload-preview="'+e(day.date)+'" '+(!day.fits.length?'disabled':'')+'>Preview revised day</button>')+'</article>';
   }).join('')+'</div>';
  };
  $('#workload-compare').onclick=run(async()=>{selection.save();await compare();});
  results.addEventListener('click',event=>{const b=event.target.closest('[data-workload-preview]');if(b)run(async()=>{
   if(!comparison||JSON.stringify(input())!==signature)throw Error('Compare the current choices before previewing.');
   const day=comparison.revised.days.find(d=>d.date===b.dataset.workloadPreview);if(!day?.preview||!day.fits.length)throw Error('Choose a day with available time.');
   selection.save();selection.setPending({...day.preview,workloadSource:workloadContext(draft),requestId:crypto.randomUUID()});const request=draft.selection.pending;await show();await showReview(await api('/api/next-day/preview',request));
  })();});
  discard();open();try{await compare();}catch(x){status.textContent=x.message;}
 }
 return {show,start};
}
