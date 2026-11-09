import {remainingContext,mountRemainingFit} from './remaining-day.js';
import {followThroughDraftError,followThroughSelectionHTML} from './plan-follow-through.js';
import {mountSelection,readSelection} from './planning-selection.js';
export function createRemainder({api,escape,body,open,run,showReview}){
 let keyPromise;
 async function show(checkin,follow){
  if(checkin?.id){const current=await api('/api/check-ins');checkin=current.entries.find(e=>e.id===checkin.id);if(!checkin)throw Error('This check-in is no longer available.');}
  keyPromise??=api('/api/bootstrap').then(b=>'aurora-remainder-draft:'+b.vault).catch(e=>{keyPromise=null;throw e;});const key=(await keyPromise)+(checkin?.id?':'+checkin.id:follow?':follow:'+follow.proposalId+':'+follow.taskId:'');
  let draft,error;try{draft=readSelection(localStorage,key);}catch(e){error=e.message;}
  if(follow&&!error)error=followThroughDraftError(draft,follow);
  let followRow=null;
  if(follow)try{const r=await api('/api/plan-follow-through?proposalId='+encodeURIComponent(follow.proposalId));followRow=r.rows.find(r=>r.taskId===follow.taskId);if(!followRow)throw Error('This selection is no longer available.');}catch(e){
   if(error||!draft?.pending)throw e;
   body.innerHTML='<h2>Recover follow-through adjustment</h2><p>'+escape(e.message)+'</p><p>The exact preview request is kept. Reopen it to inspect saved progress.</p><button id="replan-resume">Reopen previous preview</button><button data-follow-through>Open follow-through</button>';open();body.querySelector('#replan-resume').onclick=run(async()=>showReview(await api('/api/replan/preview',draft.pending)));return;
  }
  const data=await api('/api/replan'),briefing=await api('/api/briefing');
  const followSource=followRow?{proposalId:follow.proposalId,taskId:follow.taskId,revision:followRow.revision,snapshot:followRow}:null;
  if(follow&&!draft&&!error){const source=follow.snapshot?follow:followSource;draft={version:1,date:data.date,timezone:data.timezone,start:'00:00',end:'18:00',gap:10,rows:[{taskId:follow.taskId,text:source.snapshot.text,task:source.snapshot.current,contextRevision:source.revision,source,selected:true}]};localStorage.setItem(key,JSON.stringify(draft));}

  if(!draft&&!error&&checkin)draft={version:1,date:checkin.date,timezone:checkin.timezone,start:checkin.start,end:checkin.end,gap:checkin.gap,rows:checkin.selected.map(s=>({...s,text:s.task.text,selected:true})),expanded:true};
  if(!draft&&!error){let hours={end:'18:00',gap:10};try{hours={...hours,...JSON.parse(localStorage.getItem('aurora-planner-hours')||'{}')};}catch{}
   if(briefing.day.availability){hours.end=briefing.day.availability.at(-1)?.[1]||'23:59';hours.gap=briefing.day.breakMinutes;}
   draft={version:1,date:data.date,timezone:data.timezone,start:'00:00',end:hours.end,gap:hours.gap,rows:data.tasks.map(t=>({taskId:t.id||t.path+':'+t.line,text:t.text,contextRevision:t.contextRevision,task:t,selected:!t.locked}))};
  }
  let pending=draft?.pending||null;
  body.innerHTML=`<h2>${follow?'Adjust this follow-through task':'Replan the rest of today'}</h2>${follow?'<p>This adjustment has its own saved draft. Only the reviewed task is selected; other planning drafts are kept.</p><button data-follow-through="'+escape(follow.proposalId)+'">Compare the plan again</button>':''}${checkin?'<p><strong>Check-in:</strong> '+escape(checkin.note)+'</p><p>Keep this adjustment within '+escape(checkin.start+'–'+checkin.end)+'. Original intentions remain in the check-in.</p>':''}<p>Choose tasks and hours, then check what fits around fixed commitments. Review the proposed times before saving. Dates, deadlines, reminders and estimates stay unchanged.</p>${remainingContext(data,briefing,escape)}<button id="replan-reload">Reload current details</button><div id="replan-pending" ${pending?'':'hidden'}><p>A previous preview belongs to this draft. Reopen it to inspect its saved progress.</p><button id="replan-resume">Reopen previous preview</button><button id="replan-edit">Edit draft for a new preview</button></div><div class="remaining-day-layout"><div id="replan-selection"></div><div id="remaining-day-assessment"></div></div><p>Saved availability and breaks take precedence. Unplaced selected tasks remain on today’s list without a reserved time; review the changes before saving.</p><button id="replan-preview" class="primary">Preview new times</button>`;
  const rows=follow?[{taskId:follow.taskId,text:followRow.text,task:followRow.current,contextRevision:followRow.revision,source:followSource,issue:followRow.adjustmentIssue,execution:followRow.execution}]:data.tasks.map(t=>({taskId:t.id||t.path+':'+t.line,text:t.text,task:t,contextRevision:t.contextRevision,issue:t.issue,execution:t.execution}));
  const root=body.querySelector('#replan-selection'),selection=mountSelection({root,report:{...data,rows},storage:localStorage,key,escape,prefix:'replan',attribute:'data-replan-task',loadedDraft:draft,loadError:error,...(follow&&!error?{rowDetails:followThroughSelectionHTML,changeMessage:'The plan, outcome, project, task or attempt changed. Compare earlier and current context before keeping this adjustment.'}:{})});
  root.prepend(root.querySelector('.focus-actions'));
  if(briefing.day.availability)root.querySelector('#replan-gap').disabled=true;
  root.inert=!!pending;body.querySelector('#replan-preview').disabled=!!pending||!!error;
  root.addEventListener('selection-reset',run(()=>show(checkin,follow?{proposalId:follow.proposalId,taskId:follow.taskId}:undefined)));
  body.querySelector('#replan-reload').onclick=run(async()=>{if(!error)selection.save();await show(checkin,follow);});
  const preview=async input=>{selection.save();selection.setPending(input);pending=input;body.querySelector('#replan-pending').hidden=false;root.inert=true;body.querySelector('#replan-preview').disabled=true;await showReview(await api('/api/replan/preview',input));};
  const input=options=>{const chosen=selection.selected(options),d=selection.read();return {date:d.date,timezone:d.timezone,selected:chosen.map(s=>data.tasks.find(t=>t.id===s.taskId)),start:d.start,end:d.end,gap:d.gap,...(checkin?{checkin:{id:checkin.id,revision:checkin.revision}}:{}),...(follow?{followThrough:{proposalId:follow.proposalId,taskId:follow.taskId,revision:d.rows[0].source.revision}}:{})};};
  const fit=mountRemainingFit({host:body.querySelector('#remaining-day-assessment'),selectionRoot:root,input,api,escape,run,pending,error});
  body.querySelector('#replan-preview').onclick=run(async()=>preview({requestId:crypto.randomUUID(),...input()}));
  body.querySelector('#replan-resume').onclick=run(async()=>{if(pending)await preview(pending);});
  body.querySelector('#replan-edit').onclick=run(async()=>{const d=readSelection(localStorage,key);if(d){delete d.pending;localStorage.setItem(key,JSON.stringify(d));}await show(checkin,follow);});
  open();if(!pending&&!error)await fit.assess();return data;
 }
 return {show};
}
