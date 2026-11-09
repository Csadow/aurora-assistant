import {atomic,AppError,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {localDay} from '../mobile/web/planner-core.js';
const hash=v=>sha(JSON.stringify(v));
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const sequence=v=>Number.isSafeInteger(v)&&v>0;
const kinds=['done','blocked','continue'];
const cardKey=c=>c.taskId+':'+c.sequence;
export const stepCards=s=>[...(s.history||[]),...Object.values(s.cards)];
export function validStepExtras(s,validCard){
 if(s.history!==undefined&&!Array.isArray(s.history)||s.outcomes!==undefined&&!Array.isArray(s.outcomes))return false;
 const cards=stepCards(s),outcomes=s.outcomes||[],ids=new Set(outcomes.map(o=>o?.id));
 if(cards.some(c=>!validCard(c))||new Set(cards.map(cardKey)).size!==cards.length||ids.size!==outcomes.length)return false;
 if((s.history||[]).some(c=>!s.cards[c.taskId]||c.sequence>=s.cards[c.taskId].sequence))return false;
 if(outcomes.some(o=>!o||!uuid(o.id)||!uuid(o.taskId)||!sequence(o.cardSequence)||!kinds.includes(o.kind)||typeof o.note!=='string'||!o.note.trim()||o.note.length>3000||!Number.isFinite(Date.parse(o.recordedAt))||!o.context||!validDate(o.context.date)||typeof o.context.timezone!=='string'||!Array.isArray(o.context.execution)||!Array.isArray(o.context.dependencyReasons)||!cards.some(c=>c.taskId===o.taskId&&c.sequence===o.cardSequence&&hash(c)===hash(o.card))||!s.receipts.some(r=>r.id===o.id&&r.taskId===o.taskId)))return false;
 return cards.every(c=>c.sourceOutcomeId===undefined||uuid(c.sourceOutcomeId)&&outcomes.some(o=>o.id===c.sourceOutcomeId&&o.taskId===c.taskId&&o.cardSequence<c.sequence));
}
export function stepOutcomeRows(s,taskId){
 const outcomes=(s.outcomes||[]).filter(o=>!taskId||o.taskId===taskId),last=new Map();for(const o of outcomes)last.set(o.taskId+':'+o.cardSequence,o.id);
 const cards=stepCards(s);
 return outcomes.map(o=>{const followed=cards.filter(c=>c.sourceOutcomeId===o.id).sort((a,b)=>a.sequence-b.sequence)[0],superseded=last.get(o.taskId+':'+o.cardSequence)!==o.id;
  return {...o,superseded,followOnSequence:followed?.sequence||null,unresolved:!superseded&&!followed&&o.kind!=='done',canFollowOn:!superseded&&!followed&&s.cards[o.taskId]?.sequence===o.cardSequence};
 });
}
export class StepOutcomes {
 constructor(steps){this.steps=steps;}
 report(taskId,cardSequence){return this.steps.planner.vault.exclusive(()=>this.build(taskId,cardSequence));}
 async build(taskId,cardSequence,state){
  const r=await this.steps.build(taskId,state);cardSequence??=r.card?.sequence;
  if(!sequence(cardSequence))throw new AppError('Choose a saved first-step version.');
  const card=r.history.find(c=>c.sequence===cardSequence);if(!card)throw new AppError('This first-step version is unavailable. Reopen its saved history.',409);
  return {taskId,date:r.date,timezone:r.timezone,card,context:r.context,detail:r.detail,changed:hash(card.context)!==hash(r.context),outcomes:r.outcomes.filter(o=>o.cardSequence===cardSequence),revision:hash({revision:r.revision,cardSequence})};
 }
 validate(i){if(!uuid(i?.requestId)||!uuid(i?.taskId)||!sequence(i.cardSequence)||typeof i.revision!=='string'||!kinds.includes(i.kind)||typeof i.note!=='string'||!i.note.trim()||i.note.length>3000||i.acknowledge!==true)throw new AppError('Review a saved step, choose its outcome and write 1–3,000 characters about what happened.');return hash({kind:'step_outcome',taskId:i.taskId,cardSequence:i.cardSequence,revision:i.revision,outcome:i.kind,note:i.note,acknowledge:i.acknowledge});}
 async verify(i){const r=await this.build(i.taskId,i.cardSequence);if(r.revision!==i.revision)throw new AppError('The step, outcomes, task, project, focus, attempt or day changed. Compare current details before recording the outcome.',409);return r;}
 record(input){return this.steps.planner.vault.exclusive(async()=>{
  const requestHash=this.validate(input),state=await this.steps.read(),receipt=state.receipts.find(r=>r.id===input.requestId);
  if(receipt){if(receipt.hash!==requestHash)throw new AppError('This request was already used for another step decision.',409);return {...await this.build(input.taskId,input.cardSequence,state),alreadySaved:true};}
  const r=await this.verify(input),before=hash(state),entry={id:input.requestId,taskId:input.taskId,cardSequence:input.cardSequence,card:r.card,kind:input.kind,note:input.note.trim(),context:r.context,recordedAt:this.steps.planner.now().toISOString()};
  (state.outcomes??=[]).push(entry);state.receipts.push({id:input.requestId,taskId:input.taskId,hash:requestHash});
  try{await atomic(this.steps.path,JSON.stringify(state,null,2),{beforeCommit:async()=>{if(hash(await this.steps.read())!==before)throw new AppError('First-step history changed. Reopen this outcome.',409);await this.verify(input);}});await atomic(this.steps.marker,JSON.stringify({version:1}));}
  catch(e){if(e.status)throw e;throw new AppError('The outcome save could not be confirmed. Retry this exact request or check its receipt.',503);}
  return this.build(input.taskId,input.cardSequence,state);
 });}
 status(input){return this.steps.planner.vault.exclusive(async()=>{const h=this.validate(input),s=await this.steps.read(),receipt=s.receipts.find(r=>r.id===input.requestId);if(receipt&&receipt.hash!==h)throw new AppError('This request was used for another step decision.',409);return {recorded:!!receipt,report:await this.build(input.taskId,input.cardSequence,s)};});}
 async review(date=localDay(this.steps.planner.now())){
  if(!validDate(date)||date>localDay(this.steps.planner.now()))throw new AppError('Choose today or an earlier outcome review date.');
  const state=await this.steps.read(),entries=stepOutcomeRows(state).filter(o=>o.context.date===date||o.unresolved&&o.context.date<date);
  return {date,observedOn:localDay(this.steps.planner.now()),entries,unresolved:entries.filter(o=>o.unresolved).length};
 }
}
