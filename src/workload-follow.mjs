import {AppError} from './vault.mjs';
import {sourceCandidate} from './task-details.mjs';
import {validDate} from './task-meta.mjs';
import {focusSnapshot,focusHash} from './focus-review.mjs';
import {localDay,minutes} from '../mobile/web/planner-core.js';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const text=(v,max)=>typeof v==='string'&&v.length<=max;
const taskFields=['id','path','text','done','planDate','startTime','duration','due'];
const retained=t=>t?Object.fromEntries(taskFields.map(k=>[k,t[k]??null])):null;
const taskOK=t=>t&&uuid(t.id)&&text(t.path,1024)&&text(t.text,10000)&&typeof t.done==='boolean'&&Number.isInteger(t.duration)&&t.duration>=5&&t.duration<=720&&(t.planDate===null||validDate(t.planDate))&&(t.due===null||validDate(t.due))&&(t.startTime===null||/^([01]\d|2[0-3]):[0-5]\d$/.test(t.startTime));
// This is the user's retained comparison context, not a task-save receipt.
export function validateWorkloadSource(value,selected){
 try{
  const s=value;if(!s||s.version!==1||!validDate(s.date)||!text(s.timezone,100)||!s.timezone||minutes(s.end)<=minutes(s.start)||!Number.isInteger(s.gap)||s.gap<0||s.gap>120||!Array.isArray(s.rows)||!s.rows.length||s.rows.length>100)throw Error();
  const ids=s.rows.map(r=>r?.taskId);
  if(new Set(ids).size!==ids.length||s.rows.some(r=>!uuid(r.taskId)||!taskOK(r.task)||r.task.id!==r.taskId)||!Array.isArray(s.selectedIds)||!s.selectedIds.length||new Set(s.selectedIds).size!==s.selectedIds.length||s.selectedIds.some(id=>!ids.includes(id))||!Array.isArray(selected)||selected.some(r=>!s.selectedIds.includes(r.taskId)))throw Error();
  return {version:1,date:s.date,timezone:s.timezone,start:s.start,end:s.end,gap:s.gap,rows:s.rows.map(r=>({taskId:r.taskId,task:retained(r.task)})),selectedIds:[...s.selectedIds]};
 }catch{throw new AppError('The retained workload context cannot be read. Keep the original draft and prepare a valid comparison.');}
}

