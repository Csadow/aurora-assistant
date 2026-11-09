import {AppError,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {localDay,minutes} from '../mobile/web/planner-core.js';
import {projectNotes} from '../mobile/web/task-links.js';
import {focusSnapshot,focusHash} from './focus-review.mjs';
import {savedPlanEvents} from './saved-day-plans.mjs';
import {stepOutcomeRows} from './step-outcomes.mjs';
const hash=v=>sha(JSON.stringify(v)),uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export class PlanFollowThrough {
 constructor({planner}){this.planner=planner;}
 report(proposalId){return this.planner.vault.exclusive(()=>this.build(proposalId));}
 // Non-locking for focus and schedule commit guards.
 async build(proposalId){
  if(proposalId!==undefined&&!uuid(proposalId))throw new AppError('Choose a valid saved plan.');
  const p=this.planner,now=p.now(),date=localDay(now),timezone=p.dailyFocus.timezone();
  const all=(await p.store.list('proposals')).filter(r=>r.kind==='future_schedule'&&r.outcomeSources&&validDate(r.targetDate)&&r.targetDate<=date).sort((a,b)=>b.targetDate.localeCompare(a.targetDate)||b.created.localeCompare(a.created));
  const plans=proposalId?all.filter(r=>r.id===proposalId):all.slice(0,50);
  if(proposalId&&!plans.length)throw new AppError('This plan is unavailable or is for a future day. Reopen follow-through.',409);
  const ids=[...new Set(plans.flatMap(r=>r.outcomeSources.map(s=>s.taskId)))],focus=await p.dailyFocus.build(undefined,{includeIds:ids}),history=await p.dailyFocus.history.read(),remainder=await p.candidates(),projects=projectNotes(await p.vault.list());
  let state=null,sourceError=null;try{state=await p.firstSteps.read();}catch(e){sourceError=e.message;}
  const currentReports=state?stepOutcomeRows(state):[],rows=[];
  for(const plan of plans)for(const selectedSource of plan.outcomeSources){
   const taskId=selectedSource.taskId,f=focus.rows.find(r=>r.taskId===taskId),held=plan.held?.find(r=>r.taskId===taskId),change=plan.changes.find(c=>c.before.id===taskId);
   if(!change&&!held)continue;
   const receipt=savedPlanEvents(history,plan.targetDate,now).filter(e=>e.decision.proposalId===plan.id&&e.taskId===taskId).at(-1)||null;
   const evidence=receipt?'saved':held?'held':plan.status==='dismissed'?'dismissed':'unrecorded';
   const original=focusSnapshot(receipt?.after||change?.after||held.task),current=f?.task||null,adjust=remainder.tasks.find(t=>t.id===taskId);
   const projectNote=current?.project?projects.find(n=>n.path===current.project):null,project=current?.project?{path:current.project,title:projectNote?.title||current.project,revision:projectNote?.revision||null,excerpt:projectNote?.body.slice(0,1000)||'',missing:!projectNote}:null;
   const outcomes=currentReports.filter(o=>o.taskId===taskId),currentCard=state?.cards[taskId]||null;
   const timing=!current?'unknown':!current.planDate||!current.startTime?'untimed':current.planDate<date?'earlier day':current.planDate>date?'future day':minutes(current.startTime)+current.duration<=now.getHours()*60+now.getMinutes()?'elapsed':minutes(current.startTime)<=now.getHours()*60+now.getMinutes()?'in progress':'upcoming';
   const outcomeChanged=!!state&&selectedSource.outcomes.some(o=>{const live=outcomes.find(x=>x.id===o.id);return !live||live.superseded||!live.unresolved||hash([live.note,live.card,live.context])!==hash([o.note,o.card,o.context]);});
   const stepChanged=!!state&&hash(currentCard)!==hash(selectedSource.currentCard),projectChanged=hash(project)!==hash(selectedSource.project),changed=focusHash(original)!==focusHash(current);
   const identityIssue=f?.identityIssue||(!current?'Task unavailable; completion is unknown.':null),canFocus=!!current&&!identityIssue&&!current.done&&!sourceError;
   const adjustmentIssue=sourceError||identityIssue||(current?.done?'Task is marked complete.':current?.planDate!==date?'Only tasks currently planned for today can be adjusted here.':adjust?.issue||(!adjust?'Task is unavailable for adjustment.':null));
   const row={proposalId:plan.id,taskId,plannedDate:plan.targetDate,planStatus:plan.status,selectedSource,evidence,receipt:receipt?{id:receipt.id,source:receipt.source,recordedAt:receipt.recordedAt}:null,heldReason:held?.reason||null,original,current,text:current?.text||original?.text||'Unavailable task',changed,timing,identityIssue,detail:f?.detail||'Task unavailable.',execution:f?.execution||[],dependencyReasons:f?.dependencyReasons||[],contextRevision:f?.contextRevision||null,choice:f?.choice||null,sourceError,currentCard,outcomes,project,outcomeChanged,stepChanged,projectChanged,canFocus,canAdjust:!adjustmentIssue,adjustmentIssue,adjustmentContext:adjust?.contextRevision||null};
   row.needsAttention=!current?.done&&(evidence!=='saved'||changed||outcomeChanged||stepChanged||projectChanged||!!identityIssue||!!sourceError||['elapsed','earlier day','untimed','unknown'].includes(timing)||['review','decision','blocked','unavailable'].includes(f?.readiness));
   // A save creates its own pending history intent before replacing a note.
   // Guard the recorded evidence itself, not that transient journal flag.
   row.revision=hash({date,timezone,row});rows.push(row);
  }
  return {date,timezone,focusRevision:focus.revision,rows,totalPlans:all.length,shownPlans:plans.length,truncated:!proposalId&&all.length>plans.length,warnings:[...(sourceError?[sourceError]:[]),...(history?.pending?['Some task saves await history reconciliation. Only recorded saves are labelled saved.']:[])],counts:{selections:rows.length,attention:rows.filter(r=>r.needsAttention).length,unrecorded:rows.filter(r=>r.evidence!=='saved').length}};
 }
 async overview(){const r=await this.build();return {date:r.date,counts:r.counts,truncated:r.truncated,warnings:r.warnings};}
 async source(ref,{adjust=false}={}){
  if(!uuid(ref?.proposalId)||!uuid(ref?.taskId)||typeof ref.revision!=='string')throw new AppError('Compare a current follow-through selection first.');
  const r=await this.build(ref.proposalId),row=r.rows.find(r=>r.taskId===ref.taskId);
  if(!row||row.revision!==ref.revision||row.sourceError||adjust&&!row.canAdjust)throw new AppError('The plan, saved evidence, task, outcome, project, attempt or day changed. Reopen follow-through and compare current details.',409);
  return row;
 }
 request(i){
  if(!uuid(i?.requestId)||!uuid(i?.proposalId)||!uuid(i?.taskId)||!validDate(i.date)||['timezone','revision','focusRevision','contextRevision'].some(k=>typeof i[k]!=='string'))throw new AppError('Review a follow-through task before choosing today’s focus.');
  const source={kind:'plan_follow_through',proposalId:i.proposalId,taskId:i.taskId,revision:i.revision};
  return {input:{requestId:i.requestId,date:i.date,timezone:i.timezone,revision:i.focusRevision,taskId:i.taskId,contextRevision:i.contextRevision,action:'focus'},options:{source,includeIds:[i.taskId],verifySource:async()=>{const r=await this.source(i);if(!r.canFocus)throw new AppError('Choose a valid unfinished task with readable sources.',409);}}};
 }
 async choose(i){const r=this.request(i);try{return await this.planner.dailyFocus.decide(r.input,r.options);}catch(e){if(e.status)throw e;throw new AppError('The focus save could not be confirmed. Retry this exact request or check its receipt.',503);}}
 status(i){const r=this.request(i);return this.planner.dailyFocus.decisionStatus(r.input,r.options);}
}
