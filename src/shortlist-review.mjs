import {AppError,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {nextDayReport} from './next-day-planning.mjs';
import {savedPlanEvents,planChoice} from './saved-day-plans.mjs';
import {focusHash,focusSnapshot} from './focus-review.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function shortlistReviewOptions(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||!validDate(input.date)||!Array.isArray(input.selectedIds)||input.selectedIds.length>10||input.selectedIds.some(id=>!uuid(id))||new Set(input.selectedIds).size!==input.selectedIds.length)throw new AppError('Choose a valid shortlist date and up to ten unique task IDs.');
 return {date:input.date,selectedIds:input.selectedIds};
}

// Read evidence only: a proposal, saved-path marker or current reservation alone
// cannot establish a recorded day-plan save. History reconciliation stays explicit.
export async function shortlistReview(planner,input){
 const {date,selectedIds}=shortlistReviewOptions(input);
 return planner.vault.exclusive(async()=>{
  const planning=await nextDayReport(planner,date),warnings=[...planning.warnings];
  let history=null,proposals=[],historyAvailable=true,proposalsAvailable=true,calendar,calendarAvailable=true;
  try{history=await planner.dailyFocus.history.read();}catch(e){historyAvailable=false;warnings.push('Saved-plan history unavailable: '+e.message);}
  try{proposals=await planner.store.list('proposals');}catch(e){proposalsAvailable=false;warnings.push('Planning reviews unavailable: '+e.message);}
  try{calendar=await planner.calendar?.context();planner.calendarReady(calendar,[date]);}catch{calendarAvailable=false;warnings.push('Calendar comparison unavailable for this date. Refresh Calendar before preparing new times.');}
  if(history?.pending)warnings.push('A task save awaits history reconciliation. A current time slot alone does not confirm a recorded plan save.');
  const events=savedPlanEvents(history,date,planner.now()),plans=proposals.filter(p=>p.kind==='future_schedule').sort((a,b)=>String(a.created).localeCompare(String(b.created))||a.id.localeCompare(b.id));
  const calendarRevision=calendarAvailable?(calendar?.revision||'off'):null;
  const rows=selectedIds.map(taskId=>{
   const current=planning.rows.find(r=>r.taskId===taskId)||{taskId,task:null,text:'Task unavailable',contextRevision:null,issue:'Task is missing or archived. This does not establish completion.'};
   const event=events.filter(e=>e.taskId===taskId).at(-1),receipt=planChoice(event);
   const p=plans.filter(p=>p.targetDate===date&&(p.changes?.some(c=>c.before.id===taskId)||p.held?.some(h=>h.taskId===taskId))).at(-1);
   const held=p?.held?.find(h=>h.taskId===taskId),change=p?.changes?.find(c=>c.before.id===taskId);
   const pending=plans.filter(p=>p.status==='pending'&&p.changes?.some(c=>c.before.id===taskId)&&!savedPlanEvents(history,p.targetDate,planner.now()).some(e=>e.taskId===taskId&&e.decision.proposalId===p.id)).at(-1);
   const preview=p?{id:p.id,status:p.status,created:p.created,kind:held?'held':'proposed',reason:held?.reason||null,task:focusSnapshot(held?.task||change?.before),proposed:focusSnapshot(change?.after),contextChanged:focusHash(focusSnapshot(held?.task||change?.before))!==focusHash(current.task),calendar:!calendarAvailable||!p.calendarRevision?'unavailable':p.calendarRevision===calendarRevision?'same':'changed'}:null;
   const placement=!current.task?'unavailable':current.task.done?'complete':current.task.planDate===date&&current.task.startTime?'scheduled':receipt?'changed':held?'held':p?'preview':'unplanned';
   return {...current,placement,receipt,receiptChanged:!!receipt&&focusHash(receipt.task)!==focusHash(current.task),preview,pendingReview:pending?.id||null};
  });
  const report={date,today:planning.today,timezone:planning.timezone,rows,warnings,historyAvailable,historyPending:!!history?.pending,proposalsAvailable,calendarRevision};
  return {...report,revision:sha(JSON.stringify(report))};
 });
}
