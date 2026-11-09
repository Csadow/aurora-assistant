import {outcomeDraftError,outcomeSelectionHTML} from './outcome-planning.js';
import {mountSelection,readSelection} from './planning-selection.js';
export function createNextDay({api,escape,body,panel,open,run,showReview,outcomes=false}){
 let keyPromise,selection=null,report=null,key=null,pending=null;
 async function show(target){
  keyPromise??=api('/api/bootstrap').then(b=>(outcomes?'aurora-outcome-plan-draft:':'aurora-next-day-draft:')+b.vault).catch(e=>{keyPromise=null;throw e;});key=await keyPromise;
  let draft,error;try{draft=readSelection(localStorage,key);}catch(e){error=e.message;}
  if(outcomes&&!error)error=outcomeDraftError(draft);
  try{report=await api((outcomes?'/api/outcome-plan':'/api/next-day')+(target||draft?.date?'?date='+encodeURIComponent(target||draft.date):''));}
  catch(e){
   if(!outcomes||error||!draft?.pending)throw e;
   body.innerHTML='<h2>Recover unfinished-step preview</h2><p id="next-day-source-error">Current sources are unavailable: '+escape(e.message)+'</p><p>Your draft and exact request have been kept. Reopen the saved preview to inspect its progress. Any unsaved changes still require valid current sources.</p><button id="next-day-resume">Reopen previous preview</button><button data-outcome-plan>Reload current sources</button>';open();
   body.querySelector('#next-day-resume').onclick=run(async()=>showReview(await api('/api/next-day/preview',draft.pending)));return;
  }
  if(target&&draft&&!error){draft={...draft,date:report.date};localStorage.setItem(key,JSON.stringify(draft));}
  pending=error?null:draft?.pending||null;
  body.innerHTML=`<h2>${outcomes?'Plan from unfinished steps':'Plan a day'} · ${escape(report.date)}</h2>${outcomes?'<p>This separate draft keeps the reports that prompted each selection. Compare the task, prerequisites, project and current attempts before choosing time.</p><button data-next-day>Open ordinary day draft</button>':'<button data-outcome-plan>Plan from unfinished steps</button><button data-week-capacity>Compare the week ahead</button>'}<p>Reopen this draft to choose a manageable workload. Existing timed commitments stay fixed. Tasks that do not fit keep their whole current schedule. Saving a schedule does not choose focus or start execution.</p><label>Planning date <input id="next-day-date" type="date" min="${escape(report.today)}" value="${escape(report.date)}"></label><button id="next-day-load">Load this day</button><button id="next-day-reload">Reload current task details</button>${report.date<report.today?'<p class="planner-warning">This saved draft is for a past day. Choose a current or future date; it has not been rolled forward.</p>':''}${report.warnings.map(w=>'<p class="planner-warning">'+escape(w)+'</p>').join('')}<div id="next-day-pending" ${pending?'':'hidden'}><p>A saved preview or interrupted request belongs to this draft. Reopen it to check its progress.</p><button id="next-day-resume">Reopen previous preview</button><button id="next-day-edit">Edit draft for a new preview</button></div><div id="next-day-draft"></div><p>Saved availability and breaks take precedence. Preview shows available minutes, gaps, requested work and tasks kept unchanged.</p><button id="next-day-preview" class="primary">Preview workload and times</button>`;
  const root=body.querySelector('#next-day-draft');selection=mountSelection({root,report,storage:localStorage,key,escape,prefix:'next-day',attribute:'data-next-day-task',loadedDraft:draft,loadError:error,...(outcomes&&!error?{rowDetails:outcomeSelectionHTML,changeMessage:'The task, outcome, step, project or current attempt changed. Compare the retained and current sources before keeping this selection.'}:{})});
  root.dataset.readingContext=(outcomes?'outcomes:':'day:')+report.date;
  root.dataset.readingDisabled=String(!!error);
  const locked=!!pending||!!error;root.inert=!!pending;body.querySelector('#next-day-preview').disabled=locked;body.querySelector('#next-day-load').disabled=locked;
  root.addEventListener('selection-reset',run(()=>show()));
  body.querySelector('#next-day-reload').onclick=run(async()=>{if(!error)selection.save();await show();});
  body.querySelector('#next-day-load').onclick=run(async()=>{selection.save();await show(body.querySelector('#next-day-date').value);});
  const preview=async input=>{
   selection.save();selection.setPending(input);pending=input;
   body.querySelector('#next-day-pending').hidden=false;root.inert=true;body.querySelector('#next-day-preview').disabled=true;body.querySelector('#next-day-load').disabled=true;
   const p=await api('/api/next-day/preview',input);await showReview(p);
  };
  body.querySelector('#next-day-preview').onclick=run(async()=>{const selected=selection.selected(),d=selection.read();await preview({requestId:crypto.randomUUID(),date:report.date,today:report.today,timezone:report.timezone,selected,start:d.start,end:d.end,gap:d.gap,...(outcomes?{outcomeMode:true}:{})});});
  body.querySelector('#next-day-resume').onclick=run(async()=>{if(pending)await preview(pending);});
  body.querySelector('#next-day-edit').onclick=run(async()=>{const d=readSelection(localStorage,key);if(d){delete d.pending;localStorage.setItem(key,JSON.stringify(d));}await show();});
  open();return report;
 }
 return {show};
}
