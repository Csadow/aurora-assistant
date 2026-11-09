import {sourceCandidate} from './task-details.mjs';
import {AppError} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {focusSnapshot,focusHash} from './focus-review.mjs';
import {localDay} from '../mobile/web/planner-core.js';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const snapshot=v=>v&&typeof v.text==='string'&&typeof v.path==='string'&&typeof v.done==='boolean'&&Number.isInteger(v.duration)&&v.duration>0;
// Read recorded changes without reconciling pending writes or rolling dates forward.
export function remainingAdjustments(planner,input={}){return planner.vault.exclusive(()=>build(planner,input));}
async function build(p,{date=localDay(p.now()),proposalId,offset=0}={}){
 const now=p.now(),today=localDay(now),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 if(!validDate(date)||date>today||proposalId!==undefined&&!uuid(proposalId)||!Number.isInteger(offset)||offset<0||offset>100000)throw new AppError('Choose today or an earlier adjustment date and a valid review.');
 const warnings=[],sources={proposals:true,tasks:true,history:true,checkins:true};
 const read=async(key,fn)=>{try{return await fn();}catch(e){sources[key]=false;warnings.push(key+': '+e.message);return null;}};
 const proposals=await read('proposals',async()=>proposalId?[await p.store.get('proposals',proposalId)]:await p.store.list('proposals'));
 if(proposalId&&proposals&&!proposals.some(v=>v.kind==='day_replan'&&v.date===date))throw new AppError('This adjustment is not available on that original date.',404);
 const tasks=await read('tasks',async()=>(await p.vault.tasks()).map(sourceCandidate));
 const history=await read('history',async()=>{const h=await p.dailyFocus?.history.read();if(!h)throw Error('Recorded task history is unavailable.');return h;});
 const checkins=await read('checkins',async()=>{if(!p.checkins)throw Error('Check-ins are unavailable.');return p.checkins.read();});
 if(history?.pending)warnings.push('A task save awaits history reconciliation. No pending write is treated as a recorded change.');
 const all=(proposals||[]).filter(v=>v.kind==='day_replan'),dated=all.filter(v=>v.date===date).sort((a,b)=>String(b.created).localeCompare(String(a.created))||String(b.id).localeCompare(String(a.id)));
 const adjustments=dated.slice(proposalId?0:offset,proposalId?1:offset+10).map(v=>{
  const base={id:v.id,date,title:v.title||'Remaining-day adjustment',status:v.status};
  if(!uuid(v.id)||!Number.isFinite(Date.parse(v.created))||!['pending','accepted','dismissed'].includes(v.status)||typeof v.timezone!=='string'||!Array.isArray(v.saved)||!Array.isArray(v.changes)||new Set(v.changes.map(c=>c?.before?.id||c?.before?.path+':'+c?.before?.line)).size!==v.changes.length||v.changes.some(c=>!snapshot(c?.before)||!snapshot(c.after)||c.before.id!==c.after.id||c.before.planDate!==date||c.after.planDate!==date||typeof c.unplaced!=='boolean'))return {...base,error:'This adjustment record cannot be read. Other records and current tasks remain available.'};
  const receipts=history?.events.filter(e=>e.decision?.kind==='day_replan'&&e.decision.proposalId===v.id&&['aurora_save','recovered_save'].includes(e.source)&&new Date(e.recordedAt)<=now)||[];
  const rows=v.changes.map(c=>{
   const taskId=uuid(c.before.id)?c.before.id:null,matches=taskId?tasks?.filter(t=>t.id===taskId):[],current=matches?.length===1&&!matches[0].scheduleError?focusSnapshot(matches[0]):null;
   const issue=!sources.tasks?'Current tasks unavailable.':!taskId?'No stable task ID.':matches.length>1?'Duplicate task ID.':matches[0]?.scheduleError?'Task metadata needs repair.':!current?'Task no longer in active notes; completion is unknown.':null;
   const receipt=taskId?receipts.filter(e=>e.taskId===taskId&&snapshot(e.after)&&e.after.id===taskId).at(-1):null;
   const saved=receipt?{before:focusSnapshot(receipt.before),after:focusSnapshot(receipt.after),recordedAt:receipt.recordedAt,source:receipt.source}:null;
   return {taskId,before:focusSnapshot(c.before),proposed:focusSnapshot(c.after),unplaced:c.unplaced,saved,noteSaved:v.saved.includes(c.before.path),current,issue,changed:saved&&current?focusHash(saved.after)!==focusHash(current):null};
  });
  const source=v.checkin,currentSource=source&&checkins?.entries.find(c=>c.id===source.id);
  const checkin=source?{id:uuid(source.id)?source.id:null,date:source.date,note:String(source.note||''),start:source.start,end:source.end,currentStatus:currentSource?.status||null,issue:!sources.checkins?'Current check-ins unavailable.':!currentSource?'Original check-in is no longer available.':null}:null;
  return {...base,timezone:v.timezone,created:v.created,rows,checkin,recorded:sources.history?rows.filter(r=>r.saved).length:null,untimed:sources.history?rows.filter(r=>r.saved&&!r.saved.after.startTime).length:null,savedNotes:v.saved.length,totalNotes:new Set(v.changes.map(c=>c.before.path)).size,total:rows.length};
 });
 const earlier=[...new Set(all.filter(v=>validDate(v.date)&&v.date<today).map(v=>v.date))].sort().reverse();
 if(localDay(p.now())!==today)warnings.push('The day changed while loading. Reload before continuing.');
 return {date,today,timezone,generatedAt:now.toISOString(),proposalId:proposalId||null,offset:proposalId?0:offset,adjustments,total:dated.length,earlier:earlier.slice(0,10),earlierTotal:earlier.length,sources,warnings};
}
