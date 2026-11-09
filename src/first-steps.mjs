import {StepOutcomes,validStepExtras,stepOutcomeRows,stepCards} from './step-outcomes.mjs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {atomic,AppError,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {projectNotes} from '../mobile/web/task-links.js';

const hash=v=>sha(JSON.stringify(v));
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const empty=()=>({version:1,cards:{},receipts:[]});
const inputHash=(kind,input)=>hash({kind,taskId:input.taskId,revision:input.revision,...(kind==='save'?{text:input.text,mode:input.mode,...(input.sourceOutcomeId?{sourceOutcomeId:input.sourceOutcomeId}:{})}:{}),acknowledge:input.acknowledge});
const validContext=c=>object(c)&&validDate(c.date)&&typeof c.timezone==='string'&&object(c.task)&&uuid(c.task.id)&&typeof c.task.text==='string'&&typeof c.task.path==='string'&&object(c.choice)&&c.choice.action==='focus'&&typeof c.contextRevision==='string'&&Array.isArray(c.execution)&&Array.isArray(c.dependencyReasons)&&(c.project===null||object(c.project)&&typeof c.project.path==='string'&&typeof c.project.title==='string'&&typeof c.project.excerpt==='string');

const validCard=c=>object(c)&&uuid(c.taskId)&&Number.isSafeInteger(c.sequence)&&c.sequence>0&&typeof c.text==='string'&&!!c.text.trim()&&c.text.length<=3000&&['manual','aurora'].includes(c.mode)&&validContext(c.context)&&c.context.task.id===c.taskId&&Number.isFinite(Date.parse(c.updated));

export function firstStepContext(row,date,timezone,notes){
 const n=row.task?.project?projectNotes(notes).find(n=>n.path===row.task.project):null;
 const project=row.task?.project?{path:row.task.project,title:n?.title||row.task.project,revision:n?.revision||null,missing:!n,excerpt:n?.body.slice(0,1000)||''}:null;
 return {date,timezone,task:row.task,choice:row.choice,contextRevision:row.contextRevision,project,execution:row.execution.map(e=>({id:e.id,workflowId:e.workflowId,status:e.status,attempt:e.attempt,detail:e.detail,executionRevision:e.executionRevision})),dependencyReasons:row.dependencyReasons};
}

