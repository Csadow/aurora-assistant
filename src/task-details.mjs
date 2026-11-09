import {AppError,sha} from './vault.mjs';
import {tasksIn} from './task-meta.mjs';
import {localDay,clock,minutes} from '../mobile/web/planner-core.js';
import {taskGraph,taskRef,projectNotes} from '../mobile/web/task-links.js';
import {stepCards,stepOutcomeRows} from './step-outcomes.mjs';
import {TaskProposals} from './task-proposals.mjs';
import {buildDayHandoff} from './day-handoff.mjs';
import {validDate} from './task-meta.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const section=async fn=>{try{return {available:true,data:await fn(),error:null};}catch(e){return {available:false,data:null,error:e.message};}};
const recent=(rows,count=20)=>({rows:rows.slice(0,count),total:rows.length});
// Invalid scheduling data is never actionable, but a readable ID can still point
// back to the source that needs repair. Use tasksIn so archived notes and code
// fences retain exactly the same visibility rules as the planner.
export function sourceCandidate(task){
 if(!task.scheduleError)return task;
 const match=task.text.match(/\s*<!-- aster-task:(\{.*\}) -->\s*$/);
 try{const id=JSON.parse(match?.[1]).id;if(uuid(id))return {...task,id,text:task.text.slice(0,match.index).trimEnd()};}catch{}
 return task;
}

export class TaskDetails {
 constructor({planner}){this.planner=planner;}
 report(taskId,handoffSource=null){if(!uuid(taskId))throw new AppError('Choose a task with a valid stable ID.');if(handoffSource&&(!validDate(handoffSource.date)||!uuid(handoffSource.proposalId)||handoffSource.date>localDay(this.planner.now())))throw new AppError('Choose an existing evening decision and its original date.');return this.planner.vault.exclusive(()=>this.build(taskId,handoffSource));}
 async build(taskId,handoffSource=null){
  const p=this.planner,now=p.now(),date=localDay(now),timezone=p.dailyFocus.timezone(),notes=await p.vault.list(),tasks=tasksIn(notes),matches=tasks.map(sourceCandidate).filter(t=>t.id===taskId),task=matches.length===1&&!matches[0].scheduleError?matches[0]:null;
  const identityIssue=matches.length>1?'This ID belongs to more than one task. Open the source notes to repair it before changing anything.':matches[0]?.scheduleError?'This task has invalid metadata. Repair its source note before changing it.':!task?'This task is no longer in active notes. Its recorded history does not establish completion.':null;
  const sections={};
  if(handoffSource)sections.handoff=await section(async()=>{
   const r=await buildDayHandoff(p,handoffSource.date,{proposalId:handoffSource.proposalId,taskId}),decision=r.decisions?.find(d=>d.id===handoffSource.proposalId),row=decision?.rows.find(r=>r.taskId===taskId);
   if(!decision||!row)throw new AppError(r.decisions===null?'The original evening decisions cannot be read. Current task details remain available.':'This task is not in the original evening decision, or that decision is no longer available.',404);
   return {date:r.date,timezone:r.timezone,decision,row,checkins:r.checkins,checkinCount:r.checkinCount,historyAvailable:r.historyAvailable,warnings:r.warnings};
  });
  sections.schedule=await section(async()=>{
   if(!task||identityIssue)throw new AppError(identityIssue,409);
   const links=taskGraph(tasks).states.get(taskRef(task)),project=task.project?projectNotes(notes).find(n=>n.path===task.project):null;
   const context=new TaskProposals({vault:p.vault,store:p.store}).context(notes,task,task,timezone,task.planDate&&task.startTime?await p.calendar?.context({includeLinked:true}):undefined);
   return {endTime:task.startTime?clock(minutes(task.startTime)+task.duration):null,conflicts:context.conflicts,warnings:context.warnings,dependencies:links?.reasons||[],project:task.project?{path:task.project,title:project?.title||task.project,missing:!project}:null};
  });
  sections.focus=await section(async()=>{const r=await p.dailyFocus.build(undefined,{includeIds:[taskId]});return r.rows.find(r=>r.taskId===taskId)||null;});
  sections.steps=await section(async()=>{
   const state=await p.firstSteps.read(),card=state.cards[taskId]||null,history=stepCards(state).filter(c=>c.taskId===taskId).sort((a,b)=>b.sequence-a.sequence),outcomes=stepOutcomeRows(state,taskId).reverse();
   let current=null,contextError=null;try{current=await p.firstSteps.build(taskId,state);}catch(e){contextError=e.message;}
   return {card,history:recent(history),outcomes:recent(outcomes),changed:current?.changed??null,contextError,canSave:!!current?.canSave};
  });
  sections.sessions=await section(async()=>{
   const state=await p.focusSessions.read(),all=state.sessions.filter(s=>s.taskId===taskId),views=all.map(s=>p.focusSessions.view(s));
   const rows=views.sort((a,b)=>b.created.localeCompare(a.created)).map(s=>({id:s.id,status:s.status,created:s.created,updated:s.updated,timezone:s.timezone,stepSequence:s.card.sequence,stepText:s.card.text,taskText:s.card.context.task.text,recordedMilliseconds:s.recordedMilliseconds,unknownIntervals:s.unrecordedIntervals,interruption:s.interruption}));
   // Always retain open-session navigation even when there are many finished records.
   return {open:rows.filter(s=>s.status!=='finished'),finished:recent(rows.filter(s=>s.status==='finished')),recordedMilliseconds:views.reduce((n,s)=>n+s.recordedMilliseconds,0),unknownIntervals:views.reduce((n,s)=>n+s.unrecordedIntervals,0),openIntervals:all.filter(s=>s.run).length,total:all.length};
  });
  sections.estimates=await section(async()=>{
   const rows=[];for(const raw of await p.store.list('estimate-reviews'))if(raw.taskId===taskId){const r=await p.estimateReviews.record(raw.id);rows.push({id:r.id,status:r.status,created:r.created,before:r.before.duration,after:r.after.duration,basis:r.input.basis,reason:r.input.note,writeAttempted:!!r.intent});}
   rows.sort((a,b)=>b.created.localeCompare(a.created));return {...recent(rows),pending:rows.filter(r=>r.status==='pending')};
  });
  sections.execution=await section(async()=> (await p.execution()).filter(r=>r.taskId===taskId));
  sections.history=await section(async()=>{const h=await p.dailyFocus.history.read();return {...recent((h?.events||[]).filter(e=>e.taskId===taskId).reverse()),startedAt:h?.startedAt||null,pending:!!h?.pending};});
  sections.reviews=await section(async()=> (await p.store.list('proposals')).filter(r=>r.status==='pending'&&['day_replan','future_schedule','focus_schedule','evening_review','weekly_review'].includes(r.kind)&&r.changes?.some(c=>c.before.id===taskId)).map(r=>({id:r.id,title:r.title,created:r.created,savedNotes:r.saved?.length||0,totalNotes:new Set(r.changes.map(c=>c.before.path)).size})));
  const title=task?.text||(matches.length===1?matches[0].text:null)||sections.steps.data?.card?.context.task.text||sections.sessions.data?.open[0]?.taskText||sections.sessions.data?.finished.rows[0]?.taskText||'Unavailable task';
  const data={taskId,title,date,timezone,task,identityIssue,matches:matches.map(t=>({path:t.path,line:t.line,text:t.text})),sections,...(handoffSource?{handoffSource}:{})};
  return {...data,generatedAt:now.toISOString(),revision:sha(JSON.stringify(data))};
 }
}
