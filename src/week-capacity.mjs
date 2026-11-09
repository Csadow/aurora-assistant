import {AppError,sha} from './vault.mjs';
import {tasksIn,validDate} from './task-meta.mjs';
import {localDay,minutes} from '../mobile/web/planner-core.js';
import {nextDayReport} from './next-day-planning.mjs';

const hash=value=>sha(JSON.stringify(value));
const zone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
async function snapshot(planner){const now=planner.now(),notes=await planner.vault.list(),execution=await planner.execution();return {now,notes,tasks:tasksIn(notes),execution};}
async function candidates(planner,date,state){
 date??=localDay(state.now);if(!validDate(date))throw new AppError('Choose a valid first day.');
 const dates=Array.from({length:7},(_,i)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10);});
 if(dates.some(d=>!validDate(d)))throw new AppError('Choose a week within the supported date range.');
 const reports=await Promise.all(dates.map(d=>nextDayReport(planner,d,state))),first=reports[0];
 const rows=first.rows.map(row=>{
  const days=reports.map(r=>({date:r.date,...r.rows.find(x=>x.taskId===row.taskId)})),eligible=days.filter(r=>!r.issue&&r.date>=first.today);
  return {...row,issue:eligible.length?null:row.issue||'This selection belongs to past days.',eligibleDates:eligible.map(r=>r.date),contextRevision:hash(days.map(r=>[r.date,r.contextRevision,r.issue]))};
 });
 return {report:{date,today:first.today,timezone:first.timezone,dates,rows,warnings:first.warnings},reports};
}
export async function weekCapacityReport(planner,date){return (await candidates(planner,date,await snapshot(planner))).report;}

// Both alternatives use one task/attempt snapshot, Calendar cache and clock.
async function prepare(planner,input){
 const {date,today,timezone,start='09:00',end='18:00',gap=10}=input;
 try{if(minutes(end)<=minutes(start))throw Error('Finish time must be after the start time.');if(!Number.isInteger(gap)||gap<0||gap>120)throw Error('Breaks must be between 0 and 120 minutes.');}catch(e){throw new AppError(e.message);}
 const state=await snapshot(planner),{report,reports}=await candidates(planner,date,state);
 if(date!==report.date||today!==report.today||timezone!==report.timezone)throw new AppError('The day or timezone changed. Reload the week comparison.',409);
 let calendar,calendarError;try{calendar=await planner.calendar?.context({includeLinked:true});}catch(e){calendarError=e.message;}
 return {state,report,reports,calendar,calendarError,start,end,gap};
}
function validateSelected(report,selected){
 if(!Array.isArray(selected)||selected.length>100||selected.some(s=>!s||typeof s.taskId!=='string'||typeof s.contextRevision!=='string')||new Set(selected.map(s=>s.taskId)).size!==selected.length)throw new AppError('Choose up to 100 unique tasks.');
 for(const s of selected){const r=report.rows.find(r=>r.taskId===s.taskId);if(!r||r.issue||r.contextRevision!==s.contextRevision)throw new AppError('A selected task or current attempt changed. Reload and compare your selections.',409);}
}
const missing=taskId=>({taskId,text:'Unavailable task',task:null,issue:'Task is missing or has no valid unique identity.',contextRevision:null});
const estimate=row=>row.task&&!row.task.scheduleError&&Number.isInteger(row.task.duration)?row.task.duration:null;
const totals=rows=>({selectedMinutes:rows.reduce((n,row)=>n+(estimate(row)??0),0),unknownEstimates:rows.filter(row=>estimate(row)===null).length});
async function compare(planner,context,selected,origin='week-capacity'){
 const {state,report,reports,calendar,calendarError,start,end,gap}=context,{today,timezone}=report,days=[];
 for(const r of reports){
  const chosen=selected.map(s=>r.rows.find(row=>row.taskId===s.taskId)||missing(s.taskId)),held=chosen.filter(row=>row.issue).map(row=>({taskId:row.taskId,text:row.text,reason:row.issue}));
  const eligible=chosen.filter(row=>!row.issue),changes=eligible.map(row=>{const before=state.tasks.find(t=>t.id===row.taskId);return {before,after:{...before,planDate:r.date,startTime:null}};});
  const deadlines=chosen.filter(row=>row.task?.due).map(row=>({taskId:row.taskId,text:row.text,due:row.task.due,afterDeadline:row.task.due<r.date}));
  const base={date:r.date,...totals(chosen),deadlines,held};
  try{
   if(r.date<today)throw new AppError('Past day. Choose a current or future date.');
   if(calendarError)throw new AppError('Google Calendar unavailable: '+calendarError);
   const p=await planner.planReviewTimes({notes:state.notes,tasks:state.tasks,changes,reserveTimes:true,start,end,gap,keepUnplaced:true,assessment:true,calendarSnapshot:calendar,targetDates:[r.date],now:state.now});
   const day=p.targetDays[0],unplaced=changes.filter(c=>c.unplaced).map(c=>({taskId:c.before.id,text:c.before.text,reason:c.unplacedReason}));
   days.push({...base,...day,available:true,warnings:[...new Set([...(calendar?.warnings||[]),...p.warnings])],held:[...held,...unplaced],fits:changes.filter(c=>!c.unplaced).map(c=>({taskId:c.before.id,text:c.before.text,startTime:c.after.startTime,duration:c.after.duration})),preview:{date:r.date,today,timezone,selected:eligible.map(row=>({taskId:row.taskId,contextRevision:row.contextRevision})),start,end,gap,origin}});
  }catch(e){days.push({...base,available:false,error:e.message,capacity:null,fits:[],preview:null});}
 }
 return {...report,selected,...totals(selected.map(s=>report.rows.find(r=>r.taskId===s.taskId)||missing(s.taskId))),days,generatedAt:state.now.toISOString(),calendarRevision:calendar?.revision||null};
}
async function verify(planner,{state,report}){
 const after=await snapshot(planner);
 if(localDay(after.now)!==report.today||zone()!==report.timezone||hash([state.notes,state.execution])!==hash([after.notes,after.execution]))throw new AppError('Tasks, classes, attempts or the current day changed during comparison. Reload and compare again.',409);
}
// No proposals, history reconciliation, Calendar refresh or task writes.
export async function assessWeekCapacity(planner,input){
 const context=await prepare(planner,input);validateSelected(context.report,input.selected);
 const result=await compare(planner,context,input.selected);await verify(planner,context);return result;
}
export async function assessWeekWorkload(planner,input){
 const ids=input.shortlistIds;
 if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))||new Set(ids).size!==ids.length)throw new AppError('Use up to 100 unique shortlist task IDs.');
 const context=await prepare(planner,input),{report}=context;validateSelected(report,input.selected);
 if(input.selected.some(s=>!ids.includes(s.taskId)))throw new AppError('Choose only tasks from this retained shortlist.');
 const shortlist=ids.map(id=>report.rows.find(r=>r.taskId===id)||missing(id));
 const full=await compare(planner,context,shortlist.map(r=>({taskId:r.taskId,contextRevision:r.contextRevision}))),revised=await compare(planner,context,input.selected,'week-workload');
 await verify(planner,context);
 const summary=r=>({selectedCount:r.selected.length,selectedMinutes:r.selectedMinutes,unknownEstimates:r.unknownEstimates,days:r.days});
 // Full-shortlist placements are comparison evidence, never an implicit save.
 for(const day of full.days)delete day.preview;
 return {date:report.date,today:report.today,timezone:report.timezone,generatedAt:full.generatedAt,calendarRevision:full.calendarRevision,shortlist,full:summary(full),revised:summary(revised)};
}
