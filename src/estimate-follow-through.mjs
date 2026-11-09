import {AppError,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {focusSnapshot,focusHash} from './focus-review.mjs';
import {localDay} from '../mobile/web/planner-core.js';
import {estimateSourcesText} from './estimate-reviews.mjs';
import {noteWriteCommitted} from './daily-summaries.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const hash=v=>sha(JSON.stringify(v));

export class EstimateFollowThrough {
 constructor({planner}){this.planner=planner;}
 report(options={}){return this.planner.vault.exclusive(()=>this.build(options));}
 // Also used without a second vault lock by schedule commit guards and weekly review.
 async build({start,end,reviewId}={}){
  const p=this.planner,now=p.now(),date=localDay(now),timezone=p.dailyFocus.timezone();
  if((start!==undefined||end!==undefined)&&(!validDate(start)||!validDate(end)||start>end)||reviewId!==undefined&&!uuid(reviewId))throw new AppError('Choose a valid estimate review or date range.');
  const history=await p.dailyFocus.history.read(),records=[];
  for(const raw of await p.store.list('estimate-reviews'))records.push(await p.estimateReviews.record(raw.id));
  if(reviewId&&!records.some(r=>r.id===reviewId))throw new AppError('This estimate review is unavailable.',404);
  const rows=[],warnings=[],current=new Map();let pending=0,undated=0;
  const remainder=await p.candidates();
  for(const r of records){
   if(r.status==='dismissed')continue;
   const saved=r.status==='saved'||await noteWriteCommitted(p.vault,r.path,r.intent,r.historyBefore);
   if(!saved){pending++;continue;}
   const event=(history?.events||[]).filter(e=>e.taskId===r.taskId&&['aurora_save','recovered_save'].includes(e.source)&&e.decision?.kind==='estimate_review'&&e.decision.proposalId===r.id&&e.kinds.includes('estimate_changed')&&e.before?.duration===r.before.duration&&e.after?.duration===r.after.duration&&Number.isFinite(Date.parse(e.recordedAt))).at(-1);
   const recordedAt=event?.recordedAt||null,recordedDate=recordedAt?new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(recordedAt)):null;
   if(recordedAt&&new Date(recordedAt)>now)continue;
   if(!recordedDate)undated++;
   if(reviewId?r.id!==reviewId:start&&(!recordedDate||recordedDate<start||recordedDate>end))continue;
   if(!current.has(r.taskId)){
    try{current.set(r.taskId,{sources:await p.estimateReviews.sources(r.taskId),error:null});}
    catch(e){current.set(r.taskId,{sources:null,error:e.message});}
   }
   const live=current.get(r.taskId),s=live.sources,task=s?.task||null,adjust=remainder.tasks.find(t=>t.id===r.taskId),conflicts=s?.context?.conflicts||[];
   const issue=live.error||s?.issues[0]||(!task?'Task is unavailable.':task.planDate!==date?'Only tasks currently planned for today can be adjusted here.':adjust?.issue||(!adjust?'This task cannot be adjusted here.':null));
   const row={reviewId:r.id,taskId:r.taskId,text:task?.text||r.after.text,recordedAt,recordedDate,recovered:event?.source==='recovered_save',receiptPending:r.status!=='saved',before:focusSnapshot(r.before),after:focusSnapshot(r.after),basis:r.input.basis,reason:r.input.note,originalSourceText:p.estimateReviews.public(r).sourceText,originalTotals:r.sources.totals,current:task,changed:focusHash(focusSnapshot(r.after))!==focusHash(focusSnapshot(task)),currentSourceText:s?estimateSourcesText(s):null,currentTotals:s?.totals||null,conflicts,warnings:s?.warnings||[],sourceError:live.error,execution:s?.execution||[],canAdjust:!issue,adjustmentIssue:issue,needsAttention:!!task&&!task.done&&(conflicts.length>0||!task.startTime||focusHash(focusSnapshot(r.after))!==focusHash(focusSnapshot(task)))};
   // The receipt's pending flag may change during recovery without changing evidence.
   row.revision=hash({date,timezone,row:{...row,receiptPending:undefined},sources:s});rows.push(row);
  }
  rows.sort((a,b)=>(b.recordedAt||'').localeCompare(a.recordedAt||'')||a.reviewId.localeCompare(b.reviewId));
  if(undated)warnings.push(undated+' saved estimate review(s) have no recorded save date. They are available in the full comparison but excluded from weekly date totals.');
  if(history?.pending)warnings.push('Task history has an unfinished receipt. Original reviews remain available; unrecorded save dates are not inferred.');
  return {date,timezone,start:start||null,end:end||null,rows,pending,undated,warnings};
 }
 async source(ref){
  if(!uuid(ref?.reviewId)||!uuid(ref?.taskId)||typeof ref.revision!=='string')throw new AppError('Compare a saved estimate decision first.');
  const r=await this.build({reviewId:ref.reviewId}),row=r.rows.find(r=>r.taskId===ref.taskId);
  if(!row||row.revision!==ref.revision||!row.canAdjust)throw new AppError('The estimate, task, sessions, schedule, attempt or day changed. Compare current details before adjusting this task.',409);
  return row;
 }
}
