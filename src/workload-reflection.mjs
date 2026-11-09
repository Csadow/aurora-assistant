import {AppError} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {localDay} from '../mobile/web/planner-core.js';
import {weekStart} from './weekly-planner.mjs';
import {buildWorkloadRemaining} from './workload-remaining.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const recorded=(e,now)=>Number.isFinite(Date.parse(e.recordedAt))&&new Date(e.recordedAt)<=now;
const carry=e=>e.source==='aurora_save'&&['evening_review','weekly_review'].includes(e.decision?.kind)&&e.decision.action==='move'&&uuid(e.decision.proposalId)&&e.taskId===e.before?.id&&e.taskId===e.after?.id&&validDate(e.before?.planDate)&&validDate(e.after?.planDate)&&e.after.planDate>e.before.planDate&&Array.isArray(e.kinds)&&e.kinds.includes('rescheduled');

// Period membership describes plan dates, not historical task state or work done.
// Reading this index never reconciles history, writes decisions or creates drafts.
export function workloadReflection(planner,input={}){
 return planner.vault.exclusive(()=>buildWorkloadReflection(planner,input));
}
export async function buildWorkloadReflection(planner,input={}){
  const now=planner.now(),today=localDay(now),{period='day',date=today,offset=0}=input;
  if(!['day','week'].includes(period)||!validDate(date)||date>today||!Number.isInteger(offset)||offset<0||offset>100000)throw new AppError('Choose today or an earlier day or week to review.');
  const start=period==='week'?weekStart(date):date,endDate=new Date(start+'T12:00:00Z');if(period==='week')endDate.setUTCDate(endDate.getUTCDate()+6);const end=endDate.toISOString().slice(0,10);
  const inPeriod=d=>validDate(d)&&d>=start&&d<=end,warnings=[],sources={proposals:true,history:true};
  const read=async(key,fn)=>{try{return await fn();}catch(e){sources[key]=false;warnings.push(key+': '+e.message);return null;}};
  const proposals=await read('proposals',()=>planner.store.list('proposals'));
  const history=await read('history',async()=>{const h=await planner.dailyFocus.history.read();if(!Array.isArray(h?.events))throw Error('Recorded task history is unavailable.');return h;});
  const groups=new Map(),planRoots=new Map();
  for(const p of proposals||[]){
   if(p.kind!=='future_schedule'||!['week-workload','workload-next'].includes(p.origin))continue;
   if(Number.isFinite(Date.parse(p.created))&&new Date(p.created)>now)continue;
   const root=p.origin==='week-workload'?p.id:p.workloadFrom?.proposalId;
   if(!uuid(root)||!uuid(p.id)){warnings.push('A workload has an unreadable source link; the list may be incomplete.');continue;}
   const g=groups.get(root)||{proposalId:root,dates:new Set()};groups.set(root,g);planRoots.set(p.id,root);
   if(validDate(p.targetDate)&&Number.isFinite(Date.parse(p.created)))g.dates.add(p.targetDate);
   else warnings.push('A workload has unreadable dates; its period is unknown.');
  }
  for(const event of history?.events||[]){
   if(event.decision?.kind!=='future_schedule'||!['aurora_save','recovered_save'].includes(event.source)||!recorded(event,now))continue;
   const root=planRoots.get(event.decision.proposalId);
   if(root&&event.taskId===event.after?.id&&validDate(event.after?.planDate))groups.get(root).dates.add(event.after.planDate);
  }
  const all=[...groups.values()].map(g=>({...g,dates:[...g.dates].filter(inPeriod).sort()})).filter(g=>g.dates.length).sort((a,b)=>b.dates.at(-1).localeCompare(a.dates.at(-1))||a.proposalId.localeCompare(b.proposalId));
  const rows=[];
  for(const g of all.slice(offset,offset+5)){
   try{
    const r=await buildWorkloadRemaining(planner,{proposalId:g.proposalId,date:today});
    const tasks=r.rows.map(t=>{
     const reliable=sources.history&&r.sources.history&&!!t.current;
     const events=reliable?history.events.filter(e=>e.taskId===t.taskId&&recorded(e,now)&&carry(e)).sort((a,b)=>Date.parse(b.recordedAt)-Date.parse(a.recordedAt)):[];
     const deferrals={total:reliable?events.length:null,inPeriod:reliable?events.filter(e=>inPeriod(localDay(new Date(e.recordedAt)))).length:null,recent:events.slice(0,3).map(e=>({id:e.id,proposalId:e.decision.proposalId,recordedAt:e.recordedAt,from:e.before.planDate,to:e.after.planDate}))};
     const omittedIn=r.sources.original&&r.sources.proposals?r.plans.filter(p=>!p.error&&!t.proposedIn.includes(p.id)&&!t.heldIn.includes(p.id)).map(p=>p.id):null;
     return {taskId:t.taskId,text:t.text,state:t.state,detail:t.detail,current:t.current,unplaced:!!t.current&&!t.current.done&&t.state!=='reserved',deferrals,omittedIn};
    });
    rows.push({...g,title:r.source.title,legacy:r.source.legacy,sources:r.sources,warnings:r.warnings,counts:r.counts,known:r.total,unplaced:tasks.filter(t=>t.unplaced).length,tasks,pending:r.pending,error:null});
   }catch(e){rows.push({...g,title:'Workload unavailable',error:e.message,tasks:[],unplaced:null,known:null,warnings:[]});}
  }
  if(history?.pending)warnings.push('A task save awaits reconciliation. Only existing recorded receipts are counted.');
  if(localDay(planner.now())!==today)warnings.push('The day changed while loading. Refresh the review for current reservations.');
  return {period,date:start,start,end,today,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,generatedAt:now.toISOString(),offset,total:sources.proposals?all.length:null,rows,sources,warnings:[...new Set(warnings)]};
}
