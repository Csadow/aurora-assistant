import {cleanupReceiptsOK} from './reminder-cleanup.mjs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {atomic,AppError,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {localDay} from '../mobile/web/planner-core.js';
import {weekStart} from './weekly-planner.mjs';
import {buildWorkloadReflection} from './workload-reflection.mjs';
import {buildWorkloadRemaining} from './workload-remaining.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const hash=v=>sha(JSON.stringify(v)),zone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const reviewOK=r=>r&&['day','week'].includes(r.period)&&validDate(r.date)&&Number.isInteger(r.offset)&&r.offset>=0&&r.offset<=100000&&(r.period!=='week'||weekStart(r.date)===r.date);
const tomorrow=date=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);};
// Ignore later approval/receipt bookkeeping when comparing the original source.
const sourceHash=p=>hash({id:p.id,title:p.title,date:p.targetDate,created:p.created,workloadSource:p.workloadSource,changes:p.changes?.map(c=>({before:c.before,after:c.after})),held:p.held});
const key=e=>hash({proposalId:e.proposalId,targetDate:e.targetDate,period:e.review.period,date:e.review.date});

export class WorkloadRevisits {
 constructor({planner,data}){this.planner=planner;this.path=join(data,'workload-revisits.json');this.marker=join(data,'workload-revisits-started.json');}
 async read(){
  try{const s=JSON.parse(await readFile(this.path,'utf8'));
   if(s.version!==1||!cleanupReceiptsOK(s.cleanups)||!Array.isArray(s.entries)||s.entries.some(e=>!uuid(e?.id)||!uuid(e.proposalId)||!reviewOK(e.review)||!validDate(e.savedOn)||e.review.date>e.savedOn||e.targetDate!==tomorrow(e.savedOn)||typeof e.timezone!=='string'||!stamp(e.created)||!['open','dismissed'].includes(e.status)||e.status==='dismissed'&&!stamp(e.dismissedAt)||e.status==='open'&&e.dismissedAt!==null||typeof e.requestHash!=='string'||typeof e.source?.title!=='string'||!validDate(e.source.date)||typeof e.source.hash!=='string'||!Array.isArray(e.source.tasks)||e.source.tasks.some(t=>!uuid(t?.taskId)||typeof t.text!=='string')||new Set(e.source.tasks.map(t=>t.taskId)).size!==e.source.tasks.length)||new Set(s.entries.map(e=>e.id)).size!==s.entries.length||new Set(s.entries.map(key)).size!==s.entries.length)throw Error();return s;
  }catch(e){if(e.code==='ENOENT'){try{await readFile(this.marker);}catch(m){if(m.code==='ENOENT')return {version:1,entries:[]};throw m;}throw new AppError('Saved workload reminders are missing. Restore a backup before saving more.',503);}throw new AppError('Saved workload reminders cannot be read. Restore a backup before changing them.',503);}
 }
 public(e){const {requestHash,...r}=e;return {...r,revision:hash(e)};}
 async confirm(entry){try{await atomic(this.marker,JSON.stringify({version:1}));}catch{throw new AppError('The reminder save could not be confirmed. Retry the same request.',503);}return entry?this.public(entry):null;}
 async commit(s,before,guard=async()=>{}){
  try{await atomic(this.path,JSON.stringify(s,null,2),{beforeCommit:async()=>{if(hash(await this.read())!==before)throw new AppError('Saved workload reminders changed. Reload before saving.',409);await guard();}});await atomic(this.marker,JSON.stringify({version:1}));}
  catch(e){if(e.status)throw e;throw new AppError('The reminder save could not be confirmed. It may already be saved; retry the same request.',503);}
 }
 save(input){return this.planner.vault.exclusive(async()=>{
  const p=this.planner,{requestId,proposalId,review,today,timezone}=input;
  if(!uuid(requestId)||!uuid(proposalId)||!reviewOK(review)||!validDate(today)||review.date>today||typeof timezone!=='string')throw new AppError('Choose a workload and its original day or week review.');
  const requestHash=hash({proposalId,review,today,timezone}),s=await this.read(),existing=s.entries.find(e=>e.id===requestId);
  if(existing){if(existing.requestHash!==requestHash)throw new AppError('This request was already used for another reminder.',409);return this.confirm(existing);}
  const guard=()=>{if(today!==localDay(p.now())||timezone!==zone())throw new AppError('The day or timezone changed. Refresh the review before saving for tomorrow.',409);};guard();
  const targetDate=tomorrow(today),duplicate=s.entries.find(e=>key(e)===key({proposalId,review,targetDate}));if(duplicate)return this.confirm(duplicate);
  const reflection=await buildWorkloadReflection(p,review);
  if(!reflection.rows.some(g=>g.proposalId===proposalId))throw new AppError('This workload is no longer on the selected review page. Refresh the review before saving.',409);
  const r=await buildWorkloadRemaining(p,{proposalId,date:today});
  if(!r.sources.original)throw new AppError('The original workload is unavailable. Restore it before saving a new reminder.',409);
  const original=await p.store.get('proposals',proposalId);
  if(!stamp(original.created)||new Date(original.created)>p.now())throw new AppError('This source has an invalid creation date.',409);
  const before=hash(s),source={title:r.source.title,date:r.source.date,hash:sourceHash(original),tasks:r.rows.map(t=>({taskId:t.taskId,text:t.text}))};
  const entry={id:requestId,requestHash,proposalId,review:{...review},source,savedOn:today,targetDate,timezone,created:p.now().toISOString(),status:'open',dismissedAt:null};s.entries.push(entry);
  await this.commit(s,before,async()=>{guard();if(sourceHash(await p.store.get('proposals',proposalId))!==source.hash)throw new AppError('The original workload changed while saving. Refresh the review.',409);});return this.public(entry);
 });}
 dismiss({id,revision}){return this.planner.vault.exclusive(async()=>{
  if(!uuid(id)||typeof revision!=='string')throw new AppError('Choose a saved workload reminder.');
  const s=await this.read(),entry=s.entries.find(e=>e.id===id);if(!entry)throw new AppError('This saved reminder is unavailable.',404);
  if(entry.status==='dismissed')return this.confirm(entry);
  if(hash(entry)!==revision)throw new AppError('This reminder changed. Refresh before dismissing it.',409);
  const before=hash(s);entry.status='dismissed';entry.dismissedAt=this.planner.now().toISOString();await this.commit(s,before);return this.public(entry);
 });}
 report({offset=0,status='open',brief=false}={}){return this.planner.vault.exclusive(async()=>{
  if(!Number.isInteger(offset)||offset<0||offset>100000||!['open','dismissed'].includes(status))throw new AppError('Choose a valid reminder list.');
  const p=this.planner,s=await this.read(),today=localDay(p.now()),entries=s.entries.filter(e=>e.status===status).sort((a,b)=>a.targetDate.localeCompare(b.targetDate)||a.created.localeCompare(b.created)),due=entries.filter(e=>e.targetDate<=today),all=brief?due:entries,limit=brief?3:10,rows=[];
  for(const e of all.slice(offset,offset+limit)){
   let current=null,error=null,sourceChanged=null;try{current=await buildWorkloadRemaining(p,{proposalId:e.proposalId,date:today});if(current.sources.original)sourceChanged=sourceHash(await p.store.get('proposals',e.proposalId))!==e.source.hash;}catch(err){error=err.message;}
   rows.push({...this.public(e),due:e.targetDate<=today,sourceChanged,current:current?{counts:current.counts,sources:current.sources,warnings:current.warnings,tasks:current.rows.map(t=>({taskId:t.taskId,text:t.text,state:t.state,detail:t.detail}))}:null,error});
  }
  return {today,timezone:zone(),generatedAt:p.now().toISOString(),status,offset,limit,total:all.length,due:due.length,upcoming:entries.length-due.length,rows};
 });}
}
