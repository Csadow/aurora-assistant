import {atomic,AppError,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {localDay} from '../mobile/web/planner-core.js';
import {taskGraph,taskRef} from '../mobile/web/task-links.js';

export const focusHash=value=>sha(JSON.stringify(value??null));
export const focusSnapshot=t=>t?Object.fromEntries(['id','path','text','done','planDate','startTime','duration','due','remindAt','priority','project','parent','dependsOn','scheduleError'].map(k=>[k,t[k]??null])):null;
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);

export function validFocusReviews(state){
 if(state.reviews===undefined)return true;
 if(!object(state.reviews))return false;
 return Object.entries(state.reviews).every(([key,day])=>object(day)&&validDate(day.date)&&typeof day.timezone==='string'&&key===day.timezone+'|'+day.date&&object(day.decisions)&&Object.entries(day.decisions).every(([id,r])=>uuid(id)&&object(r)&&['reviewed','reconsider'].includes(r.action)&&typeof r.choiceRevision==='string'&&typeof r.contextRevision==='string'&&typeof r.at==='string'&&Number.isFinite(Date.parse(r.at))&&validDate(r.decidedOn)&&r.decidedOn>=day.date&&(r.action==='reconsider'?validDate(r.until)&&r.until>r.decidedOn:r.until===null)));
}
export function reviewDays(state,today,timezone){
 return Object.entries(state.days).filter(([,d])=>d.timezone===timezone&&d.date<=today).map(([key,d])=>{
  const choices=Object.entries(d.choices).filter(([,c])=>c.action==='focus'),decisions=state.reviews?.[key]?.decisions||{};
  return {date:d.date,total:choices.length,pending:choices.filter(([id,c])=>decisions[id]?.choiceRevision!==focusHash(c)).length};
 }).filter(d=>d.total).sort((a,b)=>a.date.localeCompare(b.date));
}
// Review reminders compete with later explicit daily choices, never with task dates.
export function reviewInvitations(state,today,timezone,prior){
 for(const d of Object.values(state.reviews||{}).filter(d=>d.timezone===timezone))for(const [id,r] of Object.entries(d.decisions)){
  if(r.action!=='reconsider'||r.decidedOn>=today||r.choiceRevision!==focusHash(state.days[timezone+'|'+d.date]?.choices[id]))continue;
  const previous=prior.get(id);
  if(!previous||r.at>previous.at||r.at===previous.at&&previous.date===d.date&&focusHash(state.days[timezone+'|'+d.date]?.choices[id])===r.choiceRevision)prior.set(id,{action:'later',until:r.until,at:r.at,date:r.decidedOn,reviewDate:d.date,task:r.task});
 }
}
export async function buildFocusReview(focus,date,state){
 state??=await focus.read();const today=localDay(focus.now()),timezone=focus.timezone();date??=today;
 if(!validDate(date)||date>today)throw new AppError('Choose today or an earlier focus review date.');
 const key=timezone+'|'+date,choices=state.days[key]?.choices||{},decisions=state.reviews?.[key]?.decisions||{},tasks=await focus.vault.tasks(),graph=taskGraph(tasks),execution=await focus.taskWorkflows?.summary({includeResults:true})||[];
 const rows=Object.entries(choices).filter(([,c])=>c.action==='focus').map(([taskId,intention])=>{
  const matches=tasks.filter(t=>t.id===taskId),task=matches.length===1?matches[0]:null;
  const identityIssue=matches.length>1?'Duplicate task ID; repair the notes before planning.':!task?'Task is missing from active notes.':task.scheduleError?'Task metadata needs repair.':null;
  const links=identityIssue?[]:execution.filter(e=>e.taskId===taskId),dependencyReasons=task?graph.states.get(taskRef(task))?.reasons||[]:[],choiceRevision=focusHash(intention),current=focusSnapshot(task);
  const contextRevision=focusHash([choiceRevision,current,identityIssue,dependencyReasons,links.map(e=>[e.id,e.executionRevision]).sort()]);
  const decision=decisions[taskId]?.choiceRevision===choiceRevision?decisions[taskId]:null;
  return {taskId,text:task?.text||intention.task?.text||'Unavailable task',intention,choiceRevision,task:current,identityIssue,execution:links,dependencyReasons,contextRevision,decision,changed:focusHash(intention.task)!==focusHash(current)};
 });
 return {date,today,timezone,revision:focusHash(state),rows,days:reviewDays(state,today,timezone),pending:rows.filter(r=>!r.decision).length};
}
export async function decideFocusReview(focus,input){return focus.vault.exclusive(async()=>{
 const {requestId,date,today,timezone,revision,taskId,contextRevision,action,until=null}=input;
 if(!uuid(requestId)||!uuid(taskId)||!['reviewed','reconsider'].includes(action)||typeof revision!=='string'||typeof contextRevision!=='string')throw new AppError('Choose a valid focus review decision.');
 const requestHash=focusHash({kind:'focus_review',date,today,timezone,revision,taskId,contextRevision,action,until}),state=await focus.read(),receipt=state.receipts.find(r=>r.id===requestId);
 if(receipt){if(receipt.hash!==requestHash)throw new AppError('This request was already used for another choice.',409);return {...await buildFocusReview(focus,date,state),alreadySaved:true};}
 const report=await buildFocusReview(focus,date,state),row=report.rows.find(r=>r.taskId===taskId);
 if(today!==report.today||timezone!==report.timezone||revision!==report.revision||!row||contextRevision!==row.contextRevision)throw new AppError('Focus, task, attempt, day or timezone changed. Reload the evening review before deciding.',409);
 if(action==='reconsider'&&(row.identityIssue||row.task?.done||!validDate(until)||until<=today))throw new AppError('Choose a future reconsideration date for a unique, valid, unfinished task.');
 const key=timezone+'|'+date;state.reviews??={};state.reviews[key]??={date,timezone,decisions:{}};
 state.reviews[key].decisions[taskId]={action,until:action==='reconsider'?until:null,at:focus.now().toISOString(),decidedOn:today,choiceRevision:row.choiceRevision,contextRevision,task:row.task};
 state.receipts.push({id:requestId,hash:requestHash});state.receipts=state.receipts.slice(-200);
 try{await atomic(focus.path,JSON.stringify(state,null,2),{beforeCommit:async()=>{
  const fresh=await buildFocusReview(focus,date);
  if(fresh.today!==today||fresh.timezone!==timezone||fresh.revision!==revision||fresh.rows.find(r=>r.taskId===taskId)?.contextRevision!==contextRevision)throw new AppError('Focus, task or attempt changed before saving. Reload the evening review.',409);
 }});
 await atomic(focus.marker,JSON.stringify({version:1}));return await buildFocusReview(focus,date,state);
 }catch(e){if(e.status)throw e;throw new AppError('The review decision could not be confirmed. It may already be saved; retry the same request before making another choice.',503);}
});}

export async function verifyReviewFocus(planner,proposal){
 const changes=proposal.changes.filter(c=>c.focusChoice&&!proposal.saved.includes(c.before.path));if(!changes.length)return;
 const state=await planner.dailyFocus.read(),choices=state.days[proposal.timezone+'|'+proposal.reviewDate]?.choices||{};
 for(const c of changes)if(focusHash(choices[c.before.id])!==c.focusChoice)throw new AppError('The reviewed focus intention changed. Prepare a fresh evening review.',409);
}
