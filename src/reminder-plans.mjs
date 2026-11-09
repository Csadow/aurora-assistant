import {AppError,sha} from './vault.mjs';
import {localDay} from '../mobile/web/planner-core.js';
import {buildWorkloadRemaining} from './workload-remaining.mjs';
import {workloadPlanningSource,assessWorkloadNext} from './workload-next.mjs';
import {weekCapacityReport} from './week-capacity.mjs';
import {focusHash} from './focus-review.mjs';
import {validDate} from './task-meta.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const hash=v=>sha(JSON.stringify(v)),zone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
const kind='workload-reminder-decisions';
export function reminderDecision(v){if(!v||!uuid(v.id)||typeof v.revision!=='string'||!/^[0-9a-f]{64}$/.test(v.revision))throw new AppError('Choose a valid reviewed reminder decision.');return {id:v.id,revision:v.revision};}
export function validateReminderDecision(d){
 if(!d||d.version!==1||!uuid(d.id)||!uuid(d.reminderId)||!uuid(d.proposalId)||!uuid(d.taskId)||d.task?.id!==d.taskId||typeof d.task?.text!=='string'||typeof d.task?.done!=='boolean'||!validDate(d.reviewedOn)||typeof d.timezone!=='string'||!Number.isFinite(Date.parse(d.created))||typeof d.contextRevision!=='string'||typeof d.requestHash!=='string'||!d.workloadFrom||d.workloadFrom.proposalId!==d.proposalId||typeof d.workloadFrom.revision!=='string'||d.step!==null&&(!d.step||typeof d.step.text!=='string'||!Number.isInteger(d.step.sequence)))throw new AppError('A saved reminder decision is unreadable. Keep its draft and restore the record.',503);
 return {...d,revision:hash(d)};
}
export class ReminderPlans {
 constructor({planner}){this.planner=planner;}
 async decision(id){if(!uuid(id))throw new AppError('Choose a valid reminder decision.');return validateReminderDecision(await this.planner.store.get(kind,id));}
 report(input={}){return this.planner.vault.exclusive(async()=>this.build({...input,...(!input.reminderId&&input.decisionId?{reminderId:(await this.decision(input.decisionId)).reminderId}:{})}));}
 async build({reminderId,decisionId}={}, {committing=null}={}){
  if(!uuid(reminderId)||decisionId!==undefined&&!uuid(decisionId))throw new AppError('Choose a saved workload reminder.');
  const p=this.planner,entry=(await p.workloadRevisits.read()).entries.find(e=>e.id===reminderId);if(!entry)throw new AppError('This saved workload reminder is missing. Its draft is kept.',404);
  const today=localDay(p.now()),warnings=[],r=await buildWorkloadRemaining(p,{proposalId:entry.proposalId,date:today},{committing});let steps=null,source=null;
  try{steps=await p.firstSteps.read();}catch(e){warnings.push(e.message);}
  try{source=await workloadPlanningSource(p,entry.proposalId);}catch(e){warnings.push(e.message);}
  const rows=entry.source.tasks.map(saved=>{
   const row=r.rows.find(t=>t.taskId===saved.taskId),card=steps?.cards[saved.taskId]||null;
   const step=card?{text:card.text,mode:card.mode,sequence:card.sequence,date:card.context.date,updated:card.updated,changed:focusHash(card.context.task)!==focusHash(row?.current)}:null;
   const canReview=entry.status==='open'&&entry.targetDate<=today&&!!source&&!!steps&&!!row?.canSelect;
   const contextRevision=hash({reminder:hash(entry),source:source?.revision||null,today,timezone:zone(),task:row?.current||null,card,detail:row?.detail||null,canReview});
   return {taskId:saved.taskId,text:row?.text||saved.text,task:row?.current||null,state:row?.state||'unknown',detail:row?.detail||'Task is absent from the readable source; its current status is unknown.',step,canReview,contextRevision};
  });
  let history=null,proposals=null,decisions=null;try{history=await p.dailyFocus.history.read();}catch(e){warnings.push(e.message);}try{proposals=await p.store.list('proposals');}catch(e){warnings.push(e.message);}
  try{decisions=(await p.store.list(kind)).map(validateReminderDecision).filter(d=>d.reminderId===reminderId);if(decisionId&&!decisions.some(d=>d.id===decisionId))throw new AppError('The selected reminder decision is missing. Keep its draft and restore its record.',503);}catch(e){if(decisionId)throw e;warnings.push(e.message);}
  const outcomes=(decisions||[]).map(d=>{
   const current=rows.find(r=>r.taskId===d.taskId),plans=proposals?.filter(v=>v.kind==='future_schedule'&&v.origin==='workload-next'&&v.workloadFrom?.proposalId===d.proposalId&&v.reminderDecision?.id===d.id&&v.reminderDecision.revision===d.revision)||[];
   const receipts=history?.events.filter(e=>plans.some(v=>v.id===e.decision?.proposalId)&&e.decision?.kind==='future_schedule'&&e.taskId===d.taskId&&e.after?.id===d.taskId&&['aurora_save','recovered_save'].includes(e.source)&&Number.isFinite(Date.parse(e.recordedAt))&&new Date(e.recordedAt)<=p.now())||[];
   const pending=!!history?.pending&&plans.some(v=>v.id===history.pending.decision?.proposalId),latest=receipts.toSorted((a,b)=>a.recordedAt.localeCompare(b.recordedAt)).at(-1)||null;
   const scheduled=!!latest?.after.startTime&&current?.task?.planDate===latest.after.planDate&&current.task?.startTime===latest.after.startTime&&current.task?.duration===latest.after.duration;
   const state=current?.task?.done?'completed':!history||!proposals||pending||!current?.task?'unknown':scheduled?'scheduled':latest?'changed':plans.some(v=>v.status==='pending')?'preview':'reviewed';
   return {...d,state,reservationActive:current?.state==='reserved',canPlan:!!decisions&&!!current?.canReview&&current.contextRevision===d.contextRevision,changed:current?.contextRevision!==d.contextRevision,current:current?.task||null,plans:plans.map(v=>({id:v.id,title:v.title,status:v.status,date:v.targetDate,recorded:history?receipts.filter(e=>e.decision.proposalId===v.id).length:null,pending:!!history?.pending&&history.pending.decision?.proposalId===v.id})),latest:latest?{recordedAt:latest.recordedAt,after:latest.after,source:latest.source}:null};
  });
  return {reminder:p.workloadRevisits.public(entry),today,timezone:zone(),source,rows:rows.map(r=>({...r,canReview:r.canReview&&!!decisions})),decisions:outcomes,decisionId:decisionId||null,warnings:[...new Set([...r.warnings,...warnings])],historyAvailable:!!history,proposalsAvailable:!!proposals};
 }
 review(input){return this.planner.vault.exclusive(async()=>{
  const {requestId,reminderId,taskId,contextRevision,today,timezone,acknowledge}=input;
  if(!uuid(requestId)||!uuid(reminderId)||!uuid(taskId)||typeof contextRevision!=='string'||acknowledge!==true)throw new AppError('Choose one task and explicitly review it.');
  const requestHash=hash(input);let prior;try{prior=await this.decision(requestId);}catch(e){if(e.status!==404)throw e;}
  if(prior){if(prior.requestHash!==requestHash)throw new AppError('This request was used for another reminder review.',409);return prior;}
  const verify=async()=>{const r=await this.build({reminderId}),row=r.rows.find(r=>r.taskId===taskId);if(r.today!==today||r.timezone!==timezone||!row?.canReview||row.contextRevision!==contextRevision)throw new AppError('The reminder, task, first step or readiness changed. Refresh and review the task again.',409);return {r,row};};
  const {r,row}=await verify(),d={version:1,id:requestId,requestHash,reminderId,proposalId:r.reminder.proposalId,review:r.reminder.review,taskId,task:row.task,step:row.step,contextRevision,reviewedOn:today,timezone,created:this.planner.now().toISOString(),workloadFrom:{proposalId:r.source.proposalId,revision:r.source.revision}};
  try{return validateReminderDecision(await this.planner.store.put(kind,d,{beforeCommit:verify}));}catch(e){if(e.status)throw e;throw new AppError('The review save could not be confirmed. Retry the same request from its draft.',503);}
 });}
 // Non-locking: next-day preview and commit verification already own the vault lock.
 async verify(ref,selected,from,committing=null){
  ref=reminderDecision(ref);const d=await this.decision(ref.id);
  if(ref.revision!==d.revision||!Array.isArray(selected)||selected.length!==1||selected[0]?.taskId!==d.taskId||from?.proposalId!==d.workloadFrom.proposalId||from?.revision!==d.workloadFrom.revision)throw new AppError('Plan only the one task from this reviewed reminder.',409);
  const r=await this.build({reminderId:d.reminderId,decisionId:d.id},{committing}),current=r.decisions.find(x=>x.id===d.id);if(!current?.canPlan)throw new AppError('This reminder review is no longer current. Keep the draft and review current details before another plan.',409);return d;
 }
 async assess(input){
  const d=await this.decision(input.decisionId),ref={id:d.id,revision:d.revision};await this.verify(ref,[{taskId:d.taskId}],d.workloadFrom);
  const week=await weekCapacityReport(this.planner,input.date),row=week.rows.find(r=>r.taskId===d.taskId);if(!row)throw new AppError('The reviewed task is unavailable.',409);
  const request={...input,today:week.today,timezone:week.timezone,selected:[{taskId:d.taskId,contextRevision:row.contextRevision}],workloadFrom:d.workloadFrom};
  const result=await assessWorkloadNext(this.planner,request);await this.verify(ref,request.selected,d.workloadFrom);
  for(const day of result.days)if(day.preview)day.preview.reminderDecision=ref;return {...result,reminderDecision:ref};
 }
}
