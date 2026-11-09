import {checkinReview} from './checkin-review.mjs';
import {AppError,sha} from './vault.mjs';
import {tasksIn,validDate} from './task-meta.mjs';
import {taskGraph,taskRef} from '../mobile/web/task-links.js';
import {buildWeek,weekStart} from './weekly-planner.mjs';
import {localDay,minutes} from '../mobile/web/planner-core.js';
const confirmedCarries=events=>events.filter(e=>e.source==='aurora_save'&&['evening_review','weekly_review'].includes(e.decision?.kind)&&e.decision?.action==='move'&&validDate(e.before?.planDate)&&validDate(e.after?.planDate)&&e.after.planDate>e.before.planDate&&e.kinds.includes('rescheduled'));
const carryRevision=events=>events.length?sha(JSON.stringify(events)):null;
export class WeeklyReview{
 constructor({vault,history,taskWorkflows,calendar,now=()=>new Date()}){Object.assign(this,{vault,history,taskWorkflows,calendar,now});}
 async deferralRevisions(){const state=await this.history.read(),groups=new Map();for(const e of confirmedCarries(state?.events||[])){const list=groups.get(e.taskId)||[];list.push(e);groups.set(e.taskId,list);}return new Map([...groups].map(([id,events])=>[id,carryRevision(events)]));}
 report(date=localDay(this.now())){return this.vault.exclusive(async()=>{
  const now=this.now(),today=localDay(now);if(date>today)throw new AppError('Choose this week or an earlier week.');
  const start=weekStart(date),state=await this.history.sync(),notes=await this.vault.list(),tasks=tasksIn(notes),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const week=buildWeek(notes,{date:start,timezone,now,calendar:await this.calendar?.context()}),execution=await this.taskWorkflows?.summary({includeResults:true})||[],graph=taskGraph(tasks);
  if(this.recurring?.error)week.warnings.push('Recurring task generation needs attention: '+this.recurring.error);
  const idCounts=new Map();for(const t of tasks)if(t.id)idCounts.set(t.id,(idCounts.get(t.id)||0)+1);const untracked=tasks.filter(t=>!t.id||t.scheduleError||idCounts.get(t.id)>1).length;
  if(untracked)week.warnings.push(untracked+' current task(s) have missing, invalid or duplicate IDs; their history cannot be reliably counted.');
  const day=t=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
  const events=state.events.filter(e=>{const d=day(e.recordedAt);return d>=week.start&&d<=week.end;});
  const saved=events.filter(e=>e.source==='aurora_save'),external=events.filter(e=>e.source==='external_observation'),recovered=events.filter(e=>e.source==='recovered_save');
  const allCarried=confirmedCarries(state.events),carried=confirmedCarries(saved);
  const counts=new Map();for(const e of carried){const group=counts.get(e.taskId)||{taskId:e.taskId,title:e.after.text,count:0,events:[]};group.count++;group.events.push({id:e.id,at:e.recordedAt,from:e.before.planDate,to:e.after.planDate,proposalId:e.decision.proposalId});counts.set(e.taskId,group);}
  const relevant=new Set(events.map(e=>e.taskId)),inWeek=d=>d&&d>=week.start&&d<=week.end,at=now.getHours()*60+now.getMinutes();
  const unfinished=tasks.filter(t=>!t.done&&(inWeek(t.planDate)||inWeek(t.due)||t.id&&relevant.has(t.id))).map(t=>{
   const links=execution.filter(e=>t.id&&e.taskId===t.id),carries=allCarried.filter(e=>t.id&&e.taskId===t.id),reliable=!!t.id&&!t.scheduleError&&idCounts.get(t.id)===1;
   const deferrals={reliable,total:reliable?carries.length:null,inWeek:reliable?carried.filter(e=>e.taskId===t.id).length:null,revision:carryRevision(carries),recent:reliable?carries.slice(-5).reverse().map(e=>({id:e.id,at:e.recordedAt,from:e.before.planDate,to:e.after.planDate,proposalId:e.decision.proposalId})):[]};
   const completion=links.some(e=>['completion','completion_review','completion_save'].includes(e.attention?.kind));
   const guidance=completion?'Review Aurora’s recorded result before deciding whether this task needs more work.':links.some(e=>e.attention)?'Review the current question or blocker before choosing the next work block.':reliable&&carries.length>=2?'Carried forward more than once. Consider a smaller concrete step, a revised estimate, or leaving it unscheduled.':null;
   return {...t,execution:links,deferrals,guidance,dependencyReasons:graph.states.get(taskRef(t))?.reasons||[],locked:!!t.scheduleError||t.planDate===today&&!!t.startTime&&minutes(t.startTime)<=at&&minutes(t.startTime)+t.duration>at};
  });
  let checkins=null,checkinsError=null;if(this.dayPlanning)try{checkins=await checkinReview(this.dayPlanning,week.start,week.end,{history:state,tasks,execution});}catch(e){checkinsError=e.message;}
  let estimateFollowThrough=null,estimateFollowThroughError=null;if(this.dayPlanning?.estimateFollowThrough)try{estimateFollowThrough=await this.dayPlanning.estimateFollowThrough.build({start:week.start,end:week.end});}catch(e){estimateFollowThroughError=e.message;}
  return {estimateFollowThrough,estimateFollowThroughError,start:week.start,end:week.end,today,timezone,checkins,checkinsError,startedAt:state.startedAt,coverage:day(state.startedAt)>week.end?'No recording existed during this week.':day(state.startedAt)>=week.start?'Recording began during this week; earlier history is unknown.':'Recorded changes only; edits between observations may be missing.',saved:{changes:saved.length,markedComplete:saved.filter(e=>e.kinds.includes('marked_complete')).length,reopened:saved.filter(e=>e.kinds.includes('reopened')).length,rescheduled:saved.filter(e=>e.kinds.includes('rescheduled')).length},observed:{external:external.length,recovered:recovered.length},carryForward:[...counts.values()].sort((a,b)=>b.count-a.count),events:events.slice(-100).reverse(),eventTotal:events.length,unfinished,workload:{classMinutes:week.totals.classMinutes,taskBlockMinutes:week.totals.taskMinutes,unfinishedEstimateMinutes:unfinished.filter(t=>!t.scheduleError).reduce((n,t)=>n+t.duration,0),conflicts:week.totals.conflicts},warnings:week.warnings};
 });}
}
