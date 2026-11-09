import {focusSnapshot} from './focus-review.mjs';

// Non-locking: callers may already hold the vault queue. Reading a review never
// reconciles history or treats a proposal's unsaved rows as completed effects.
export async function checkinReview(planner,start,end=start,{history,tasks,execution}={}){
 const state=await planner.checkins?.read();
 history??=await planner.dailyFocus?.history.read();tasks??=await planner.vault.tasks();execution??=await planner.execution();
 const proposals=await planner.store.list('proposals'),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 const entries=(state?.entries||[]).filter(e=>e.date>=start&&e.date<=end).map(e=>{
  const adjustments=proposals.filter(p=>p.kind==='day_replan'&&p.checkin?.id===e.id).map(p=>{
   const receipts=(history?.events||[]).filter(r=>r.decision?.proposalId===p.id&&r.decision.kind==='day_replan'&&['aurora_save','recovered_save'].includes(r.source)&&new Date(r.recordedAt)<=planner.now());
   return {id:p.id,status:p.status,created:p.created,recorded:receipts.map(r=>({id:r.id,taskId:r.taskId,before:focusSnapshot(r.before),after:focusSnapshot(r.after),source:r.source,recordedAt:r.recordedAt})),unrecorded:(p.changes||[]).filter(c=>!receipts.some(r=>r.taskId===c.before.id)).length};
  });
  const ids=[...new Set([...e.selected.map(s=>s.taskId),...adjustments.flatMap(a=>a.recorded.map(r=>r.taskId))])];
  const rows=ids.map(taskId=>{const selected=e.selected.find(s=>s.taskId===taskId),matches=tasks.filter(t=>t.id===taskId),current=matches.length===1?focusSnapshot(matches[0]):null;
   return {taskId,original:selected?.planned||null,intention:selected?.task||null,current,issue:matches.length>1?'Duplicate task ID; current state cannot be linked.':!current?'Task is missing from active notes.':current.scheduleError?'Task metadata needs repair.':null,execution:current&&!current.scheduleError?execution.filter(x=>x.taskId===taskId):[]};
  });
  return {id:e.id,date:e.date,timezone:e.timezone,timezoneMismatch:e.timezone!==timezone,kind:e.kind,note:e.note,start:e.start,end:e.end,status:e.status,created:e.created,reviewedAt:e.reviewedAt,sequence:e.sequence,adjustments,rows};
 });
 return {start,end,timezone,entries,warnings:history?.pending?['A task save is awaiting history reconciliation. Only recorded note-save receipts appear below.']:[]};
}
