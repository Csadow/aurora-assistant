import {savedPlanEvents,planChoice} from './saved-day-plans.mjs';
import {focusSnapshot,validFocusReviews,reviewDays,reviewInvitations,buildFocusReview,decideFocusReview} from './focus-review.mjs';
import {focusSchedulingIssue} from './focus-planning.mjs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {atomic,AppError,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {localDay,taskSignature} from '../mobile/web/planner-core.js';
import {taskGraph,taskRef} from '../mobile/web/task-links.js';
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const hash=value=>sha(JSON.stringify(value));
const decisionHash=(input,source)=>{const {date,timezone,revision,taskId,contextRevision,action,until=null}=input;return hash({date,timezone,revision,taskId,contextRevision,action,until,...(source?{source}:{})});};
const empty=()=>({version:1,days:{},receipts:[]});
const taskSnapshot=focusSnapshot;
const weeklySnapshot=e=>e?{id:e.id,source:e.source,recordedAt:e.recordedAt,proposalId:e.decision.proposalId,action:e.decision.action,task:e.after}:null;
export class DailyFocus {
 constructor({vault,history,taskWorkflows,data,now=()=>new Date(),timezone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone}){Object.assign(this,{vault,history,taskWorkflows,now,timezone});this.path=join(data,'daily-focus.json');this.marker=join(data,'daily-focus-started.json');}
 async read(){
  try{const s=JSON.parse(await readFile(this.path,'utf8'));if(s.version!==1||!s.days||typeof s.days!=='object'||Array.isArray(s.days)||!Array.isArray(s.receipts))throw Error();
   for(const [key,day] of Object.entries(s.days)){if(!validDate(day.date)||typeof day.timezone!=='string'||key!==day.timezone+'|'+day.date||!day.choices||typeof day.choices!=='object'||Array.isArray(day.choices))throw Error();for(const [id,c] of Object.entries(day.choices))if(!uuid(id)||!['focus','later','off'].includes(c.action)||typeof c.at!=='string'||typeof c.contextRevision!=='string'||c.action==='later'&&(!validDate(c.until)||c.until<=day.date))throw Error();}
   if(!validFocusReviews(s))throw Error();
   if(s.receipts.some(r=>!uuid(r.id)||typeof r.hash!=='string'))throw Error();return s;
  }catch(e){if(e.code==='ENOENT'){try{await readFile(this.marker);}catch(m){if(m.code==='ENOENT')return empty();throw m;}throw new AppError('Daily focus data is missing. Restore its backup before changing focus.',503);}throw new AppError('Daily focus cannot be read. Restore its backup before changing focus.',503);}
 }
 review(date){return this.vault.exclusive(()=>buildFocusReview(this,date));}
 reviewDecision(input){return decideFocusReview(this,input);}
 scope(taskId){if(taskId!=null&&!uuid(taskId))throw new AppError('Choose a task with a valid stable ID.');return {includeIds:taskId==null?[]:[taskId]};}
 async report(taskId){const options=this.scope(taskId);return this.vault.exclusive(()=>this.build(undefined,options));}
 async decisionStatus(input,{source=null}={}){return this.vault.exclusive(async()=>{const state=await this.read(),r=state.receipts.find(r=>r.id===input.requestId);if(r&&r.hash!==decisionHash(input,source))throw new AppError('This focus request was used for another choice.',409);return {recorded:!!r,focus:await this.build(state)};});}
 async build(state,{includeIds=[]}={}){
  state??=await this.read();const now=this.now(),date=localDay(now),timezone=this.timezone(),key=timezone+'|'+date,choices=state.days[key]?.choices||{};
  const tasks=await this.vault.tasks(),graph=taskGraph(tasks),execution=await this.taskWorkflows?.summary({includeResults:true})||[],history=await this.history.read();
  const planned=new Map(savedPlanEvents(history,date,now).map(e=>[e.taskId,e]));
  const latest=new Map();for(const e of history?.events||[])if(uuid(e.taskId)&&e.decision?.kind==='weekly_review'&&e.decision.proposalId&&e.after&&['aurora_save','recovered_save'].includes(e.source)&&new Date(e.recordedAt)<=now)latest.set(e.taskId,e);
  const recentFrom=new Date(now);recentFrom.setDate(recentFrom.getDate()-13);const recentDate=localDay(recentFrom);
  const groups=new Map();for(const t of tasks)if(uuid(t.id)){if(!groups.has(t.id))groups.set(t.id,[]);groups.get(t.id).push(t);}
  // A dated reconsideration is an invitation from that date, never an automatic focus selection.
  const prior=new Map();for(const d of Object.values(state.days).filter(d=>d.timezone===timezone&&d.date<date).sort((a,b)=>a.date.localeCompare(b.date)))for(const [id,c] of Object.entries(d.choices))prior.set(id,{...c,date:d.date});
  reviewInvitations(state,date,timezone,prior);
  const ids=new Set([...groups.keys(),...Object.keys(choices),...latest.keys(),...planned.keys(),...prior.keys(),...includeIds]),rows=[];
  for(const id of ids){const matches=groups.get(id)||[],task=matches.length===1?matches[0]:null,choice=choices[id]||null,event=latest.get(id),deferred=prior.get(id),reconsider=deferred?.action==='later'&&deferred.until<=date?deferred:null;
   const recent=event&&localDay(new Date(event.recordedAt))>=recentDate;
   if(!includeIds.includes(id)&&!choice&&!reconsider&&!planned.has(id)&&!matches.some(t=>!t.done&&(t.planDate===date||t.due&&t.due<=date))&&!(recent&&!task?.done))continue;
   const identityIssue=matches.length>1?'Duplicate task ID; repair the notes before choosing focus.':!task?'Task is missing from active notes.':task.scheduleError?'Task metadata needs repair.':null;
   const links=identityIssue?[]:execution.filter(e=>e.taskId===id),dependencyReasons=task?graph.states.get(taskRef(task))?.reasons||[]:[];
   const contextRevision=hash([taskSnapshot(task),identityIssue,dependencyReasons,links.map(e=>[e.id,e.executionRevision]).sort(),weeklySnapshot(event),...(planned.has(id)?[planChoice(planned.get(id))]:[])]);
   const changed=!!choice&&choice.contextRevision!==contextRevision,attention=links.find(e=>e.attention),running=links.find(e=>['running','planning','queued'].includes(e.status));
   const readiness=identityIssue?'unavailable':task.done?'complete':changed?'review':attention?'decision':dependencyReasons.length?'blocked':running?'working':'ready';
   const detail=identityIssue|| (task.done?'Marked complete in the planner.':changed?'Task, saved planning decision or current attempt changed since this focus choice. Compare it before continuing.':attention?attention.detail||attention.attention.label||'A current attempt needs your decision.':dependencyReasons.length?dependencyReasons.join('; '):running?'A linked attempt is active.':'No recorded prerequisite or attempt decision blocks this task. This does not verify its outcome.');
   rows.push({taskId:id,text:task?.text||choice?.task?.text||event?.after.text||deferred?.task?.text||planned.get(id)?.after.text||'Unavailable task',task:taskSnapshot(task),choice,dayPlan:planChoice(planned.get(id)),weekly:weeklySnapshot(event),reconsider,identityIssue,contextRevision,changed,readiness,detail,execution:links,dependencyReasons});
  }
  for(const row of rows)row.schedulingIssue=focusSchedulingIssue(row);
  const order={focus:0,later:2,off:3};rows.sort((a,b)=>(order[a.choice?.action]??1)-(order[b.choice?.action]??1)||(a.task?.startTime||'99:99').localeCompare(b.task?.startTime||'99:99')||a.text.localeCompare(b.text));
  const focused=rows.filter(r=>r.choice?.action==='focus'&&r.readiness!=='complete');
  const first=focused.find(r=>['review','unavailable','decision'].includes(r.readiness))||focused.find(r=>r.readiness==='ready')||focused[0];
  return {date,timezone,revision:hash(state),generatedAt:now.toISOString(),rows,reviewDays:reviewDays(state,date,timezone),counts:{focused:focused.length,ready:focused.filter(r=>r.readiness==='ready').length,review:focused.filter(r=>['review','unavailable','decision','blocked'].includes(r.readiness)).length},next:first?{taskId:first.taskId,text:first.text,readiness:first.readiness,detail:first.detail,linkId:first.execution.find(e=>e.attention)?.id||null}:null,warnings:[...(tasks.some(t=>!uuid(t.id))?['Some tasks have no valid stable ID. Repair their metadata before choosing focus.']:[]),...(history?.pending?['A task save is awaiting history reconciliation. Only recorded saved decisions are shown.']:[])]};
 }
 async openExecution({date,timezone,revision,taskId,contextRevision}){return this.vault.exclusive(async()=>{
  const r=await this.build(),row=r.rows.find(r=>r.taskId===taskId);
  if(date!==r.date||timezone!==r.timezone||revision!==r.revision||!row||row.contextRevision!==contextRevision||row.choice?.action!=='focus')throw new AppError('Daily focus or task changed. Reload focus before opening execution.',409);
  if(row.identityIssue||row.execution.length>1)throw new AppError('Repair the task identity or execution links first.',409);
  if(row.execution.length)return this.taskWorkflows.read(row.execution[0].id);
  if(row.readiness!=='ready')throw new AppError('Review the current task and resolve its blockers before preparing an execution draft.',409);
  const task=await this.taskWorkflows.current(taskId,{open:true,ready:true});
  if(task.path!==row.task.path||taskSignature(task)!==taskSignature(row.task))throw new AppError('The planner task changed. Reload focus before preparing a draft.',409);
  return this.taskWorkflows.draft({task});
 });}
 async decide(input,{source=null,verifySource=async()=>{},includeIds=[]}={}){return this.vault.exclusive(async()=>{
  const {requestId,date,timezone,revision,taskId,contextRevision,action,until=null}=input;
  if(!uuid(requestId)||!uuid(taskId)||!['focus','later','off','clear'].includes(action)||typeof revision!=='string'||typeof contextRevision!=='string')throw new AppError('Choose a current task and a valid focus action.');
  const requestHash=decisionHash(input,source),state=await this.read(),receipt=state.receipts.find(r=>r.id===requestId);
  if(receipt){if(receipt.hash!==requestHash)throw new AppError('This focus request was already used for another choice.',409);return {...await this.build(state,{includeIds}),alreadySaved:true};}
  await verifySource();const report=await this.build(state,{includeIds}),row=report.rows.find(r=>r.taskId===taskId);
  if(date!==report.date||timezone!==report.timezone)throw new AppError('The day or timezone changed. Reload today’s focus.',409);
  if(revision!==report.revision||!row||contextRevision!==row.contextRevision)throw new AppError('Focus, task or execution changed. Reload and compare the current details before choosing again.',409);
  if(['focus','later'].includes(action)&&(row.identityIssue||row.task?.done))throw new AppError('Choose a unique, valid, unfinished task.');
  if(action==='later'&&(!validDate(until)||until<=date))throw new AppError('Choose a later reconsideration date.');
  const key=timezone+'|'+date;state.days[key]??={date,timezone,choices:{}};
  if(action==='clear')delete state.days[key].choices[taskId];else state.days[key].choices[taskId]={action,until:action==='later'?until:null,at:this.now().toISOString(),contextRevision:row.contextRevision,task:row.task,...(source?{source}:{})};
  state.receipts.push({id:requestId,hash:requestHash});state.receipts=state.receipts.slice(-200);
  // Recheck at the durable replacement boundary. External Markdown edits and workflow
  // progress can still occur while the focus file is being written.
  await atomic(this.path,JSON.stringify(state,null,2),{beforeCommit:async()=>{await verifySource();const fresh=await this.build(undefined,{includeIds});if(fresh.date!==date||fresh.timezone!==timezone||fresh.revision!==revision||fresh.rows.find(r=>r.taskId===taskId)?.contextRevision!==contextRevision)throw new AppError('Focus, task or execution changed before saving. Reload today’s focus.',409);}});
  await atomic(this.marker,JSON.stringify({version:1}));return this.build(state,{includeIds});
 });}
}
