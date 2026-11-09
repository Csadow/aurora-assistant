import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {atomic,AppError,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {localDay,minutes} from '../mobile/web/planner-core.js';
import {focusSnapshot} from './focus-review.mjs';
import {savedPlanEvents} from './saved-day-plans.mjs';
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const hash=value=>sha(JSON.stringify(value));
const kinds=['priority','constraint','interruption'];
const empty=()=>({version:1,entries:[],receipts:[]});
const zone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
export class DailyCheckins {
 constructor({planner,data}){this.planner=planner;this.path=join(data,'daily-checkins.json');this.marker=join(data,'daily-checkins-started.json');}
 async read(){
  try{const s=JSON.parse(await readFile(this.path,'utf8'));
   if(s.version!==1||!Array.isArray(s.entries)||!Array.isArray(s.receipts)||new Set(s.entries.map(e=>e.id)).size!==s.entries.length||s.entries.some(e=>!uuid(e.id)||!validDate(e.date)||typeof e.timezone!=='string'||!kinds.includes(e.kind)||typeof e.note!=='string'||!e.note.trim()||typeof e.requestHash!=='string'||!Number.isSafeInteger(e.sequence)||e.sequence<0||!['open','reviewed'].includes(e.status)||!Number.isFinite(Date.parse(e.created))||!Array.isArray(e.selected)||e.selected.some(r=>!uuid(r.taskId)||typeof r.contextRevision!=='string'||!r.task)||!Number.isInteger(e.gap)||e.gap<0||e.gap>120||minutes(e.start)>=minutes(e.end))||s.receipts.some(r=>!uuid(r.id)||!uuid(r.entryId)||typeof r.hash!=='string'))throw Error();return s;
  }catch(e){if(e.code==='ENOENT'){try{await readFile(this.marker);}catch(m){if(m.code==='ENOENT')return empty();throw m;}throw new AppError('Daily check-ins are missing. Restore a backup before saving another check-in.',503);}throw new AppError('Daily check-ins cannot be read. Restore a backup before changing them.',503);}
 }
 public(entry){const {requestHash,...r}=entry;return {...r,revision:hash(entry)};}
 async report(){return this.planner.vault.exclusive(async()=>{const s=await this.read(),date=localDay(this.planner.now()),timezone=zone();return {date,timezone,entries:s.entries.map(e=>this.public(e)).reverse(),open:s.entries.filter(e=>e.status==='open').length};});}
 async commit(state,before,guard=async()=>{}){
  try{await atomic(this.path,JSON.stringify(state,null,2),{beforeCommit:async()=>{if(hash(await this.read())!==before)throw new AppError('Check-ins changed. Reload before saving.',409);await guard();}});await atomic(this.marker,JSON.stringify({version:1}));}
  catch(e){if(e.status)throw e;throw new AppError('The check-in save could not be confirmed. It may already be saved; retry the same request.',503);}
 }
 async create(input){return this.planner.vault.exclusive(async()=>{
  const {requestId,date,timezone,kind,note,selected=[],start='00:00',end='18:00',gap=10}=input;
  if(!uuid(requestId))throw new AppError('Use a valid check-in request.');
  const requestHash=hash({date,timezone,kind,note,selected,start,end,gap}),state=await this.read(),existing=state.entries.find(e=>e.id===requestId);
  if(existing){if(existing.requestHash!==requestHash)throw new AppError('This request was already used for another check-in.',409);return this.public(existing);}
  if(state.receipts.some(r=>r.id===requestId))throw new AppError('This request was already used for a check-in decision.',409);
  if(!kinds.includes(kind)||typeof note!=='string'||!note.trim()||note.length>4000)throw new AppError('Describe the change in 1–4000 characters and choose its kind.');
  if(!Array.isArray(selected)||selected.length>100||selected.some(r=>!uuid(r?.taskId)||typeof r.contextRevision!=='string')||new Set(selected.map(r=>r.taskId)).size!==selected.length)throw new AppError('Choose up to 100 unique current tasks.');
  try{if(minutes(start)>=minutes(end)||!Number.isInteger(gap)||gap<0||gap>120)throw Error();}catch{throw new AppError('Choose a valid work window and a break between 0 and 120 minutes.');}
  const verify=async()=>{const r=await this.planner.candidates();if(date!==r.date||timezone!==r.timezone)throw new AppError('The day or timezone changed. Compare the draft before saving it for today.',409);for(const item of selected){const t=r.tasks.find(t=>t.id===item.taskId);if(!t||t.locked||t.contextRevision!==item.contextRevision)throw new AppError('A selected task or attempt changed. Reload and compare the check-in draft.',409);}return r;};
  const r=await verify(),history=await this.planner.dailyFocus?.history.read(),plans=new Map(savedPlanEvents(history,date,this.planner.now()).map(e=>[e.taskId,e.after])),before=hash(state);
  const entry={id:requestId,requestHash,date,timezone,kind,note:note.trim(),start,end,gap,created:this.planner.now().toISOString(),sequence:0,status:'open',reviewedAt:null,selected:selected.map(s=>({...s,task:focusSnapshot(r.tasks.find(t=>t.id===s.taskId)),planned:focusSnapshot(plans.get(s.taskId))}))};state.entries.push(entry);await this.commit(state,before,verify);return this.public(entry);
 });}
 async decide(input){return this.planner.vault.exclusive(async()=>{
  const {requestId,id,revision,status}=input;if(!uuid(requestId)||!uuid(id)||typeof revision!=='string'||!['open','reviewed'].includes(status))throw new AppError('Choose a valid check-in decision.');
  const state=await this.read(),requestHash=hash({id,revision,status}),receipt=state.receipts.find(r=>r.id===requestId),entry=state.entries.find(e=>e.id===id);
  if(receipt){if(receipt.hash!==requestHash)throw new AppError('This request was already used for another decision.',409);if(!entry)throw new AppError('The saved check-in is missing.',503);return this.public(entry);}
  if(state.entries.some(e=>e.id===requestId))throw new AppError('This request was already used for a check-in.',409);
  if(!entry||hash(entry)!==revision)throw new AppError('The check-in changed. Reload before marking it reviewed.',409);
  const before=hash(state);entry.sequence++;entry.status=status;entry.reviewedAt=status==='reviewed'?this.planner.now().toISOString():null;state.receipts.push({id:requestId,hash:requestHash,entryId:id});state.receipts=state.receipts.slice(-200);await this.commit(state,before);return this.public(entry);
 });}
 // Called from preview and note-commit guards: deliberately does not acquire the vault lock.
 async source(ref){
  const s=await this.read(),entry=s.entries.find(e=>e.id===ref?.id);
  if(!entry||hash(entry)!==ref.revision||entry.status!=='open'||entry.date!==localDay(this.planner.now())||entry.timezone!==zone())throw new AppError('The check-in changed, was reviewed, or belongs to another day. Reopen it before preparing an adjustment.',409);
  return this.public(entry);
 }
}
