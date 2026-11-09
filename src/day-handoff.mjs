import {AppError} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {focusSnapshot,focusHash} from './focus-review.mjs';
import {localDay,minutes} from '../mobile/web/planner-core.js';

// Navigation and evidence only: no reconciliation, automatic rollover or writes.
export function dayHandoff(planner,selectedDate){return planner.vault.exclusive(()=>buildDayHandoff(planner,selectedDate));}
// The task-detail report already holds the vault lock. Exact source filters run
// before display limits so a retained task link can reopen an older decision.
export async function buildDayHandoff(planner,selectedDate,{proposalId,taskId}={}){
 const now=planner.now(),today=localDay(now),previous=new Date(today+'T12:00:00Z');previous.setUTCDate(previous.getUTCDate()-1);
 const date=selectedDate??previous.toISOString().slice(0,10),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 if(!validDate(date)||date>today)throw new AppError('Choose today or an earlier handoff date.');
 const warnings=[],tasks=await planner.vault.tasks(),at=now.getHours()*60+now.getMinutes();
 const current=id=>{const matches=id?tasks.filter(t=>t.id===id):[];return matches.length===1?focusSnapshot(matches[0]):null;};
 const expired=tasks.filter(t=>t.planDate===date&&!t.done&&!t.scheduleError&&t.startTime&&(date<today||minutes(t.startTime)+t.duration<=at));
 if(tasks.some(t=>t.planDate===date&&t.scheduleError))warnings.push('Some task schedules need repair and are excluded from elapsed-reservation counts.');
 const reservations=expired.sort((a,b)=>a.startTime.localeCompare(b.startTime)).slice(0,30).map(t=>({task:focusSnapshot(t),identityIssue:!t.id||tasks.filter(x=>x.id===t.id).length!==1}));
 let checkins=null,proposals=null,history=null;
 try{if(!planner.checkins)throw Error('Check-ins unavailable.');checkins=(await planner.checkins.read()).entries.filter(e=>e.date===date&&new Date(e.created)<=now).map(({id,date,timezone,kind,note,status,created})=>({id,date,timezone,kind,note,status,created})).reverse();}catch(e){warnings.push('Check-ins: '+e.message);}
 try{proposals=(await planner.store.list('proposals')).filter(p=>p.kind==='evening_review'&&p.reviewDate===date&&(!proposalId||p.id===proposalId)).sort((a,b)=>b.created.localeCompare(a.created));if(proposals.some(p=>!Number.isFinite(Date.parse(p.created))||!['pending','accepted','dismissed'].includes(p.status)||typeof p.timezone!=='string'||!Array.isArray(p.changes)||p.changes.some(c=>!c?.before||!c.after||!['move','reduce','unschedule'].includes(c.action))))throw Error('Saved evening reviews cannot be read.');proposals=proposals.filter(p=>new Date(p.created)<=now);}catch(e){proposals=null;warnings.push('Evening decisions: '+e.message);}
 try{if(!planner.dailyFocus?.history)throw Error('Plan history unavailable.');history=await planner.dailyFocus.history.read();if(history.pending)warnings.push('A task save awaits history reconciliation. Only recorded saves are shown.');}catch(e){warnings.push('Recorded saves: '+e.message);}
 const decisions=proposals?.slice(0,20).map(p=>{
  const receipts=history?(history.events||[]).filter(e=>e.decision?.proposalId===p.id&&e.decision.kind==='evening_review'&&['aurora_save','recovered_save'].includes(e.source)&&new Date(e.recordedAt)<=now):null;
  const rows=p.changes.map(c=>{
   const saved=c.before.id?receipts?.filter(e=>e.taskId===c.before.id).at(-1):null,task=current(c.before.id);
   return {taskId:c.before.id||null,text:c.before.text,action:c.action,before:focusSnapshot(c.before),proposed:focusSnapshot(c.after),saved:saved?{before:focusSnapshot(saved.before),after:focusSnapshot(saved.after),source:saved.source,recordedAt:saved.recordedAt}:null,current:task,changed:!!saved&&focusHash(focusSnapshot(saved.after))!==focusHash(task)};
  });
  return {id:p.id,status:p.status,title:p.title,recorded:receipts?rows.filter(r=>r.saved).length:null,total:rows.length,rows:rows.filter(r=>!taskId||r.taskId===taskId).slice(0,30),timezone:p.timezone};
 });
 if(localDay(planner.now())!==today)warnings.push('The day changed while loading. Reload before planning.');
 return {date,today,timezone,observedAt:now.toISOString(),reservations,reservationCount:expired.length,checkins:checkins?.slice(0,20)??null,checkinCount:checkins?.length??null,decisions:decisions??null,decisionCount:proposals?.length??null,historyAvailable:!!history,warnings};
}
