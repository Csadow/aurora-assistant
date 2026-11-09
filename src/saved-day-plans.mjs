import {focusSnapshot,focusHash} from './focus-review.mjs';
import {localDay,minutes} from '../mobile/web/planner-core.js';
import {validDate} from './task-meta.mjs';

// Only recorded note saves establish a plan. A preview or an unsaved proposal row
// is not evidence that a task was scheduled, even when other notes were committed.
export function savedPlanEvents(history,date,now){
 return (history?.events||[]).filter(e=>e.decision?.kind==='future_schedule'&&e.decision.proposalId&&e.after?.planDate===date&&['aurora_save','recovered_save'].includes(e.source)&&new Date(e.recordedAt)<=now);
}
export function planChoice(e){return e?{id:e.id,proposalId:e.decision.proposalId,recordedAt:e.recordedAt,source:e.source,task:focusSnapshot(e.after)}:null;}
export async function savedDayPlans(planner,date,history,tasks){
 const now=planner.now(),today=localDay(now),events=savedPlanEvents(history,date,now),execution=await planner.execution(),groups=new Map();
 for(const e of events){if(!groups.has(e.decision.proposalId))groups.set(e.decision.proposalId,new Map());groups.get(e.decision.proposalId).set(e.taskId,e);}
 const plans=[];
 for(const [id,entries] of groups){
  let proposal=null;try{proposal=await planner.store.get('proposals',id);}catch(e){if(e.status!==404)throw e;}
  const rows=[...entries].map(([taskId,e])=>{const matches=tasks.filter(t=>t.id===taskId),task=matches.length===1?focusSnapshot(matches[0]):null,original=focusSnapshot(e.after),links=matches.length===1?execution.filter(x=>x.taskId===taskId):[];
   const issue=matches.length>1?'Duplicate task ID.':!task?'Task no longer in active notes.':task.scheduleError?'Task metadata needs repair.':null;
   const elapsed=!!task?.startTime&&task.planDate===today&&minutes(task.startTime)+task.duration<=now.getHours()*60+now.getMinutes();
   const outcomeSource=proposal?.outcomeSources?.find(s=>s.taskId===taskId);
   return {taskId,original,current:task,changed:focusHash(original)!==focusHash(task),issue,elapsed,execution:links,source:e.source,recordedAt:e.recordedAt,...(outcomeSource?{outcomeSource}:{})};
  });
  plans.push({id,date,origin:proposal?.origin||null,workloadFrom:proposal?.workloadFrom||null,recordedAt:rows.at(-1).recordedAt,rows,recordedMinutes:rows.reduce((n,r)=>n+r.original.duration,0),previewCapacity:proposal?.targetDays?.find(d=>d.date===date)?.capacity||null,unrecorded:proposal?proposal.changes.filter(c=>c.after.planDate===date&&!entries.has(c.before.id)).length:null,status:proposal?.status||'unavailable'});
 }
 const earlier=[...new Set((history?.events||[]).filter(e=>e.decision?.kind==='future_schedule'&&['aurora_save','recovered_save'].includes(e.source)&&new Date(e.recordedAt)<=now&&validDate(e.after?.planDate)&&e.after.planDate<today).map(e=>e.after.planDate))].sort().reverse().slice(0,7);
 return {date,today,plans:plans.reverse(),earlier,warnings:history?.pending?['A task save is awaiting history reconciliation. Only recorded note saves appear here.']:[]};
}
