import {AppError,sha} from './vault.mjs';
import {localDay,minutes,taskKey} from '../mobile/web/planner-core.js';
import {taskGraph,taskRef} from '../mobile/web/task-links.js';
import {focusSnapshot} from './focus-review.mjs';
export async function remainderCandidates(planner){
 const now=planner.now(),date=localDay(now),at=now.getHours()*60+now.getMinutes(),tasks=await planner.vault.tasks(),graph=taskGraph(tasks),execution=await planner.execution();
 return {date,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,tasks:tasks.filter(t=>!t.done&&!t.scheduleError&&t.planDate===date).map(t=>{
  const dependencyReasons=graph.states.get(taskRef(t))?.reasons||[],links=execution.filter(e=>e.taskId===t.id);
  const issue=!t.id||tasks.filter(x=>x.id===t.id).length!==1?'Repair the task identity first.':dependencyReasons.length?dependencyReasons.join('; '):t.startTime&&minutes(t.startTime)<=at&&minutes(t.startTime)+t.duration>at?'Its reserved block is in progress.':links.some(e=>e.attention)?'Review the current execution decision first.':links.some(e=>['running','planning','queued'].includes(e.status))?'A linked attempt is active.':null;
  return {...t,dependencyReasons,execution:links,locked:!!issue,issue,contextRevision:sha(JSON.stringify([focusSnapshot(t),issue,dependencyReasons,links.map(e=>[e.id,e.executionRevision]).sort()]))};
 })};
}
export async function verifyRemainder(planner,p){
 if(p.estimateFollowThrough)await planner.estimateFollowThrough.source(p.estimateFollowThrough);
 if(p.followThrough)await planner.followThrough.source(p.followThrough,{adjust:true});
 if(p.checkin)await planner.checkins.source(p.checkin);
 const r=await remainderCandidates(planner);
 if(r.date!==p.date||r.timezone!==p.timezone)throw new AppError('The day or timezone changed. Reload the remaining-day draft.',409);
 for(const c of p.changes.filter(c=>!p.saved.includes(c.before.path))){const row=r.tasks.find(t=>taskKey(t)===taskKey(c.before));if(!row||row.locked||row.contextRevision!==c.planContext)throw new AppError('A selected task or current attempt changed, or a task started. Reload the remaining-day draft.',409);}
}
export async function previewRemainder(planner,input,prepare,fingerprint){
 if(input.requestId===undefined)return prepare(input);
 const {requestId}=input;if(typeof requestId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))throw new AppError('Use a valid planning request.');
 const requestHash=sha(JSON.stringify(input));
 const previous=async()=>{let p;try{p=await planner.store.get('proposals',requestId);}catch(e){if(e.status===404)return null;throw e;}if(p.kind!=='day_replan'||p.requestHash!==requestHash)throw new AppError('This request was already used for another preview.',409);return planner.public(p);};
 const prior=await previous();if(prior)return prior;
 const r=await remainderCandidates(planner);if(input.date!==r.date||input.timezone!==r.timezone)throw new AppError('The day or timezone changed. Reload the remaining-day draft.',409);
 const p={...await prepare(input),id:requestId,requestHash,status:'pending',created:new Date().toISOString()};
 return planner.vault.exclusive(async()=>{const existing=await previous();if(existing)return existing;await verifyRemainder(planner,p);if(fingerprint(await planner.vault.list())!==p.contextHash)throw new AppError('Tasks or classes changed while preparing the preview.',409);
  try{return planner.public(await planner.store.put('proposals',p));}catch(e){if(e.status)throw e;throw new AppError('The preview may already be saved. Reopen this draft to retry the same request.',503);}
 });
}
