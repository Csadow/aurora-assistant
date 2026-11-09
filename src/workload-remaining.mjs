import {AppError,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {sourceCandidate} from './task-details.mjs';
import {focusSnapshot,focusHash} from './focus-review.mjs';
import {localDay,minutes} from '../mobile/web/planner-core.js';
import {buildWorkloadFollow} from './workload-follow.mjs';
import {weekCapacityReport} from './week-capacity.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const snapshotOK=t=>t&&uuid(t.id)&&typeof t.text==='string'&&typeof t.path==='string'&&typeof t.done==='boolean'&&Number.isInteger(t.duration)&&t.duration>=5&&t.duration<=720&&(!t.planDate||validDate(t.planDate))&&(!t.startTime||/^([01]\d|2[0-3]):[0-5]\d$/.test(t.startTime));
const visible=(v,now)=>!Number.isFinite(Date.parse(v.created))||new Date(v.created)<=now;

// A consolidated view, not a new schedule. Never reconcile history, choose tasks,
// refresh Calendar, replace drafts or retry a partial save while reading it.
export function workloadRemaining(planner,input={}){
 return planner.vault.exclusive(()=>buildWorkloadRemaining(planner,input));
}
export async function buildWorkloadRemaining(p,{proposalId,date=localDay(p.now()),taskId,offset=0}={}, {committing=null}={}){
 if(!uuid(proposalId)||!validDate(date)||taskId!==undefined&&!uuid(taskId)||!Number.isInteger(offset)||offset<0||offset>100000)throw new AppError('Choose a valid original workload and review date.');
 const now=p.now(),today=localDay(now),warnings=[],sources={original:true,proposals:true,history:true,tasks:true,readiness:true};
 const read=async(key,fn)=>{try{return await fn();}catch(e){sources[key]=false;warnings.push(key+': '+e.message);return null;}};
 const report=await read('original',()=>buildWorkloadFollow(p,{proposalId}));
 const original=report?.plans[0]&&!report.plans[0].error?report.plans[0]:null;
 if(!original){sources.original=false;warnings.push(report?.plans[0]?.error||'The original shortlist is unavailable. Known follow-up tasks and receipts remain below; full membership is unknown.');}
 const proposals=await read('proposals',()=>p.store.list('proposals'));
 const history=await read('history',async()=>{const h=await p.dailyFocus.history.read();if(!Array.isArray(h?.events))throw Error('Recorded task history is unavailable.');return h;});
 const tasks=await read('tasks',async()=>(await p.vault.tasks()).map(sourceCandidate));
 const week=await read('readiness',()=>weekCapacityReport(p,date));
 const followups=(proposals||[]).filter(v=>v.kind==='future_schedule'&&v.origin==='workload-next'&&v.workloadFrom?.proposalId===proposalId&&visible(v,now));
 const known=new Map((original?.rows||[]).map(r=>[r.taskId,r.retained])),valid=[],plans=[];
 for(const v of followups){
  const good=uuid(v.id)&&validDate(v.targetDate)&&Number.isFinite(Date.parse(v.created))&&['pending','accepted','dismissed'].includes(v.status)&&Array.isArray(v.changes)&&Array.isArray(v.held)&&v.changes.every(c=>snapshotOK(c?.before)&&snapshotOK(c?.after)&&c.before.id===c.after.id)&&v.held.every(h=>snapshotOK(h?.task)&&h.task.id===h.taskId);
  const ids=good?[...v.changes.map(c=>c.before.id),...v.held.map(h=>h.taskId)]:[];
  const error=!good||new Set(ids).size!==ids.length?'This follow-up record is unreadable; its membership and save counts are unknown.':null;
  plans.push({id:v.id,date:v.targetDate,title:typeof v.title==='string'?v.title:'Follow-up plan',status:v.status,error,recorded:null,proposed:good?v.changes.length:null,held:good?v.held.length:null});
  if(error){warnings.push(error);continue;}
  valid.push(v);
  for(const t of [...v.changes.map(c=>c.before),...v.held.map(h=>h.task)]){
   if(original&&!known.has(t.id)){warnings.push('A follow-up contains a task outside the retained original membership. Review its original record.');continue;}
   if(!known.has(t.id))known.set(t.id,focusSnapshot(t));
  }
 }
 const related=new Set([proposalId,...followups.map(v=>v.id)]),receipts=[];
 for(const [index,event] of (history?.events||[]).entries()){
  if(event.decision?.kind!=='future_schedule'||!related.has(event.decision.proposalId)||!['aurora_save','recovered_save'].includes(event.source)||!Number.isFinite(Date.parse(event.recordedAt))||new Date(event.recordedAt)>now)continue;
  if(!snapshotOK(event.after)||event.taskId!==event.after.id){warnings.push('A recorded placement is unreadable and is excluded from receipt counts.');continue;}
  if(original&&!known.has(event.taskId)){warnings.push('A receipt refers to a task outside the retained original membership.');continue;}
  if(!known.has(event.taskId))known.set(event.taskId,focusSnapshot(event.after));
  receipts.push({id:event.id,taskId:event.taskId,proposalId:event.decision.proposalId,original:event.decision.proposalId===proposalId,after:focusSnapshot(event.after),recordedAt:event.recordedAt,source:event.source,index});
 }
 receipts.sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt)||b.index-a.index);
 // Only the trusted commit verifier may disregard its own prepared receipt.
 // Other callers, including previews and HTTP reports, still see it as pending.
 const ownIntent=committing?.intents?.find(i=>i.path===history?.pending?.path);
 const ownPending=!!ownIntent&&history.pending.decision?.kind==='future_schedule'&&history.pending.decision.proposalId===committing.id&&history.pending.afterRevision===sha(ownIntent.content);
 const pending=!!history?.pending&&related.has(history.pending.decision?.proposalId)&&!ownPending;
 if(pending)warnings.push('A related task save awaits history reconciliation. Review its receipt before planning more work.');
 for(const plan of plans)if(!plan.error&&sources.history)plan.recorded=new Set(receipts.filter(e=>e.proposalId===plan.id).map(e=>e.taskId)).size;
 const complete=Object.values(sources).every(Boolean)&&!pending&&!warnings.length;
 const rows=[...known].map(([id,retained])=>{
  const matches=tasks?.filter(t=>t.id===id)||[],current=matches.length===1&&!matches[0].scheduleError?focusSnapshot(matches[0]):null;
  const identityIssue=!sources.tasks?'Current tasks unavailable.':matches.length>1?'Duplicate task ID.':matches[0]?.scheduleError?'Task metadata needs repair.':!current?'Task missing from active notes; completion is unknown.':null;
  const candidate=week?.rows.find(r=>r.taskId===id),entries=receipts.filter(e=>e.taskId===id),latest=entries[0]||null;
  const reserved=!!current?.startTime&&(current.planDate>today||current.planDate===today&&minutes(current.startTime)+current.duration>now.getHours()*60+now.getMinutes());
  const state=identityIssue?'unknown':current.done?'complete':reserved?'reserved':!sources.readiness?'unknown':candidate?.issue?'blocked':candidate?'ready':'unknown';
  const detail=identityIssue||(state==='complete'?'Marked complete in the current note.':reserved?'Already reserved on '+current.planDate+' at '+current.startTime+'. Keep this slot or edit it explicitly.':candidate?.issue||(!candidate?'Readiness unavailable.':current.planDate>today?'Planned for '+current.planDate+' without a reserved time; compare only its eligible dates.':'No current timed reservation. Choose this task explicitly if it is still needed.'));
  const planned=valid.filter(v=>v.changes.some(c=>c.before.id===id)),held=valid.filter(v=>v.held.some(h=>h.taskId===id));
  return {taskId:id,text:current?.text||retained.text,retained,current,state,detail,eligibleDates:candidate?.eligibleDates||[],latest:sources.history?latest:null,changedSinceLatest:current&&latest?focusHash(current)!==focusHash(latest.after):null,receiptCount:sources.history?entries.length:null,receipts:entries.slice(taskId?offset:0,taskId?offset+20:3),proposedIn:planned.map(v=>v.id),heldIn:held.map(v=>v.id),withoutReceipt:sources.history?planned.filter(v=>!entries.some(e=>e.proposalId===v.id)).length:null,canSelect:complete&&state==='ready'};
 });
 if(taskId&&!rows.some(r=>r.taskId===taskId))throw new AppError('This task is not in the known workload membership.',404);
 if(localDay(p.now())!==today)warnings.push('The day changed while loading. Refresh before choosing work.');
 const counts=Object.fromEntries(['ready','reserved','complete','blocked','unknown'].map(s=>[s,rows.filter(r=>r.state===s).length]));
 return {proposalId,date,today,timezone:week?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone,generatedAt:now.toISOString(),source:{title:original?.title||'Unavailable original workload',date:original?.date||null,legacy:original?.legacy??null},sources,pending,canPlan:complete&&localDay(p.now())===today,counts,total:rows.length,rows:taskId?rows.filter(r=>r.taskId===taskId):rows,taskId:taskId||null,offset:taskId?offset:0,plans:plans.sort((a,b)=>String(b.date).localeCompare(String(a.date))||String(a.id).localeCompare(String(b.id))),warnings:[...new Set(warnings)]};
}
