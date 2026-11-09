import {AppError,sha} from './vault.mjs';
import {tasksIn} from './task-meta.mjs';
import {sourceCandidate} from './task-details.mjs';
import {projectNotes} from '../mobile/web/task-links.js';
import {nextDayReport} from './next-day-planning.mjs';
import {validDate} from './task-meta.mjs';
import {firstStepContext} from './first-steps.mjs';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const day=(at,timezone)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));

export function captureFilters({query='',project='all'}={}){
 if(typeof query!=='string'||query.length>500||typeof project!=='string'||!project||project.length>1000)throw new AppError('Choose valid captured-task search and project filters.');
 return {query,project};
}
export function captureReviewFilters({status='all',draftIds=[],selectedIds=[],date}={}){
 if(!['all','no-step','draft','changed'].includes(status)||!Array.isArray(draftIds)||draftIds.length>2000||draftIds.some(id=>!uuid(id))||!Array.isArray(selectedIds)||selectedIds.length>10||selectedIds.some(id=>!uuid(id))||new Set(selectedIds).size!==selectedIds.length||date!==undefined&&!validDate(date))throw new AppError('Choose valid capture status, date and shortlist filters.');
 return {status,draftIds:[...new Set(draftIds)],selectedIds,date};
}
export function capturedTaskReport({proposals,notes,currentId=null,now=new Date(),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone,warnings=[],filters={},limit=40}){
 filters=captureFilters(filters);
 const date=day(now,timezone),start=new Date(date+'T12:00:00Z');start.setUTCDate(start.getUTCDate()-6);const from=start.toISOString().slice(0,10);
 const tasks=tasksIn(notes).map(sourceCandidate),known=new Map();
 for(const p of proposals){
  if(p.origin!=='desktop_capture'&&p.id!==currentId||p.status!=='accepted')continue;
  const t=p.review?.after;
  if(!uuid(p.id)||p.kind!=='task'||p.review?.version!==1||!uuid(t?.id)||typeof t.text!=='string'||typeof p.review.path!=='string'||p.acceptedAt!==undefined&&(typeof p.acceptedAt!=='string'||!Number.isFinite(Date.parse(p.acceptedAt))))throw new AppError('A captured-task receipt is unreadable. Inspect or restore the saved review; other briefing sections remain available.',503);
  const time=p.acceptedAt||null,previous=known.get(t.id);
  if(previous&&(previous.confirmedAt||'')>=(time||''))continue;
  const matches=tasks.filter(x=>x.id===t.id),task=matches.length===1&&!matches[0].scheduleError?matches[0]:null;
  const issue=matches.length>1?'More than one task has this ID. Repair the source notes before editing.':matches[0]?.scheduleError?'The task has invalid metadata. Repair its source note before editing.':!task?'This task is missing or archived. That does not establish completion.':null;
  const confirmedDate=time?day(time,timezone):null;
  known.set(t.id,{taskId:t.id,proposalId:p.id,originalText:t.text,title:task?.text||t.text,confirmedAt:time,recovered:p.acceptedRecovered===true,timeUnknown:!time,recent:!!confirmedDate&&confirmedDate>=from&&confirmedDate<=date,task,issue,sources:matches.map(t=>({path:t.path,line:t.line})),originalPath:p.review.path});
 }
 const all=[...known.values()],open=all.filter(r=>r.task&&!r.task.done),issues=all.filter(r=>r.issue),rows=open.filter(r=>r.recent||!r.task.planDate||r.proposalId===currentId);
 rows.sort((a,b)=>(b.confirmedAt||'').localeCompare(a.confirmedAt||'')||a.taskId.localeCompare(b.taskId));issues.sort((a,b)=>(b.confirmedAt||'').localeCompare(a.confirmedAt||''));
 const projects=new Map(projectNotes(notes).map(n=>[n.path,n.title||n.path]));
 for(const r of rows)if(r.task.project&&!projects.has(r.task.project))projects.set(r.task.project,null);
 if(!['all','none'].includes(filters.project)&&!projects.has(filters.project))projects.set(filters.project,null);
 const normalize=v=>String(v||'').normalize('NFKC').toLowerCase(),terms=normalize(filters.query).trim().split(/\s+/).filter(Boolean);
 const matched=rows.filter(r=>(filters.project==='all'||filters.project==='none'&&!r.task.project||filters.project===r.task.project)&&terms.every(t=>normalize([r.title,r.originalText,r.task.path,r.task.project,projects.get(r.task.project)].join(' ')).includes(t)));
 for(const r of matched)r.project=r.task.project?{path:r.task.project,title:projects.get(r.task.project)||r.task.project,missing:projects.get(r.task.project)===null}:null;
 return {date,from,timezone,generatedAt:now.toISOString(),filters,projects:[...projects].sort(([a],[b])=>a.localeCompare(b)).map(([path,title])=>({path,title:title||path,missing:title===null})),rows:matched.slice(0,limit),issues:issues.slice(0,20),counts:{shown:Math.min(matched.length,limit),matched:matched.length,eligible:rows.length,unscheduled:open.filter(r=>!r.task.planDate).length,recent:open.filter(r=>r.recent).length,issues:issues.length,completed:all.filter(r=>r.task?.done).length,olderScheduled:open.filter(r=>!rows.includes(r)).length},warnings};
}

