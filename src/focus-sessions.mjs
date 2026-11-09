import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomic,AppError,sha} from './vault.mjs';
const hash=v=>sha(JSON.stringify(v)),object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v)),digest=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const actions=['start','pause','resume','finish','note'],empty=()=>({version:1,sessions:[],receipts:[]});
const validRun=r=>r===null||object(r)&&uuid(r.id)&&uuid(r.epoch)&&Number.isFinite(r.mono)&&r.mono>=0&&stamp(r.startedAt);
function validHistory(s){
 let status=null,startedAt=null,index=0;
 for(const e of s.entries){
  if(e.action==='start'){if(status!==null)return false;status='running';startedAt=e.at;continue;}
  if(status===null)return false;
  if(e.action==='note')continue;
  if(e.action==='pause'&&status!=='running'||e.action==='finish'&&status==='finished'||e.action==='resume'&&status==='finished')return false;
  if(status==='running'){
   const v=s.segments[index++];if(!v||v.from!==startedAt||v.to!==e.at||e.action==='resume'&&v.milliseconds!==null)return false;
   if(v.milliseconds!==null&&(Date.parse(v.to)<Date.parse(v.from)||v.milliseconds>Date.parse(v.to)-Date.parse(v.from)+2000))return false;
  }
  status=e.action==='pause'?'paused':e.action==='finish'?'finished':'running';startedAt=status==='running'?e.at:null;
 }
 return status===s.status&&index===s.segments.length&&(s.run===null||s.run.startedAt===startedAt)&&s.created===s.entries[0].at&&s.updated===s.entries.at(-1).at;
}
function validState(s){
 if(s?.version!==1||!Array.isArray(s.sessions)||!Array.isArray(s.receipts))return false;
 const receipts=new Map(s.receipts.map(r=>[r?.id,r]));
 if(receipts.size!==s.receipts.length||s.receipts.some(r=>!uuid(r?.id)||!uuid(r.sessionId)||!digest(r.hash)))return false;
 if(new Set(s.sessions.map(x=>x?.id)).size!==s.sessions.length||s.sessions.filter(x=>x?.status==='running').length>1)return false;
 return s.sessions.every(x=>uuid(x?.id)&&uuid(x.taskId)&&x.card?.taskId===x.taskId&&Number.isSafeInteger(x.card.sequence)&&x.card.sequence>0&&typeof x.card.text==='string'&&typeof x.card.context?.task?.text==='string'&&typeof x.card.context?.date==='string'&&typeof x.timezone==='string'&&stamp(x.created)&&stamp(x.updated)&&['running','paused','finished'].includes(x.status)&&validRun(x.run)&&(x.status==='running')===(x.run!==null)&&Array.isArray(x.segments)&&x.segments.every(v=>stamp(v?.from)&&stamp(v.to)&&(v.milliseconds===null?typeof v.reason==='string'&&!!v.reason:Number.isSafeInteger(v.milliseconds)&&v.milliseconds>=0&&v.reason===null))&&Array.isArray(x.entries)&&x.entries.length>0&&x.entries[0].id===x.id&&x.entries[0].action==='start'&&new Set(x.entries.map(e=>e.id)).size===x.entries.length&&x.entries.every(e=>uuid(e?.id)&&actions.includes(e.action)&&stamp(e.at)&&typeof e.note==='string'&&e.note.length<=3000&&receipts.get(e.id)?.sessionId===x.id)&&validHistory(x))&&s.receipts.every(r=>s.sessions.some(x=>x.id===r.sessionId&&x.entries.some(e=>e.id===r.id)));
}
export class FocusSessions {
 constructor({planner,data,clock=()=>performance.now()}){this.planner=planner;this.path=join(data,'focus-sessions.json');this.marker=join(data,'focus-sessions-started.json');this.clock=clock;this.epoch=randomUUID();this.interruptions=new Map();}
 async read(){
  try{const s=JSON.parse(await readFile(this.path,'utf8'));if(!validState(s))throw Error();return s;}
  catch(e){if(e.code==='ENOENT'){try{await readFile(this.marker);}catch(m){if(m.code==='ENOENT')return empty();throw m;}throw new AppError('Saved focus sessions are missing. Restore a backup before changing them.',503);}throw new AppError('Saved focus sessions cannot be read. Restore a backup before changing them.',503);}
 }
 sample(run){
  if(!run)return null;const key=run.id,wall=this.planner.now().getTime(),mono=this.clock();let reason=this.interruptions.get(key)||null;
  if(run.epoch!==this.epoch)reason='Aurora’s backend restarted; the open interval was not recorded.';
  else if(!Number.isFinite(wall)||!Number.isFinite(mono)||mono<run.mono||wall<Date.parse(run.startedAt)||Math.abs((wall-Date.parse(run.startedAt))-(mono-run.mono))>2000)reason='The clock changed or the laptop was suspended; the open interval was not recorded.';
  if(reason)this.interruptions.set(key,reason);
  return {milliseconds:reason?null:Math.floor(mono-run.mono),reason};
 }
 view(s){const span=this.sample(s.run);return {...s,status:span?.reason?'interrupted':s.status,recordedMilliseconds:s.segments.reduce((n,v)=>n+(v.milliseconds||0),0),unrecordedIntervals:s.segments.filter(v=>v.milliseconds===null).length,runningMilliseconds:span?.milliseconds??null,interruption:span?.reason||null};}
 async overview(){const s=await this.read(),rows=s.sessions.map(x=>this.view(x)).reverse();return {open:rows.filter(x=>x.status!=='finished'),recent:rows.filter(x=>x.status==='finished').slice(0,20),finishedTotal:rows.filter(x=>x.status==='finished').length};}
 report(query={}){return this.planner.vault.exclusive(()=>this.build(query));}
 async build({taskId,id}={},state){
  state??=await this.read();if(id&&!uuid(id)||taskId&&!uuid(taskId)||!id&&!taskId)throw new AppError('Choose a task or a saved focus session.');
  const saved=id?state.sessions.find(s=>s.id===id):null;if(id&&!saved)throw new AppError('This focus session is unavailable.',404);taskId=saved?.taskId||taskId;
  let step=null,contextError=null;try{step=await this.planner.firstSteps.build(taskId);}catch(e){contextError=e.message;}
  const session=saved?this.view(saved):null,active=state.sessions.find(s=>s.status==='running'&&s.id!==id),unfinished=state.sessions.find(s=>s.taskId===taskId&&s.status!=='finished'&&s.id!==id);
  const ready=!!step?.card&&step.canSave&&!step.changed,canStart=!saved&&ready&&!active&&!unfinished,canResume=!!session&&['paused','interrupted'].includes(session.status)&&ready&&step.card.sequence===saved.card.sequence&&!active;
  const detail=contextError||(!step?.card?'Save a first step before starting a focus session.':!step.canSave?'Choose this unique, unfinished task as today’s focus.':step.changed?'Review and save the first step with its current context.':saved&&step.card.sequence!==saved.card.sequence?'This session belongs to an older step. Finish it before starting on the new step.':active?'Pause or finish the other running session first.':unfinished?'Reopen this task’s unfinished session.':'Ready when you are.');
  return {taskId,session,step,contextError,canStart,canResume,detail,otherSessionId:active?.id||unfinished?.id||null,revision:hash({state:hash(state),step:step?.revision||null,contextError,status:session?.status||null,interruption:session?.interruption||null,epoch:this.epoch})};
 }
 validate(i){
  if(!uuid(i?.requestId)||!actions.includes(i.action)||!digest(i.revision)||i.acknowledge!==true||typeof i.note!=='string'||i.note.length>3000||(i.action==='start'?!uuid(i.taskId):!uuid(i.id))||i.action==='note'&&!i.note.trim())throw new AppError('Review the session, choose an action and keep notes within 3,000 characters.');
  return hash({action:i.action,revision:i.revision,taskId:i.action==='start'?i.taskId:null,id:i.action==='start'?null:i.id,note:i.note,acknowledge:i.acknowledge});
 }
 async verify(i){const r=await this.build(i.action==='start'?{taskId:i.taskId}:{id:i.id});
  if(r.revision!==i.revision)throw new AppError('The session, step, task, focus or clock changed. Reload and compare before continuing; your note is kept.',409);
  if(i.action==='start'&&!r.canStart||i.action==='resume'&&!r.canResume)throw new AppError(r.detail,409);
  if(i.action==='pause'&&!['running','interrupted'].includes(r.session.status)||i.action==='finish'&&r.session.status==='finished')throw new AppError('This session already changed state. Reopen it before continuing.',409);
  return r;
 }
 change(i){return this.planner.vault.exclusive(async()=>{
  const requestHash=this.validate(i),state=await this.read(),receipt=state.receipts.find(r=>r.id===i.requestId);
  if(receipt){if(receipt.hash!==requestHash)throw new AppError('This request was already used for another session action.',409);return {...await this.build({id:receipt.sessionId},state),alreadySaved:true};}
  const r=await this.verify(i),before=hash(state),wall=this.planner.now();if(!Number.isFinite(wall.getTime()))throw new AppError('The wall clock is unavailable. Keep this note and retry when it recovers.',503);const at=wall.toISOString();let s;
  if(i.action==='start'){s={id:i.requestId,taskId:i.taskId,card:r.step.card,timezone:r.step.timezone,created:at,updated:at,status:'running',run:null,segments:[],entries:[]};state.sessions.push(s);}else s=state.sessions.find(s=>s.id===i.id);
  if(['pause','finish','resume'].includes(i.action)&&s.run){s.segments.push({from:s.run.startedAt,to:at,...this.sample(s.run)});s.run=null;}
  if(['start','resume'].includes(i.action)){const mono=this.clock();if(!Number.isFinite(mono)||mono<0)throw new AppError('The interval clock is unavailable. Try again when it recovers.',503);s.run={id:randomUUID(),epoch:this.epoch,mono,startedAt:at};s.status='running';}
  if(i.action==='pause')s.status='paused';if(i.action==='finish')s.status='finished';
  s.updated=at;s.entries.push({id:i.requestId,action:i.action,note:i.note.trim(),at});state.receipts.push({id:i.requestId,sessionId:s.id,hash:requestHash});
  try{await atomic(this.path,JSON.stringify(state,null,2),{beforeCommit:async()=>{if(hash(await this.read())!==before)throw new AppError('Focus sessions changed. Reopen this session.',409);await this.verify(i);}});await atomic(this.marker,JSON.stringify({version:1}));}
  catch(e){if(e.status)throw e;throw new AppError('The session action could not be confirmed. Retry this exact request or check its receipt.',503);}
  return this.build({id:s.id},state);
 });}
 status(i){return this.planner.vault.exclusive(async()=>{const h=this.validate(i),s=await this.read(),receipt=s.receipts.find(r=>r.id===i.requestId);if(receipt&&receipt.hash!==h)throw new AppError('This request was used for another session action.',409);return {recorded:!!receipt,...(receipt?{report:await this.build({id:receipt.sessionId},s)}:{})};});}
}
