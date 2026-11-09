import {guardPlanningDraft} from './planning-draft-guard.js';
import {mountSelection,readSelection} from './planning-selection.js';
import {estimateFollowContext} from './estimate-follow-through.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function estimateAdjustmentDraftError(d,ref){
 if(!d)return null;
 const source=d.rows?.[0]?.source,s=source?.snapshot;
 const invalid='The saved estimate adjustment cannot be read. Your draft is kept; reset it explicitly to start again.';
 if(d.rows.length!==1||d.rows[0].taskId!==ref.taskId||source?.reviewId!==ref.reviewId||source?.taskId!==ref.taskId||typeof source.revision!=='string'||s?.reviewId!==ref.reviewId||s?.taskId!==ref.taskId||typeof s.reason!=='string'||typeof s.originalSourceText!=='string'||s.currentSourceText!==null&&typeof s.currentSourceText!=='string'||!Array.isArray(s.conflicts)||s.conflicts.some(c=>!c||['kind','title','time'].some(k=>typeof c[k]!=='string'))||!Array.isArray(s.warnings)||s.warnings.some(w=>typeof w!=='string')||[s.before,s.after].some(t=>!t||typeof t.text!=='string'||!Number.isInteger(t.duration))||s.current!==null&&(!s.current||typeof s.current.text!=='string'))return invalid;
 if(d.pending&&(!uuid(d.pending.requestId)||d.pending.estimateFollowThrough?.reviewId!==ref.reviewId||d.pending.estimateFollowThrough?.taskId!==ref.taskId||d.pending.estimateFollowThrough?.revision!==source.revision||d.pending.selected?.length!==1||d.pending.selected[0]?.id!==ref.taskId||d.pending.followThrough||d.pending.checkin))return invalid;
 return null;
}
export function createEstimateAdjustment({api,escape:e,body,open,run,showReview}){
 async function show(ref){
  if(!uuid(ref?.reviewId)||!uuid(ref?.taskId))throw Error('Choose an estimate decision first.');
  const boot=await api('/api/bootstrap'),key='aurora-estimate-adjustment:'+boot.vault+':'+ref.reviewId+':'+ref.taskId;
  let draft,error,row;
  try{draft=readSelection(localStorage,key);error=estimateAdjustmentDraftError(draft,ref);}catch(x){error=x.message;}
  if(error){body.innerHTML='<h2>Estimate adjustment draft needs attention</h2><p>'+e(error)+'</p><button id="estimate-adjust-reset">Discard unreadable adjustment draft</button><button data-estimate-follow="'+e(ref.reviewId)+'">Back to comparison</button>';open();body.querySelector('#estimate-adjust-reset').onclick=run(async()=>{if(confirm('Discard this unreadable adjustment draft? Saved reviews and task notes are kept.')){localStorage.removeItem(key);await show({reviewId:ref.reviewId,taskId:ref.taskId});}});return;}
  // Resolve an exact durable preview before requiring today's source to remain available.
  if(draft?.pending){body.innerHTML='<h2>Recover estimate adjustment</h2><p>Your exact preview request is retained. Reopen it to inspect saved progress, even if the task or day has changed.</p><button id="estimate-adjust-resume">Reopen saved preview</button><button id="estimate-adjust-edit">Edit draft for a new preview</button><button data-estimate-follow="'+e(ref.reviewId)+'">Back to comparison</button>';open();body.querySelector('#estimate-adjust-resume').onclick=run(()=>api('/api/replan/preview',draft.pending).then(showReview));body.querySelector('#estimate-adjust-edit').onclick=run(async()=>{delete draft.pending;localStorage.setItem(key,JSON.stringify(draft));await show(ref);});return;}
  const report=await api('/api/estimate-follow-through?reviewId='+encodeURIComponent(ref.reviewId));row=report.rows.find(r=>r.taskId===ref.taskId);if(!row)throw Error('This saved estimate decision is unavailable. Your draft has been kept.');
  const data=await api('/api/replan'),briefing=await api('/api/briefing'),source={reviewId:ref.reviewId,taskId:ref.taskId,revision:row.revision,snapshot:row};
  if(!draft){const initial=ref.snapshot?ref:source;draft={version:1,date:data.date,timezone:data.timezone,start:'00:00',end:briefing.day.availability?.at(-1)?.[1]||'18:00',gap:briefing.day.breakMinutes??10,rows:[{taskId:ref.taskId,text:initial.snapshot.text,task:initial.snapshot.current,contextRevision:initial.revision,source:initial,selected:true}]};localStorage.setItem(key,JSON.stringify(draft));}
  body.innerHTML='<h2>Adjust time after an estimate review</h2><p>This draft only moves the selected task within today. Its estimate, wording, deadlines and reminders stay unchanged. Classes, calendar events and other tasks remain fixed.</p><button data-estimate-follow="'+e(ref.reviewId)+'">Compare the estimate again</button><button id="estimate-adjust-reload">Reload current details</button><div id="estimate-adjust-selection"></div><p>If it does not fit, the preview leaves the task on today’s list without a reserved time. Saving the plan does not update a linked Google event.</p><button id="estimate-adjust-preview" class="primary">Preview new time</button>';
  const root=body.querySelector('#estimate-adjust-selection'),selection=mountSelection({root,report:{...data,rows:[{taskId:ref.taskId,text:row.text,task:row.current,contextRevision:row.revision,source,issue:row.adjustmentIssue,execution:row.execution}]},storage:localStorage,key,escape:e,prefix:'estimate-adjust',attribute:'data-estimate-adjust-task',loadedDraft:draft,rowDetails:(r,s)=>'<details open><summary>Current estimate comparison</summary>'+estimateFollowContext(r.source.snapshot,e)+'</details>'+(s.source.revision!==r.source.revision?'<div data-selection-source-comparison><details><summary>Comparison saved with this draft</summary>'+estimateFollowContext(s.source.snapshot,e)+'</details></div>':''),changeMessage:'The estimate, sessions, task or schedule changed. Compare the original and current context before keeping this selection.'});
  guardPlanningDraft(body,root,()=>selection.save());
  root.querySelector('#estimate-adjust-start').closest('label').hidden=true;if(briefing.day.availability)root.querySelector('#estimate-adjust-gap').disabled=true;
  root.addEventListener('selection-reset',run(()=>show({reviewId:ref.reviewId,taskId:ref.taskId})));
  body.querySelector('#estimate-adjust-reload').onclick=run(async()=>{selection.save();await show(ref);});
  body.querySelector('#estimate-adjust-preview').onclick=run(async()=>{selection.selected();const d=selection.read(),input={requestId:crypto.randomUUID(),date:data.date,timezone:data.timezone,selected:[data.tasks.find(t=>t.id===ref.taskId)],start:'00:00',end:d.end,gap:d.gap,estimateFollowThrough:{reviewId:ref.reviewId,taskId:ref.taskId,revision:d.rows[0].source.revision}};selection.setPending(input);await show(ref);await showReview(await api('/api/replan/preview',input));});
  open();return row;
 }
 return {show};
}