// Read only: do not reconcile task history, retry writes, refresh Calendar or advance dates.
export function workloadFollow(planner,input={}){return planner.vault.exclusive(()=>buildWorkloadFollow(planner,input));}
export async function buildWorkloadFollow(p,{proposalId,offset=0}={}){
 if(proposalId!==undefined&&!uuid(proposalId)||!Number.isInteger(offset)||offset<0||offset>100000)throw new AppError('Choose a valid workload review.');
 const now=p.now(),today=localDay(now),sources={proposals:true,tasks:true,history:true},warnings=[];
 const read=async(name,fn)=>{try{return await fn();}catch(e){sources[name]=false;warnings.push(name+': '+e.message);return null;}};
 const proposals=await read('proposals',()=>proposalId?p.store.get('proposals',proposalId).then(v=>[v]):p.store.list('proposals'));
 if(proposalId&&proposals&&!proposals.some(v=>v.kind==='future_schedule'&&v.origin==='week-workload'))throw new AppError('This is not a workload day preview.',404);
 const tasks=await read('tasks',async()=>(await p.vault.tasks()).map(sourceCandidate)),history=await read('history',async()=>{const h=await p.dailyFocus?.history.read();if(!h||!Array.isArray(h.events))throw Error('Recorded task history is unavailable.');return h;});
 if(history?.pending)warnings.push('A task save awaits history reconciliation. Pending writes are not recorded saves.');
 const all=(proposals||[]).filter(v=>v.kind==='future_schedule'&&v.origin==='week-workload').sort((a,b)=>String(b.created).localeCompare(String(a.created))||String(b.id).localeCompare(String(a.id)));
 const plans=all.slice(proposalId?0:offset,proposalId?1:offset+10).map(v=>{
  const base={id:v.id,date:v.targetDate,title:v.title||'Workload day plan',status:v.status};
  let context=null;
  try{
   if(!uuid(v.id)||!validDate(v.targetDate)||!validDate(v.date)||!text(v.timezone,100)||!Number.isFinite(Date.parse(v.created))||!['pending','accepted','dismissed'].includes(v.status)||!Array.isArray(v.saved)||!Array.isArray(v.changes)||!Array.isArray(v.held)||v.changes.some(c=>!taskOK(retained(c?.before))||!taskOK(retained(c?.after))||c.before.id!==c.after.id)||v.held.some(h=>!uuid(h?.taskId)||!taskOK(retained(h.task))))throw Error();
   const selected=[...v.changes.map(c=>({taskId:c.before.id})),...v.held.map(h=>({taskId:h.taskId}))];if(new Set(selected.map(r=>r.taskId)).size!==selected.length)throw Error();
   if(v.workloadSource!==undefined)context=validateWorkloadSource(v.workloadSource,selected);
  }catch{return {...base,error:'This workload record cannot be read. Its stored data and current tasks are kept.'};}
  const originals=context?.rows||[...v.changes.map(c=>({taskId:c.before.id,task:retained(c.before)})),...v.held.map(h=>({taskId:h.taskId,task:retained(h.task)}))];
  const receipts=history?.events.filter(e=>e.decision?.kind==='future_schedule'&&e.decision.proposalId===v.id&&['aurora_save','recovered_save'].includes(e.source)&&new Date(e.recordedAt)<=now)||[];
  const rows=originals.map(o=>{
   const taskId=o.taskId,change=v.changes.find(c=>c.before.id===taskId),held=v.held.find(h=>h.taskId===taskId),matches=tasks?.filter(t=>t.id===taskId),current=matches?.length===1&&!matches[0].scheduleError?focusSnapshot(matches[0]):null;
   const issue=!sources.tasks?'Current tasks unavailable.':matches.length>1?'Duplicate task ID.':matches[0]?.scheduleError?'Task metadata needs repair.':!current?'Task no longer in active notes; completion is unknown.':null;
   const receipt=change?receipts.filter(e=>e.taskId===taskId&&taskOK(retained(e.after))&&e.after.id===taskId).at(-1):null;
   const saved=receipt?{after:focusSnapshot(receipt.after),recordedAt:receipt.recordedAt,source:receipt.source}:null;
   const selection=context?(context.selectedIds.includes(taskId)?'selected':'excluded'):'unknown';
   return {taskId,retained:o.task,selection,beforePreview:change?focusSnapshot(change.before):held?focusSnapshot(held.task):null,proposed:change?focusSnapshot(change.after):null,held:held?.reason||null,saved,noteSaved:!!change&&v.saved.includes(change.before.path),current,issue,changedSinceRetained:current&&context?focusHash(retained(current))!==focusHash(o.task):null,changedSinceSave:current&&saved?focusHash(current)!==focusHash(saved.after):null,elapsed:!!current?.startTime&&current.planDate===today&&minutes(current.startTime)+current.duration<=now.getHours()*60+now.getMinutes()};
  });
  return {...base,created:v.created,timezone:v.timezone,context,legacy:!context,rows,recorded:sources.history?rows.filter(r=>r.saved).length:null,reservedMinutes:sources.history?rows.reduce((n,r)=>n+(r.saved?.after.startTime?r.saved.after.duration:0),0):null,proposedCount:v.changes.length,savedNotes:v.saved.length,totalNotes:new Set(v.changes.map(c=>c.before.path)).size};
 });
 return {today,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,generatedAt:now.toISOString(),proposalId:proposalId||null,offset:proposalId?0:offset,total:all.length,plans,sources,warnings};
}
