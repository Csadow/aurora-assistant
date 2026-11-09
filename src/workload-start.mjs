import {AppError} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {sourceCandidate} from './task-details.mjs';
import {focusSnapshot,focusHash} from './focus-review.mjs';
import {localDay,minutes} from '../mobile/web/planner-core.js';
import {buildWorkloadFollow} from './workload-follow.mjs';
import {workloadFrom,workloadSourceSnapshot} from './workload-next.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const taskOK=t=>t&&uuid(t.id)&&typeof t.text==='string'&&typeof t.path==='string'&&typeof t.done==='boolean'&&Number.isInteger(t.duration)&&t.duration>=5&&t.duration<=720&&(!t.planDate||validDate(t.planDate))&&(!t.startTime||/^([01]\d|2[0-3]):[0-5]\d$/.test(t.startTime));

// Reading a handoff must never reconcile pending history, retry a save or choose focus.
export function workloadStart(planner,input={}){return planner.vault.exclusive(()=>buildWorkloadStart(planner,input));}
async function buildWorkloadStart(p,{date=localDay(p.now()),proposalId,offset=0}={}){
 if(!validDate(date)||proposalId!==undefined&&!uuid(proposalId)||!Number.isInteger(offset)||offset<0||offset>100000)throw new AppError('Choose a valid day and unfinished-work plan.');
 const now=p.now(),today=localDay(now),warnings=[],sources={proposals:true,history:true,tasks:true};
 const read=async(name,fn)=>{try{return await fn();}catch(e){sources[name]=false;warnings.push(name+': '+e.message);return null;}};
 const proposals=await read('proposals',()=>proposalId?p.store.get('proposals',proposalId).then(x=>[x]):p.store.list('proposals'));
 if(proposalId&&proposals&&!proposals.some(x=>x.kind==='future_schedule'&&x.origin==='workload-next'))throw new AppError('This is not an unfinished-work plan.',404);
 const history=await read('history',async()=>{const h=await p.dailyFocus.history.read();if(!Array.isArray(h?.events))throw Error('Recorded task history is unavailable.');return h;});
 const tasks=await read('tasks',async()=>(await p.vault.tasks()).map(sourceCandidate));
 if(history?.pending)warnings.push('A task save awaits history reconciliation. Pending writes are not recorded saves.');
 const receipts=id=>(history?.events||[]).filter(e=>e.decision?.kind==='future_schedule'&&e.decision.proposalId===id&&['aurora_save','recovered_save'].includes(e.source)&&Number.isFinite(Date.parse(e.recordedAt))&&new Date(e.recordedAt)<=now&&taskOK(e.after)&&e.taskId===e.after.id);
 // A proposal alone does not establish saved work. When history is unavailable,
 // keep candidate records visible with unknown counts instead of claiming no plans.
 const all=(proposals||[]).filter(v=>v.kind==='future_schedule'&&v.origin==='workload-next'&&(proposalId||v.targetDate===date)&&(!Number.isFinite(Date.parse(v.created))||new Date(v.created)<=now)&&(proposalId||!sources.history||receipts(v.id).length)).sort((a,b)=>String(b.created).localeCompare(String(a.created))||String(b.id).localeCompare(String(a.id)));
 const plans=[],originals=new Map();
 for(const v of all.slice(proposalId?0:offset,proposalId?1:offset+10)){
  const base={id:v.id,date:v.targetDate,title:typeof v.title==='string'?v.title:'Unfinished-work plan',status:v.status};
  try{workloadFrom(v.workloadFrom);if(!uuid(v.id)||!Number.isFinite(Date.parse(v.created))||!validDate(v.targetDate)||!['pending','accepted','dismissed'].includes(v.status)||!Array.isArray(v.changes)||!Array.isArray(v.held)||v.changes.some(c=>!taskOK(c?.before)||!taskOK(c?.after)||c.before.id!==c.after.id)||v.held.some(h=>!taskOK(h?.task)||h.taskId!==h.task.id))throw Error();const ids=[...v.changes.map(c=>c.before.id),...v.held.map(h=>h.taskId)];if(new Set(ids).size!==ids.length)throw Error();}
  catch{plans.push({...base,error:'This unfinished-work record cannot be read. Its saved data is kept.'});continue;}
  const sourceId=v.workloadFrom.proposalId;
  if(!originals.has(sourceId)){
   try{const r=await buildWorkloadFollow(p,{proposalId:sourceId}),s=r.plans[0];originals.set(sourceId,s&&!s.error?{plan:s,history:r.sources.history,warnings:r.warnings}:{error:s?.error||'The original workload is unavailable.'});}
   catch(e){originals.set(sourceId,{error:e.message});}
  }
  const source=originals.get(sourceId),original=source.plan,sourceChanged=original&&source.history?workloadSourceSnapshot(original).revision!==v.workloadFrom.revision:null;
  const ids=[...new Set([...(original?.rows||[]).map(r=>r.taskId),...v.changes.map(c=>c.before.id),...v.held.map(h=>h.taskId)])];
  const events=receipts(v.id),rows=ids.map(taskId=>{
   const prior=original?.rows.find(r=>r.taskId===taskId),change=v.changes.find(c=>c.before.id===taskId),held=v.held.find(h=>h.taskId===taskId);
   const receipt=change?events.filter(e=>e.taskId===taskId).sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)).at(-1):null;
   const saved=receipt?{after:focusSnapshot(receipt.after),recordedAt:receipt.recordedAt,source:receipt.source}:null;
   const matches=tasks?.filter(t=>t.id===taskId)||[],current=matches.length===1&&!matches[0].scheduleError?focusSnapshot(matches[0]):null;
   const issue=!sources.tasks?'Current tasks unavailable.':matches.length>1?'Duplicate task ID.':matches[0]?.scheduleError?'Task metadata needs repair.':!current?'Task no longer in active notes; completion is unknown.':null;
   return {taskId,original:prior?{retained:prior.retained,selection:prior.selection,saved:prior.saved}:null,selection:change?'proposed':held?'held':'omitted',beforePreview:change?focusSnapshot(change.before):held?focusSnapshot(held.task):null,proposed:change?focusSnapshot(change.after):null,held:held?.reason||null,saved,current,issue,changedSinceSave:current&&saved?focusHash(current)!==focusHash(saved.after):null,elapsed:!current?.done&&!!current?.startTime&&current.planDate===today&&minutes(current.startTime)+current.duration<=now.getHours()*60+now.getMinutes()};
  });
  plans.push({...base,workloadFrom:v.workloadFrom,sourceDate:original?.date||null,sourceLegacy:original?.legacy??null,sourceChanged,sourceError:source.error||null,sourceWarnings:source.warnings||[],rows,recorded:sources.history?rows.filter(r=>r.saved).length:null,unrecorded:sources.history?rows.filter(r=>r.proposed&&!r.saved).length:null,held:rows.filter(r=>r.selection==='held').length,omitted:original?rows.filter(r=>r.selection==='omitted').length:null,recordedMinutes:sources.history?rows.reduce((n,r)=>n+(r.saved?.after.startTime?r.saved.after.duration:0),0):null});
 }
 if(localDay(p.now())!==today)warnings.push('The day changed while loading. Refresh before continuing.');
 return {date,today,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,generatedAt:now.toISOString(),proposalId:proposalId||null,offset:proposalId?0:offset,total:all.length,plans,sources,warnings};
}