export class FirstSteps {
 constructor({planner,data}){this.planner=planner;this.path=join(data,'first-steps.json');this.marker=join(data,'first-steps-started.json');this.outcomes=new StepOutcomes(this);}
 async read(){
  try{const s=JSON.parse(await readFile(this.path,'utf8'));
   if(s.version!==1||!object(s.cards)||!Array.isArray(s.receipts)||Object.entries(s.cards).some(([id,c])=>id!==c?.taskId||!validCard(c))||s.receipts.some(r=>!uuid(r.id)||!uuid(r.taskId)||typeof r.hash!=='string')||new Set(s.receipts.map(r=>r.id)).size!==s.receipts.length||!validStepExtras(s,validCard))throw Error();return s;
  }catch(e){if(e.code==='ENOENT'){try{await readFile(this.marker);}catch(m){if(m.code==='ENOENT')return empty();throw m;}throw new AppError('Saved first steps are missing. Restore a backup before changing them.',503);}throw new AppError('Saved first steps cannot be read. Restore a backup before changing them.',503);}
 }
 async overview(){const s=await this.read();return Object.values(s.cards).sort((a,b)=>b.updated.localeCompare(a.updated)).map(c=>({taskId:c.taskId,text:c.text,taskText:c.context.task.text,date:c.context.date,mode:c.mode,openOutcomes:stepOutcomeRows(s,c.taskId).filter(o=>o.unresolved).length}));}
 report(taskId){return this.planner.vault.exclusive(()=>this.build(taskId));}
 // Non-locking: also used by durable-save and execution-draft commit guards.
 async build(taskId,state){
  if(!uuid(taskId))throw new AppError('Choose a task with a stable ID.');
  state??=await this.read();const p=this.planner,f=await p.dailyFocus.build(undefined,{includeIds:[taskId]}),row=f.rows.find(r=>r.taskId===taskId),card=state.cards[taskId]||null;
  const context=firstStepContext(row,f.date,f.timezone,await p.vault.list()),project=context.project;
  const canSave=!!row.task&&!row.identityIssue&&!row.task.done&&row.choice?.action==='focus';
  const changed=!!card&&hash(card.context)!==hash(context),canPrepare=canSave&&row.readiness==='ready'&&!project?.missing&&row.execution.length===0;
  const history=stepCards(state).filter(c=>c.taskId===taskId).sort((a,b)=>b.sequence-a.sequence),outcomes=stepOutcomeRows(state,taskId);
  return {history,outcomes,taskId,date:f.date,timezone:f.timezone,context,card,changed,canSave,canPrepare,detail:row.detail,identityIssue:row.identityIssue,revision:hash({context,card,canSave,canPrepare,detail:row.detail,...(outcomes.length?{outcomes}:{}),...(history.length>1?{history}: {})})};
 }
 validate(kind,input){if(!uuid(input?.requestId)||!uuid(input?.taskId)||typeof input.revision!=='string'||input.acknowledge!==true)throw new AppError('Review this first step and its current context before confirming.');if(kind==='save'&&(input.sourceOutcomeId!==undefined&&!uuid(input.sourceOutcomeId)||typeof input.text!=='string'||!input.text.trim()||input.text.length>3000||!['manual','aurora'].includes(input.mode)))throw new AppError('Write a first step of 1–3,000 characters and choose who will do it.');return inputHash(kind,input);}
 async verify(input,{execution=false}={}){const r=await this.build(input.taskId);if(r.revision!==input.revision||!r.canSave)throw new AppError('The first step, task, focus, project, attempt or day changed. Compare current details before confirming again.',409);if(execution&&(!r.card||r.card.mode!=='aurora'||r.changed||!r.canPrepare))throw new AppError('Review and save the current Aurora first step, resolve blockers, and use the existing attempt if one is linked.',409);if(input.sourceOutcomeId){const o=r.outcomes.find(o=>o.id===input.sourceOutcomeId);if(!o?.canFollowOn)throw new AppError('This outcome already has a follow-on step or its step/outcome was superseded. Reopen the current card.',409);}
  return r;}
 save(input){return this.planner.vault.exclusive(async()=>{
  const requestHash=this.validate('save',input),state=await this.read(),receipt=state.receipts.find(r=>r.id===input.requestId);
  if(receipt){if(receipt.hash!==requestHash)throw new AppError('This request was already used for another first step.',409);return {...await this.build(input.taskId,state),alreadySaved:true};}
  const r=await this.verify(input),before=hash(state);if(r.card)(state.history??=[]).push(r.card);state.cards[input.taskId]={taskId:input.taskId,sequence:(r.card?.sequence||0)+1,text:input.text.trim(),mode:input.mode,context:r.context,updated:this.planner.now().toISOString(),...(input.sourceOutcomeId||r.card?.sourceOutcomeId?{sourceOutcomeId:input.sourceOutcomeId||r.card.sourceOutcomeId}:{})};state.receipts.push({id:input.requestId,hash:requestHash,taskId:input.taskId});
  try{await atomic(this.path,JSON.stringify(state,null,2),{beforeCommit:async()=>{if(hash(await this.read())!==before)throw new AppError('First steps changed. Reopen this card.',409);await this.verify(input);}});await atomic(this.marker,JSON.stringify({version:1}));}
  catch(e){if(e.status)throw e;throw new AppError('The first-step save could not be confirmed. Retry the exact request or check its receipt.',503);}
  return this.build(input.taskId,state);
 });}
 async executionReceipt(input,requestHash){const records=await this.planner.store.list('task-workflows'),d=records.find(d=>d.firstStep?.requestId===input.requestId);if(d&&d.firstStep.hash!==requestHash)throw new AppError('This request already prepared a different first step.',409);return d;}
 status({kind,input}){return this.planner.vault.exclusive(async()=>{
  if(!['save','execution'].includes(kind))throw new AppError('Choose a valid first-step request.');const h=this.validate(kind,input);let receipt;
  if(kind==='save'){receipt=(await this.read()).receipts.find(r=>r.id===input.requestId);if(receipt&&receipt.hash!==h)throw new AppError('This request was used for another first step.',409);}else receipt=await this.executionReceipt(input,h);
  return {recorded:!!receipt,...(kind==='execution'&&receipt?{executionId:receipt.id}:{}),report:await this.build(input.taskId)};
 });}
 execution(input){return this.planner.vault.exclusive(async()=>{
  const requestHash=this.validate('execution',input),prior=await this.executionReceipt(input,requestHash);
  if(prior)return this.planner.taskWorkflows.read(prior.id);
  const r=await this.verify(input,{execution:true}),task=await this.planner.taskWorkflows.current(input.taskId,{open:true,ready:true});
  const firstStep={requestId:input.requestId,hash:requestHash,taskId:input.taskId,sequence:r.card.sequence,text:r.card.text,date:r.date};
  try{return await this.planner.taskWorkflows.draft({task},{firstStep,beforeCommit:()=>this.verify(input,{execution:true})});}
  catch(e){if(e.status)throw e;throw new AppError('Execution draft preparation could not be confirmed. Check the receipt or retry this exact request.',503);}
 });}
}
