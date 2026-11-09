import {AppError} from './vault.mjs';
import {minutes} from '../mobile/web/planner-core.js';
import {tasksIn} from './task-meta.mjs';
export function focusSchedulingIssue(row){
 if(row.choice?.action!=='focus')return 'Choose this task as today’s focus first.';
 if(row.readiness!=='ready')return row.detail;
 if(row.task?.startTime)return 'Existing reserved time stays fixed. Use Edit / schedule to change it.';
 return null;
}
export async function verifyFocusPlan(planner,p){
 // This also runs inside Vault.save's commit guard: build is intentionally non-locking.
 const r=await planner.dailyFocus.build();
 if(r.date!==p.date||r.timezone!==p.timezone||r.revision!==p.focusRevision)throw new AppError('Daily focus changed. Reload focus and prepare a fresh time preview.',409);
 for(const c of p.changes.filter(c=>!p.saved.includes(c.before.path))){const row=r.rows.find(r=>r.taskId===c.before.id);if(!row||row.contextRevision!==c.focusContext||focusSchedulingIssue(row))throw new AppError('A focused task or its current attempt changed. Reload focus and prepare a fresh time preview.',409);}
}
export async function previewFocus(planner,{date,timezone,revision,selected,start='09:00',end='18:00',gap=10},fingerprint){
 try{if(minutes(end)<=minutes(start))throw Error('Finish time must be after the start time.');if(!Number.isInteger(gap)||gap<0||gap>120)throw Error('Breaks must be between 0 and 120 minutes.');}catch(e){throw new AppError(e.message);}
 const report=await planner.dailyFocus.report();
 if(date!==report.date||timezone!==report.timezone||revision!==report.revision)throw new AppError('Daily focus changed. Reload today’s focus.',409);
 if(!Array.isArray(selected)||!selected.length||selected.length>100||selected.some(s=>!s||typeof s.taskId!=='string'||typeof s.contextRevision!=='string')||new Set(selected.map(s=>s.taskId)).size!==selected.length)throw new AppError('Select focused, untimed tasks to find time for.');
 const notes=await planner.vault.list(),tasks=tasksIn(notes),changes=[];
 for(const s of selected){const row=report.rows.find(r=>r.taskId===s.taskId),matches=tasks.filter(t=>t.id===s.taskId);
  if(!row||row.contextRevision!==s.contextRevision||matches.length!==1)throw new AppError('A focused task changed. Reload today’s focus.',409);
  const issue=focusSchedulingIssue(row);if(issue)throw new AppError(row.text+': '+issue,409);
  const before=matches[0];changes.push({before,after:{...before,planDate:date,startTime:null},action:'schedule_focus',execution:row.execution,focusContext:row.contextRevision});
 }
 const planning=await planner.planReviewTimes({notes,tasks,changes,reserveTimes:true,start,end,gap,keepUnplaced:true});
 const held=report.rows.filter(r=>r.choice?.action==='focus'&&!selected.some(s=>s.taskId===r.taskId)).map(r=>({taskId:r.taskId,text:r.text,reason:focusSchedulingIssue(r)||'Not selected for this preview.',task:r.task}));
 for(const c of changes.filter(c=>c.unplaced))held.push({taskId:c.before.id,text:c.before.text,reason:'No available slot in the chosen hours; existing schedule kept.',task:c.before});
 const p={kind:'focus_schedule',title:'Time for today’s focus · '+date,date,timezone,focusRevision:revision,changes:changes.filter(c=>!c.unplaced),held,...planning,reserveTimes:true,contextHash:fingerprint(notes),saved:[],intents:[]};
 return planner.vault.exclusive(async()=>{
  await verifyFocusPlan(planner,p);
  if(fingerprint(await planner.vault.list())!==p.contextHash)throw new AppError('Tasks or classes changed while preparing the preview. Try again.',409);
  return planner.public(await planner.store.proposal(p));
 });
}
