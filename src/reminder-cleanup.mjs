import {AppError,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {localDay} from '../mobile/web/planner-core.js';
import {readView} from './read-view.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const digest=v=>sha(JSON.stringify(v)),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const zone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone,kind='reminder-cleanups';
const selectedOK=rows=>Array.isArray(rows)&&rows.length>0&&rows.length<=100&&rows.every(r=>uuid(r?.id)&&hash(r.revision))&&new Set(rows.map(r=>r.id)).size===rows.length;
export function cleanupReceiptsOK(rows){return rows===undefined||Array.isArray(rows)&&rows.every(r=>uuid(r?.id)&&hash(r.reviewRevision)&&typeof r.confirmedAt==='string'&&Number.isFinite(Date.parse(r.confirmedAt))&&Array.isArray(r.ids)&&r.ids.length>0&&r.ids.length<=100&&r.ids.every(uuid)&&new Set(r.ids).size===r.ids.length)&&new Set(rows.map(r=>r.id)).size===rows.length;}

// A cleanup only changes reminder status. Its receipt and every selected status
// are written together to the same atomic reminder index, never task notes.
export class ReminderCleanup {
 constructor({planner}){this.p=planner;}
 report(input={}){return readView(()=>this.p.workloadRevisits.report({...input,status:'open'}));}
 async record(id){
  if(!uuid(id))throw new AppError('Choose a valid daily cleanup review.');
  return this.validate(await this.p.store.get(kind,id),id);
 }
 validate(r,id){
  if(!r||typeof r!=='object'||Array.isArray(r))throw new AppError('This cleanup review cannot be read. Restore it before confirming.',503);const {revision,...data}=r;
  if(!uuid(id)||r.version!==1||r.id!==id||!hash(revision)||digest(data)!==revision||!validDate(r.date)||typeof r.timezone!=='string'||!Number.isFinite(Date.parse(r.created))||!hash(r.requestHash)||!selectedOK(r.selected)||!Array.isArray(r.rows)||r.rows.length!==r.selected.length||r.rows.some((row,i)=>row.id!==r.selected[i].id||!Array.isArray(row.issues)||row.issues.some(x=>typeof x!=='string')))throw new AppError('This cleanup review cannot be read. Restore it before confirming.',503);
  return r;
 }
 issues(r,state){
  return r.selected.map((item,i)=>{
   const current=state.entries.find(e=>e.id===item.id),issues=[...r.rows[i].issues];
   if(!current)issues.push('This reminder is missing.');
   else if(current.status!=='open')issues.push('This reminder is already dismissed.');
   else if(this.p.workloadRevisits.public(current).revision!==item.revision)issues.push('This reminder changed. Review it again.');
   return {id:item.id,currentStatus:current?.status||'unavailable',issues:[...new Set(issues)]};
  });
 }
 view(id){return this.p.vault.exclusive(async()=>this.buildView(await this.record(id)));}
 async buildView(r,state){
  state??=await this.p.workloadRevisits.read();
  const receipt=state.cleanups?.find(x=>x.id===r.id);
  if(receipt&&(receipt.reviewRevision!==r.revision||digest(receipt.ids)!==digest(r.selected.map(x=>x.id))))throw new AppError('The cleanup receipt does not match its review. Restore the records before continuing.',503);
  const rows=this.issues(r,state),dayChanged=r.date!==localDay(this.p.now())||r.timezone!==zone();
  return {review:r,rows,receipt:receipt||null,dayChanged,canConfirm:!receipt&&!dayChanged&&rows.every(row=>!row.issues.length)};
 }
 history({offset=0,date}={}){return this.p.vault.exclusive(async()=>{
  if(!Number.isInteger(offset)||offset<0||offset>100000||date!==undefined&&!validDate(date))throw new AppError('Choose a valid cleanup history page and date.');
  const state=await this.p.workloadRevisits.read();let records;
  try{records=await this.p.store.list(kind);for(const r of records)this.validate(r,r?.id);}
  catch{throw new AppError('Saved cleanup reviews cannot all be read. They have been kept; restore the damaged records before relying on this history.',503);}
  const missing=(state.cleanups||[]).filter(x=>!records.some(r=>r.id===x.id));
  const all=[...records.filter(r=>!date||r.date===date),...missing.map(r=>({id:r.id,created:r.confirmedAt,missing:true}))].sort((a,b)=>b.created.localeCompare(a.created)||a.id.localeCompare(b.id));
  const rows=[];
  for(const r of all.slice(offset,offset+10)){
   const row={id:r.id,date:r.date||null,timezone:r.timezone||null,count:r.selected?.length??null,created:r.created};
   try{
    if(r.missing)throw new AppError('A cleanup receipt exists, but its original review is missing. Restore the review to inspect the exact result.',503);
    const v=await this.buildView(r,state);Object.assign(row,{status:v.receipt?'recorded':v.canConfirm?'pending':'blocked',confirmedAt:v.receipt?.confirmedAt||null,issues:v.receipt?[]:[...(v.dayChanged?['The original review day or timezone changed.']:[]),...new Set(v.rows.flatMap(x=>x.issues))]});
   }catch(e){Object.assign(row,{status:'unavailable',confirmedAt:null,issues:[e.message]});}
   rows.push(row);
  }
  return {today:localDay(this.p.now()),timezone:zone(),date:date||null,total:all.length,offset,limit:10,rows};
 });}
 review(input){return this.p.vault.exclusive(async()=>{
  const {requestId,today,timezone,selected}=input||{};
  if(!uuid(requestId)||!validDate(today)||typeof timezone!=='string'||!selectedOK(selected))throw new AppError('Select between one and 100 reminders to review.');
  const choices=selected.map(({id,revision})=>({id,revision})).sort((a,b)=>a.id.localeCompare(b.id)),requestHash=digest({today,timezone,selected:choices});
  let existing;try{existing=await this.record(requestId);}catch(e){if(e.status!==404)throw e;}
  if(existing){if(existing.requestHash!==requestHash)throw new AppError('This request already belongs to different cleanup choices.',409);return this.buildView(existing);}
  const guard=()=>{if(today!==localDay(this.p.now())||timezone!==zone())throw new AppError('The day or timezone changed. Review the cleanup again.',409);};guard();
  const state=await this.p.workloadRevisits.read(),rows=choices.map(item=>{
   const entry=state.entries.find(e=>e.id===item.id),before=entry?this.p.workloadRevisits.public(entry):null,issues=[];
   if(!before)issues.push('This reminder is missing.');
   else if(before.status!=='open')issues.push('This reminder is already dismissed.');
   else if(before.revision!==item.revision)issues.push('This reminder changed. Review it again.');
   return {id:item.id,before,after:'dismissed',issues};
  });
  const data={version:1,id:requestId,created:this.p.now().toISOString(),date:today,timezone,requestHash,selected:choices,rows},r={...data,revision:digest(data)};
  await this.p.store.put(kind,r,{beforeCommit:async()=>{guard();try{await this.p.store.get(kind,r.id);}catch(e){if(e.status===404)return;throw e;}throw new AppError('This cleanup request appeared while saving. Recover the exact review.',409);}});
  return this.buildView(r);
 });}
 accept(input){return this.p.vault.exclusive(async()=>{
  const {id,revision,acknowledge}=input||{};
  if(!uuid(id)||!hash(revision)||acknowledge!==true)throw new AppError('Confirm the exact reviewed reminder dismissals.');
  const r=await this.record(id);if(r.revision!==revision)throw new AppError('This cleanup review changed. Reopen it before confirming.',409);
  const result=await this.buildView(r);
  if(result.receipt){await this.p.workloadRevisits.confirm();return result;}
  if(!result.canConfirm)throw new AppError(result.dayChanged?'The day or timezone changed. Review the cleanup again.':'Some selected reminders changed or are unavailable. No reminders were dismissed; review the individual items.',409);
  const state=await this.p.workloadRevisits.read(),before=digest(state),receipt={id:r.id,reviewRevision:r.revision,confirmedAt:this.p.now().toISOString(),ids:r.selected.map(x=>x.id)};
  for(const item of this.issues(r,state))if(item.issues.length)throw new AppError('A selected reminder changed. Review the cleanup again.',409);
  for(const id of receipt.ids){const entry=state.entries.find(e=>e.id===id);entry.status='dismissed';entry.dismissedAt=receipt.confirmedAt;}
  state.cleanups??=[];state.cleanups.push(receipt);
  await this.p.workloadRevisits.commit(state,before,async()=>{
   if(r.date!==localDay(this.p.now())||r.timezone!==zone())throw new AppError('The day or timezone changed before saving. Review again.',409);
   if((await this.record(id)).revision!==revision)throw new AppError('The cleanup review changed before saving.',409);
  });
  return this.buildView(r);
 });}
}
