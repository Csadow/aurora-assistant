import {AppError} from './vault.mjs';
import {localDay,minutes} from '../mobile/web/planner-core.js';
import {validDate} from './task-meta.mjs';
import {focusSnapshot,focusHash} from './focus-review.mjs';
import {sourceCandidate} from './task-details.mjs';
import {validateReminderDecision} from './reminder-plans.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const taskOK=t=>t&&uuid(t.id)&&typeof t.text==='string'&&typeof t.path==='string'&&typeof t.done==='boolean'&&Number.isInteger(t.duration)&&t.duration>=5&&t.duration<=720&&(!t.planDate||validDate(t.planDate))&&(!t.startTime||/^([01]\d|2[0-3]):[0-5]\d$/.test(t.startTime));
const visible=(v,now)=>Number.isFinite(Date.parse(v.created))&&new Date(v.created)<=now;
const groups=['attention','planning','scheduled','history'];

// Navigation only: source reads stay bounded as the review count grows. No
// reconciliation, Calendar refresh, mutation, planning assessment or read cache.
export function reminderOverview(planner,input={}){return planner.vault.exclusive(()=>build(planner,input));}
async function build(p,{group='active',offset=0,brief=false}={}){
 if(!['all','active',...groups].includes(group)||!Number.isInteger(offset)||offset<0||offset>100000||typeof brief!=='boolean')throw new AppError('Choose a valid reminder follow-through list.');
 const now=p.now(),today=localDay(now),warnings=[],sources={decisions:true,reminders:true,proposals:true,tasks:true,history:true,steps:true,execution:true};
 const read=async(name,fn)=>{try{return await fn();}catch(e){sources[name]=false;warnings.push(name+': '+e.message);return null;}};
 const stored=await read('decisions',()=>p.store.list('workload-reminder-decisions'));
 const decisions=[];for(const d of stored||[])try{const valid=validateReminderDecision(d);if(decisions.some(x=>x.id===valid.id))throw Error('Duplicate reminder review identity.');if(visible(valid,now))decisions.push(valid);}catch(e){sources.decisions=false;warnings.push(e.message);}
 const proposals=await read('proposals',()=>p.store.list('proposals'));
 const related=(proposals||[]).filter(v=>v.kind==='future_schedule'&&v.origin==='workload-next'&&v.reminderDecision&&(!Number.isFinite(Date.parse(v.created))||visible(v,now)));
 // A lost review record must not hide a proposal which still references it.
 const candidates=[...decisions];for(const plan of related)if(uuid(plan.reminderDecision.id)&&!candidates.some(d=>d.id===plan.reminderDecision.id)){
  const before=plan.changes?.[0]?.before||plan.held?.[0]?.task;
  candidates.push({id:plan.reminderDecision.id,orphan:true,taskId:taskOK(before)?before.id:null,task:taskOK(before)?focusSnapshot(before):null,proposalId:plan.workloadFrom?.proposalId||null,reviewedOn:null,created:Number.isFinite(Date.parse(plan.created))?plan.created:now.toISOString(),reminderId:null});
 }
 // An empty list need not load tasks, steps or execution; sources not read are null.
 if(!candidates.length){for(const key of ['reminders','tasks','history','steps','execution'])sources[key]=null;return {today,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,generatedAt:now.toISOString(),group,offset,limit:brief?3:12,total:0,counts:Object.fromEntries(groups.map(g=>[g,0])),rows:[],sources,complete:sources.decisions&&sources.proposals,warnings:[...new Set(warnings)]};}
 const reminders=await read('reminders',()=>p.workloadRevisits.read()),tasks=await read('tasks',async()=>(await p.vault.tasks()).map(sourceCandidate)),history=await read('history',()=>p.dailyFocus.history.read()),steps=await read('steps',()=>p.firstSteps.read()),execution=await read('execution',()=>p.execution());
 const rows=candidates.map(d=>{
  const issues=[],entry=reminders?.entries.find(e=>e.id===d.reminderId),original=proposals?.find(v=>v.id===d.proposalId),matches=tasks?.filter(t=>t.id===d.taskId)||[];
  const current=matches.length===1&&!matches[0].scheduleError?focusSnapshot(matches[0]):null;
  if(d.orphan)issues.push('The recorded task review is missing or unreadable. Its referenced plan remains available.');
  if(!entry)issues.push(sources.reminders?'The original reminder is missing. Its review and plans are retained.':'Saved reminders are unavailable.');
  if(!original)issues.push('The original workload is unavailable.');
  if(!current)issues.push(!sources.tasks?'Current tasks unavailable.':matches.length>1?'Duplicate task identity; completion is unknown.':matches[0]?.scheduleError?'Task metadata needs repair.':'Task missing from active notes; completion is unknown.');
  const linked=related.filter(v=>v.reminderDecision.id===d.id);
  const plans=linked.map(v=>{
   const member=v.changes?.find(c=>c.before?.id===d.taskId),held=v.held?.find(h=>h.taskId===d.taskId);
   const valid=uuid(v.id)&&visible(v,now)&&!d.orphan&&v.reminderDecision.revision===d.revision&&v.workloadFrom?.proposalId===d.proposalId&&v.workloadFrom?.revision===d.workloadFrom?.revision&&validDate(v.targetDate)&&['pending','accepted','dismissed'].includes(v.status)&&Array.isArray(v.changes)&&Array.isArray(v.held)&&v.changes.length+v.held.length===1&&(member?taskOK(member.before)&&taskOK(member.after)&&member.after.id===d.taskId:held&&taskOK(held.task)&&held.task.id===d.taskId);
   if(!valid)issues.push('A linked proposal cannot be matched to this reviewed task; its result is unknown.');
   const receipts=valid&&history?history.events.filter(e=>e.decision?.kind==='future_schedule'&&e.decision.proposalId===v.id&&e.taskId===d.taskId&&taskOK(e.after)&&e.after.id===d.taskId&&['aurora_save','recovered_save'].includes(e.source)&&Number.isFinite(Date.parse(e.recordedAt))&&new Date(e.recordedAt)<=now):[];
   return {id:v.id,date:validDate(v.targetDate)?v.targetDate:null,status:v.status,valid,proposed:member&&taskOK(member.after)?focusSnapshot(member.after):null,recorded:history&&valid?receipts.length:null,receipts,pending:history?.pending?.decision?.proposalId===v.id};
  });
  const receipts=plans.flatMap(v=>v.receipts).sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)),latest=receipts.at(-1)||null,pending=plans.some(v=>v.pending);
  if(!sources.history||!history)issues.push('Recorded saves are unavailable; placement is unknown.');
  if(pending)issues.push('A linked save awaits history reconciliation. Opening this view will not retry it.');
  const reservationActive=!!current?.startTime&&(current.planDate>today||current.planDate===today&&minutes(current.startTime)+current.duration>now.getHours()*60+now.getMinutes());
  const slotMatches=!!latest?.after.startTime&&current?.planDate===latest.after.planDate&&current?.startTime===latest.after.startTime&&current?.duration===latest.after.duration;
  const state=current?.done?'completed':issues.length||!sources.proposals?'unknown':slotMatches?'scheduled':latest?'changed':plans.some(v=>v.status==='pending')?'preview':'reviewed';
  const category=state==='completed'||entry?.status==='dismissed'?'history':['unknown','changed'].includes(state)||state==='scheduled'&&!reservationActive?'attention':state==='scheduled'?'scheduled':'planning';
  const card=steps?.cards[d.taskId],links=current?(execution||[]).filter(e=>e.taskId===d.taskId&&uuid(e.id)):[];
  return {id:d.id,reminderId:d.reminderId,taskId:d.taskId,text:current?.text||d.task?.text||'Unavailable reviewed task',reviewedOn:d.reviewedOn,created:d.created,review:d.review||null,source:{proposalId:d.proposalId,title:entry?.source.title||original?.title||'Unavailable original workload',date:entry?.source.date||null,available:!!original},reminder:entry?{id:entry.id,status:entry.status,targetDate:entry.targetDate,timezone:entry.timezone}:null,canOpenReminder:!d.orphan&&!!entry,state,group:category,reservationActive,current,reviewedTask:d.task,latest:latest?{after:focusSnapshot(latest.after),recordedAt:latest.recordedAt,source:latest.source}:null,plans:plans.map(({receipts,...v})=>v),step:card?{text:card.text,mode:card.mode,date:card.context.date,changed:focusHash(card.context.task)!==focusHash(current)}:null,execution:links.map(e=>({id:e.id,workflowId:e.workflowId||null,detail:e.detail,status:e.status})),issues};
 });
 rows.sort((a,b)=>groups.indexOf(a.group)-groups.indexOf(b.group)||String(a.reminder?.targetDate||a.reviewedOn||'').localeCompare(String(b.reminder?.targetDate||b.reviewedOn||''))||a.created.localeCompare(b.created)||a.id.localeCompare(b.id));
 const counts=Object.fromEntries(groups.map(g=>[g,rows.filter(r=>r.group===g).length])),filtered=rows.filter(r=>group==='all'||group==='active'&&r.group!=='history'||r.group===group),limit=brief?3:12;
 if(localDay(p.now())!==today)warnings.push('The day changed while loading. Refresh before continuing.');
 return {today,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,generatedAt:now.toISOString(),group,offset,limit,total:filtered.length,counts,rows:filtered.slice(offset,offset+limit),sources,complete:Object.values(sources).every(Boolean),warnings:[...new Set(warnings)]};
}
