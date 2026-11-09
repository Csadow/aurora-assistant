import {reminderOverview} from './reminder-overview.mjs';
import {localDay} from '../mobile/web/planner-core.js';
import {firstStepContext} from './first-steps.mjs';
import {stepOutcomeRows} from './step-outcomes.mjs';
import {sha} from './vault.mjs';
import {tasksIn,validDate} from './task-meta.mjs';
import {workloadStart} from './workload-start.mjs';

// A read-only starting point shared by briefing and workspace.
export async function dayStart(planner,b){
 const chosen=(b.focus?.rows||[]).filter(r=>r.choice?.action==='focus'&&!r.task?.done);
 const ordered=[...chosen].sort((a,c)=>Number(c.taskId===b.focus?.next?.taskId)-Number(a.taskId===b.focus?.next?.taskId));
 const focused=[];let stepState=null,stepError=null,notes=null;
 try{notes=await planner.vault.list();}catch(e){stepError=e.message;}
 try{stepState=await planner.firstSteps.read();}catch(e){stepError=e.message;}
 const outcomes=stepState?stepOutcomeRows(stepState):[];
 for(const row of ordered.slice(0,12)){
  const card=stepState?.cards[row.taskId]||null,context=firstStepContext(row,b.date,b.timezone,notes||[]);
  const step=stepState?{card,changed:!!card&&sha(JSON.stringify(card.context))!==sha(JSON.stringify(context)),latest:outcomes.filter(o=>o.taskId===row.taskId&&!o.superseded&&o.cardSequence===card?.sequence).at(-1)||null}:null;
  focused.push({taskId:row.taskId,text:row.text,task:row.task,readiness:row.readiness,detail:row.detail,execution:row.execution,dependencyReasons:row.dependencyReasons,identityIssue:row.identityIssue,step,stepError});
 }

 const earlier=await earlierDays(planner,b.date,notes),at=new Date(b.generatedAt),minute=at.getHours()*60+at.getMinutes(),upcoming=b.day.blocks.filter(x=>x.end>minute);
 let workload=null,workloadError=null;try{workload=await workloadStart(planner,{date:b.date});}catch(e){workloadError=e.message;}
 let revisits=null,revisitsError=null;try{revisits=await planner.workloadRevisits?.report({brief:true})||null;}catch(e){revisitsError=e.message;}
 let reminderFollow=null,reminderFollowError=null;try{reminderFollow=await reminderOverview(planner,{brief:true});}catch(e){reminderFollowError=e.message;}
 return {reminderFollow,reminderFollowError,revisits,revisitsError,date:b.date,timezone:b.timezone,workload,workloadError,focused,focusTotal:chosen.length,focusAvailable:!!b.focus,selected:focused[0]||null,upcoming:upcoming.slice(0,3),upcomingCount:upcoming.length,conflicts:b.day.conflicts.length,unknownClasses:!!b.day.unknown,earlier,warnings:[...new Set([b.focusError,stepError,...earlier.warnings,...(localDay(planner.now())!==b.date?['The day changed while loading. Refresh before continuing.']:[])].filter(Boolean))]};
}

async function earlierDays(planner,today,notes){
 const groups=new Map(),warnings=[],sources={tasks:!!notes,checkins:true,reviews:true,focus:true},now=planner.now();
 const day=date=>{if(!validDate(date)||date>=today)return null;let g=groups.get(date);if(!g){g={date,unfinished:0,checkins:0,openCheckins:0,reviews:0,focusChoices:0};groups.set(date,g);}return g;};
 // Counts describe current task checkboxes and retained records, never time spent.
 if(!notes)warnings.push('Earlier planned tasks are unavailable. Refresh to inspect their original dates.');
 const tasks=tasksIn(notes||[]);
 for(const t of tasks)if(!t.done&&!t.scheduleError&&validDate(t.planDate)&&t.planDate<today)day(t.planDate).unfinished++;
 if(tasks.some(t=>t.scheduleError))warnings.push('Some task schedules need repair and are excluded from earlier-day task counts.');
 try{for(const c of (await planner.checkins.read()).entries)if(new Date(c.created)<=now){const g=day(c.date);if(g){g.checkins++;if(c.status==='open')g.openCheckins++;}}}catch(e){sources.checkins=false;warnings.push('Earlier check-ins: '+e.message);}
 try{for(const p of await planner.store.list('proposals'))if(p.kind==='evening_review'&&Number.isFinite(Date.parse(p.created))&&new Date(p.created)<=now){const g=day(p.reviewDate);if(g)g.reviews++;}}catch(e){sources.reviews=false;warnings.push('Earlier evening reviews: '+e.message);}
 try{for(const d of Object.values((await planner.dailyFocus.read()).days)){const count=Object.values(d.choices).filter(c=>c.action==='focus').length;if(count){const g=day(d.date);if(g)g.focusChoices+=count;}}}catch(e){sources.focus=false;warnings.push('Earlier focus choices: '+e.message);}
 const rows=[...groups.values()].sort((a,b)=>b.date.localeCompare(a.date));
 return {rows:rows.slice(0,14),total:rows.length,sources,warnings};
}