export class CapturedTasks {
 constructor({vault,store,capture,planner,now=()=>new Date()}){Object.assign(this,{vault,store,capture,planner,now});}
 review(input={}){if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('Choose valid captured-task review options.');return this.report(captureFilters(input),captureReviewFilters(input));}
 async report(filters={},review=null){
  filters=captureFilters(filters);
  // Do not wait on the capture queue while holding the vault lock: accepting a
  // capture uses those locks in the opposite order. These are atomic read snapshots.
  const warnings=[];let currentId=null;
  try{currentId=(await this.capture.read()).proposalId;}catch{warnings.push('The current capture draft could not be read. Saved capture receipts are still listed.');}
  const [notes,proposals]=await Promise.all([this.vault.list(),this.store.list('proposals')]);
  const report=capturedTaskReport({notes,proposals,currentId,now:this.now(),warnings,filters,...(review?{limit:Infinity}:{})});
  if(this.planner){
   let focus,steps,focusError,stepsError;
   try{focus=await this.planner.dailyFocus.build(undefined,{includeIds:report.rows.map(r=>r.taskId)});}catch(e){focusError=e.message;}
   try{steps=await this.planner.firstSteps.read();}catch(e){stepsError=e.message;}
   for(const r of report.rows){
    const f=focus?.rows.find(f=>f.taskId===r.taskId),card=steps?.cards[r.taskId];
    r.progress={focus:f?{available:true,choice:f.choice?.action||null,until:f.choice?.until||null,changed:f.changed,readiness:f.readiness,date:focus.date}:{available:false,error:focusError||'Current focus is unavailable.'},firstStep:steps?{available:true,card:card?{sequence:card.sequence,text:card.text.slice(0,180),date:card.context.date,mode:card.mode,changed:f?sha(JSON.stringify(card.context))!==sha(JSON.stringify(firstStepContext(f,focus.date,focus.timezone,notes))):null}:null}:{available:false,error:stepsError||'Saved steps are unavailable.'}};
   }
  }
  if(review){
   let planning;try{planning=await nextDayReport(this.planner,review.date||report.date);}catch(e){planning={date:review.date||report.date,today:report.date,timezone:report.timezone,rows:[],unavailable:true,warnings:['Planning details unavailable: '+e.message]};}
   const byId=new Map(planning.rows.map(r=>[r.taskId,r]));
   for(const r of report.rows){r.planning=byId.get(r.taskId)||null;r.localDraft=review.draftIds.includes(r.taskId);}
   const progressUnavailable=report.rows.some(r=>!r.progress?.focus.available||!r.progress?.firstStep.available);
   const matched=report.rows.filter(r=>review.status==='all'||review.status==='draft'&&r.localDraft||review.status==='no-step'&&r.progress?.firstStep.available&&!r.progress.firstStep.card||review.status==='changed'&&(r.progress?.focus.changed===true||r.progress?.firstStep.card?.changed===true));
   report.filters.status=review.status;report.counts.matched=matched.length;report.counts.shown=Math.min(matched.length,40);report.rows=matched.slice(0,40);
   report.planning={date:planning.date,today:planning.today,timezone:planning.timezone,warnings:planning.warnings,rows:review.selectedIds.map(taskId=>byId.get(taskId)||{taskId,task:null,issue:planning.unavailable?'Planning details are unavailable. Refresh before reviewing this choice.':'Task is missing or archived. This does not establish completion.'})};
   if(review.status==='no-step'||review.status==='changed')if(progressUnavailable)report.warnings.push('Some progress could not be read. This status filter may omit tasks with unavailable records; use All states to inspect them.');
  }
  return report;
 }
}
