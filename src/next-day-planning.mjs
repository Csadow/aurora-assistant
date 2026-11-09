import {reminderDecision} from './reminder-plans.mjs';
import {workloadFrom,verifyWorkloadFrom} from './workload-next.mjs';
import {validateWorkloadSource} from './workload-follow.mjs';
import {AppError,sha} from './vault.mjs';
import {validDate,tasksIn} from './task-meta.mjs';
import {localDay,minutes} from '../mobile/web/planner-core.js';
import {taskGraph,taskRef} from '../mobile/web/task-links.js';
import {focusSnapshot} from './focus-review.mjs';
import {outcomePlanningRows} from './outcome-planning.mjs';

const hash=value=>sha(JSON.stringify(value));
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const zone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
export async function nextDayReport(planner,date,snapshot={}){
 const now=snapshot.now||planner.now(),today=localDay(now),tomorrow=new Date(now);tomorrow.setDate(tomorrow.getDate()+1);date??=localDay(tomorrow);
 if(!validDate(date))throw new AppError('Choose a valid planning date.');
 const tasks=snapshot.tasks||await planner.vault.tasks(),graph=taskGraph(tasks),execution=snapshot.execution||await planner.execution(),groups=new Map();
 for(const t of tasks)if(uuid(t.id)){if(!groups.has(t.id))groups.set(t.id,[]);groups.get(t.id).push(t);}
 const rows=[...groups].map(([taskId,matches])=>{
  const t=matches.length===1?matches[0]:null,links=t?execution.filter(e=>e.taskId===taskId):[],dependencyReasons=t?graph.states.get(taskRef(t))?.reasons||[]:[];
  const futureBlock=!t?.scheduleError&&t?.startTime&&(t.planDate>today||t.planDate===today&&minutes(t.startTime)+t.duration>now.getHours()*60+now.getMinutes());
  const issue=!t?'Duplicate task ID; repair the notes first.':t.scheduleError?'Task metadata needs repair.':t.done?'Task is marked complete.':futureBlock?'Existing timed commitment stays fixed.':t.planDate>today&&t.planDate!==date?'Already planned for another future day.':links.some(e=>e.attention)?'Review the current execution decision first.':links.some(e=>['running','queued','planning'].includes(e.status))?'A linked attempt is active.':dependencyReasons.length?dependencyReasons.join('; '):null;
  const task=focusSnapshot(t),contextRevision=hash([task,issue,dependencyReasons,links.map(e=>[e.id,e.executionRevision]).sort()]);
  return {taskId,text:t?.text||matches[0].text,task,contextRevision,issue,execution:links,dependencyReasons};
 });
 return {date,today,timezone:zone(),rows,warnings:tasks.some(t=>!uuid(t.id))?['Some tasks have no valid stable ID. Repair their metadata before selecting them.']:[]};
}
export async function verifyNextDay(planner,p){
 if(p.workloadFrom)await verifyWorkloadFrom(planner,p.workloadFrom,p.changes.filter(c=>!p.saved.includes(c.before.path)).map(c=>({taskId:c.before.id})));
 const remaining=p.changes.filter(c=>!p.saved.includes(c.before.path));
 if(p.reminderDecision&&remaining.length)await planner.reminderPlans.verify(p.reminderDecision,remaining.map(c=>({taskId:c.before.id})),p.workloadFrom,p);
 const r=await nextDayReport(planner,p.targetDate);
 if(r.today!==p.date||r.timezone!==p.timezone||r.date<r.today)throw new AppError('The day or timezone changed. Prepare a fresh day preview.',409);
 for(const c of p.changes.filter(c=>!p.saved.includes(c.before.path))){const row=r.rows.find(r=>r.taskId===c.before.id);if(!row||row.issue||row.contextRevision!==c.planContext)throw new AppError('A selected task or current attempt changed. Reopen the planning draft and compare current details.',409);}
 if(p.outcomeSources){
  const current=await outcomePlanningRows(planner,r);
  for(const c of p.changes.filter(c=>!p.saved.includes(c.before.path))){const source=p.outcomeSources.find(s=>s.taskId===c.before.id),row=current.rows.find(r=>r.taskId===c.before.id);if(!source||!row||row.contextRevision!==source.revision)throw new AppError('An outcome, step or project changed. Reopen the unfinished-step draft and compare its sources.',409);}
 }
}
export async function previewNextDay(planner,input,fingerprint){
 const {requestId,date,today,timezone,selected,start='09:00',end='18:00',gap=10}=input;
 if(!uuid(requestId))throw new AppError('Use a valid planning request.');
 if(input.outcomeMode!==undefined&&input.outcomeMode!==true)throw new AppError('Choose a valid planning source.');
 if(input.origin!==undefined&&!['week-capacity','week-workload','workload-next'].includes(input.origin))throw new AppError('Choose a valid planning origin.');
 if(input.workloadSource!==undefined&&(input.origin!=='week-workload'||input.outcomeMode))throw new AppError('Choose the workload planning source.');
 if((input.origin==='workload-next')!==(input.workloadFrom!==undefined)||input.workloadFrom!==undefined&&input.outcomeMode)throw new AppError('Choose the source workload for this new comparison.');
 if(input.reminderDecision!==undefined&&input.origin!=='workload-next')throw new AppError('Choose the source workload for this reminder decision.');
 const reminder=input.reminderDecision===undefined?null:reminderDecision(input.reminderDecision);
 const from=input.workloadFrom===undefined?null:workloadFrom(input.workloadFrom);
 const workloadSource=input.workloadSource===undefined?null:validateWorkloadSource(input.workloadSource,selected);
 const requestHash=hash({date,today,timezone,selected,start,end,gap,...(from?{workloadFrom:from}:{}),...(reminder?{reminderDecision:reminder}:{}),...(workloadSource?{workloadSource}:{}),...(input.origin?{origin:input.origin}:{}),...(input.outcomeMode?{outcomeMode:true}:{})});
 const previous=async()=>{let p;try{p=await planner.store.get('proposals',requestId);}catch(e){if(e.status===404)return null;throw e;}
  if(p.kind!=='future_schedule'||p.requestHash!==requestHash)throw new AppError('This request was already used for another preview.',409);return planner.public(p);
 };
 const saved=await previous();if(saved)return saved;
 if(from)await verifyWorkloadFrom(planner,from,selected);
 if(reminder)await planner.reminderPlans.verify(reminder,selected,from);
 try{if(minutes(end)<=minutes(start))throw Error('Finish time must be after the start time.');if(!Number.isInteger(gap)||gap<0||gap>120)throw Error('Breaks must be between 0 and 120 minutes.');}catch(e){throw new AppError(e.message);}
 const base=await nextDayReport(planner,date),report=input.outcomeMode?await outcomePlanningRows(planner,base):base;
 if(date!==report.date||today!==report.today||timezone!==report.timezone||date<today)throw new AppError('The planning date, current day or timezone changed. Reload the draft.',409);
 if(!Array.isArray(selected)||!selected.length||selected.length>100||selected.some(s=>!s||!uuid(s.taskId)||typeof s.contextRevision!=='string')||new Set(selected.map(s=>s.taskId)).size!==selected.length)throw new AppError('Select up to 100 unique tasks to plan.');
 const notes=await planner.vault.list(),tasks=tasksIn(notes),changes=[];
 for(const s of selected){const row=report.rows.find(r=>r.taskId===s.taskId),matches=tasks.filter(t=>t.id===s.taskId);
  if(!row||row.contextRevision!==s.contextRevision||matches.length!==1||hash(focusSnapshot(matches[0]))!==hash(row.task))throw new AppError('A selected task changed. Reload the draft.',409);
  if(row.issue)throw new AppError(row.text+': '+row.issue,409);
  const before=matches[0];changes.push({before,after:{...before,planDate:date,startTime:null},action:'schedule_future',execution:row.execution,planContext:row.planContext||row.contextRevision});
 }
 const planning=await planner.planReviewTimes({notes,tasks,changes,reserveTimes:true,start,end,gap,keepUnplaced:true});
 const held=changes.filter(c=>c.unplaced).map(c=>({taskId:c.before.id,text:c.before.text,reason:c.unplacedReason||'No available slot; existing schedule kept.',task:c.before}));
 const p={id:requestId,status:'pending',created:new Date().toISOString(),kind:'future_schedule',...(from?{workloadFrom:from}:{}),...(reminder?{reminderDecision:reminder}:{}),...(workloadSource?{workloadSource}:{}),...(input.origin?{origin:input.origin}:{}),title:'Day plan · '+date,date:today,targetDate:date,timezone,requestHash,changes:changes.filter(c=>!c.unplaced),held,...planning,...(input.outcomeMode?{outcomeSources:selected.map(s=>report.rows.find(r=>r.taskId===s.taskId).source)}:{}),reserveTimes:true,contextHash:fingerprint(notes),saved:[],intents:[]};
 return planner.vault.exclusive(async()=>{
  const existing=await previous();if(existing)return existing;
  // Check held selections too: do not show stale estimates or reasons in a new preview.
  await verifyNextDay(planner,{...p,changes});
  if(fingerprint(await planner.vault.list())!==p.contextHash)throw new AppError('Tasks or classes changed while preparing the preview. Try again.',409);
  try{return planner.public(await planner.store.put('proposals',p));}
  catch(e){if(e.status)throw e;throw new AppError('The preview could not be confirmed. It may already be saved; reopen this draft to retry the same request.',503);}
 });
}
