import {AppError,sha} from './vault.mjs';
import {tasksIn,taskLine,schedule,validDate} from './task-meta.mjs';
import {localDay,minutes,clock} from '../mobile/web/planner-core.js';
import {TaskProposals} from './task-proposals.mjs';
import {stepOutcomeRows} from './step-outcomes.mjs';
import {noteWriteCommitted} from './daily-summaries.mjs';
const folder='estimate-reviews',hash=v=>sha(JSON.stringify(v));
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const estimateInput=i=>({taskId:i.taskId,revision:i.revision,duration:i.duration,basis:i.basis,note:i.note});
const valid=i=>uuid(i?.taskId)&&typeof i.revision==='string'&&Number.isInteger(i.duration)&&i.duration>=5&&i.duration<=720&&['representative','partial'].includes(i.basis)&&typeof i.note==='string'&&!!i.note.trim()&&i.note.length<=3000;
const end=t=>t?.startTime?clock(minutes(t.startTime)+t.duration):null;
function contentFor(content,before,after){const lines=content.split('\n'),line=lines[before.line];if(!/^\s*[-*] \[ \] .+$/.test(line||''))throw new AppError('The original task line is unavailable.',409);lines[before.line]=line.replace(/^(\s*[-*] )\[ \] .+$/,(_,prefix)=>prefix+'[ ] '+taskLine(after.text,after,after.id));return lines.join('\n');}
export function estimateSourcesText(s){return [
 'Observed '+s.date+' · '+s.timezone,
 s.task?s.task.text+'\nCurrent planning estimate: '+s.task.duration+' min; '+(s.task.planDate||'unscheduled')+' '+(s.task.startTime||'no reserved time')+(s.task.startTime?'–'+end(s.task):''):'Task unavailable or ambiguous. Original reference: '+(s.reference?.text||'No recorded session'),
 s.task?'Deadline: '+(s.task.due||'none')+'; reminder: '+(s.task.remindAt||'none')+'; priority: '+s.task.priority+'; project: '+(s.task.project||'none')+'; parent: '+(s.task.parent||'none')+'; prerequisites: '+(s.task.dependsOn?.join(', ')||'none'):'',
 'Current schedule overlaps:\n'+(s.context?.conflicts.map(c=>c.kind+' · '+c.title+' · '+c.time).join('\n')||'None detected.'),
 Math.floor(s.totals.recordedMilliseconds/60000)+'m '+String(Math.floor(s.totals.recordedMilliseconds/1000)%60).padStart(2,'0')+'s recorded in '+s.totals.recordedIntervals+' closed intervals; '+s.totals.unknownIntervals+' unknown; '+s.totals.openIntervals+' open. All recorded sessions for this task are shown, not just the selected day/week. This is not a recommended estimate or proof of productive work.',
 ...s.sessions.map(r=>'Session '+r.id+' · '+r.status+' · '+r.timezone+'\nOriginal task: '+r.card.context.task.text+'\nOriginal step '+r.card.sequence+': '+r.card.text+'\n'+r.intervals.map(v=>v.from+' → '+v.to+' · '+(v.milliseconds===null?'Unknown: '+v.reason:Math.floor(v.milliseconds/1000)+' recorded seconds')).join('\n')+(r.open?'\nOpen interval since '+r.open.startedAt+'; excluded from totals. '+(r.open.interruption||''):'')+'\n'+r.notes.map(n=>n.action+' · '+n.at+' · '+n.note).join('\n')),
 s.currentStep?'Current first step '+s.currentStep.sequence+': '+s.currentStep.text:'No current first step.',
 'Latest self-reports for these step versions (not verified AI work):\n'+(s.outcomes.map(o=>o.card.text+' · '+o.kind+' · '+o.recordedAt+'\n'+o.note).join('\n\n')||'None recorded.'),
 'Aurora attempts observed now:\n'+(s.execution.map(e=>e.detail+(e.results?'\n'+e.results.checksPassed+' of '+e.results.checksTotal+' checks recorded passing. '+(e.results.notice||'')+'\n'+[e.results.error,e.results.question,...e.results.unresolved].filter(Boolean).join('\n'):'')).join('\n\n')||'None linked.'),
 ...s.issues,...s.warnings
 ].join('\n\n');}
export class EstimateReviews {
 constructor({planner}){this.planner=planner;this.queue=Promise.resolve();this.conflicts=new TaskProposals({vault:planner.vault,store:planner.store});}
 exclusive(fn){const r=this.queue.then(fn,fn);this.queue=r.catch(()=>{});return r;}
 async sources(taskId){
  if(!uuid(taskId))throw new AppError('Choose a task with a stable ID.');
  const p=this.planner,now=p.now(),date=localDay(now),timezone=p.dailyFocus.timezone(),notes=await p.vault.list(),matches=tasksIn(notes).filter(t=>t.id===taskId),task=matches.length===1?matches[0]:null,state=await p.focusSessions.read(),steps=await p.firstSteps.read(),execution=(await p.execution()).filter(e=>e.taskId===taskId),issues=[],warnings=[];
  const sessions=state.sessions.filter(s=>s.taskId===taskId).map(s=>({id:s.id,card:s.card,timezone:s.timezone,status:p.focusSessions.view(s).status,intervals:s.segments,notes:s.entries.filter(e=>e.note),open:s.run?{startedAt:s.run.startedAt,interruption:p.focusSessions.sample(s.run).reason}:null})),intervals=sessions.flatMap(s=>s.intervals),totals={recordedMilliseconds:intervals.reduce((n,s)=>n+(s.milliseconds||0),0),recordedIntervals:intervals.filter(s=>s.milliseconds!==null).length,unknownIntervals:intervals.filter(s=>s.milliseconds===null).length,openIntervals:sessions.filter(s=>s.open).length};
  if(!task)issues.push(matches.length?'Duplicate task ID. Repair its identity before changing the estimate.':'Task no longer exists in active notes.');
  if(task?.done)issues.push('This task is already complete. Its estimate stays unchanged.');if(task?.scheduleError)issues.push('Repair task metadata before changing its estimate.');
  if(!totals.recordedMilliseconds)issues.push('No recorded elapsed time yet. Use the ordinary task editor for a manual estimate, or record a session first.');
  if(totals.openIntervals)issues.push('Pause or finish this task’s open session before reviewing an estimate change.');
  if(task?.planDate===date&&task.startTime&&minutes(task.startTime)<=now.getHours()*60+now.getMinutes()&&minutes(task.startTime)+task.duration>now.getHours()*60+now.getMinutes())issues.push('This task’s scheduled block is in progress. Review its estimate after the block ends.');
  if(execution.some(e=>['running','planning','queued','waiting_approval','creating'].includes(e.status)))issues.push('Resolve the running or waiting Aurora attempt before changing this estimate.');
  if(totals.unknownIntervals||sessions.some(s=>s.status!=='finished'))warnings.push('These records contain unknown or unfinished work. Judge whether they represent the task before using them.');
  if(sessions.some(s=>s.card.context.task.text!==task?.text))warnings.push('Some sessions refer to earlier task wording. Check whether their scope still applies.');
  let context=null;
  if(task&&!task.scheduleError)try{context=this.conflicts.context(notes,task,task,timezone,task.planDate&&task.startTime?await p.calendar?.context({includeLinked:true}):undefined);warnings.push(...context.warnings);}catch(e){issues.push(e.message);}
  return {taskId,date,timezone,task,reference:sessions[0]?.card.context.task||null,currentStep:steps.cards[taskId]||null,sessions,totals,outcomes:stepOutcomeRows(steps).filter(o=>!o.superseded&&o.taskId===taskId&&sessions.some(s=>s.card.sequence===o.cardSequence)),execution,context,issues,warnings};
 }
 async build(taskId){const sources=await this.sources(taskId);return {taskId,sources,revision:hash(sources),sourceText:estimateSourcesText(sources),canAdjust:!sources.issues.length};}
 report(taskId){return this.exclusive(()=>this.build(taskId));}
 async refreshSources(taskId){const tasks=(await this.planner.vault.tasks()).filter(t=>t.id===taskId);if(tasks.length===1&&tasks[0].planDate&&tasks[0].startTime)await this.planner.calendar?.fresh(tasks[0].planDate);return this.build(taskId);}
 refresh(taskId){return this.exclusive(()=>this.refreshSources(taskId));}
 async record(id){
  if(!uuid(id))throw new AppError('Use a valid estimate review ID.');const r=await this.planner.store.get(folder,id);
  try{if(r.id!==id||!valid(r.input)||r.taskId!==r.input.taskId||r.requestHash!==hash(estimateInput(r.input))||!validDate(r.sources.date)||r.input.revision!==hash(r.sources)||r.before.id!==r.taskId||r.before.done||r.before.scheduleError||r.path!==r.before.path||hash(r.before)!==hash(r.sources.task)||hash(r.after)!==hash({...r.before,...schedule({...r.before,duration:r.input.duration})})||r.before.duration===r.after.duration||typeof r.beforeContent!=='string'||r.before.revision!==sha(r.beforeContent)||r.content!==contentFor(r.beforeContent,r.before,r.after)||!Array.isArray(r.conflicts)||!Array.isArray(r.warnings)||typeof r.contextHash!=='string'||!['pending','saved','dismissed'].includes(r.status)||r.intent&&(r.intent!==sha(r.content)||!Array.isArray(r.historyBefore)||r.historyBefore.some(id=>typeof id!=='string'||!/^\d+-[\w-]+\.md$/.test(id))))throw Error();}catch{throw new AppError('This estimate review is damaged. Restore its record from a backup before continuing.',503);}return r;
 }
 public(r){return {id:r.id,taskId:r.taskId,status:r.status,created:r.created,path:r.path,before:r.before,after:r.after,beforeEnd:end(r.before),afterEnd:end(r.after),basis:r.input.basis,note:r.input.note,conflicts:r.conflicts,priorConflicts:r.sources.context?.conflicts||[],warnings:r.warnings,sourceText:estimateSourcesText(r.sources),draft:{version:1,taskId:r.taskId,revision:r.input.revision,sourceText:estimateSourcesText(r.sources),duration:r.input.duration,basis:r.input.basis,note:r.input.note}};}
 get(id){return this.exclusive(async()=>this.public(await this.record(id)));}
 async verify(r){const c=await this.build(r.taskId);if(!c.canAdjust||c.revision!==r.input.revision)throw new AppError('The task, sessions, outcomes, attempt, schedule or day changed. Compare current sources before preparing another estimate review.',409);const notes=await this.planner.vault.list(),context=this.conflicts.context(notes,r.after,r.before,c.sources.timezone,r.after.planDate&&r.after.startTime?await this.planner.calendar?.context({includeLinked:true}):undefined);if(context.hash!==r.contextHash||hash(context.conflicts)!==hash(r.conflicts))throw new AppError('The schedule changed. Prepare a fresh estimate review.',409);}
 preview(input){return this.exclusive(async()=>{
  if(!uuid(input?.requestId)||!valid(input))throw new AppError('Choose a 5–720 minute estimate, judge the records and explain your reason in 1–3,000 characters.');
  let old;try{old=await this.record(input.requestId);}catch(e){if(e.status!==404)throw e;}if(old){if(old.requestHash!==hash(estimateInput(input)))throw new AppError('This request was already used for another estimate review.',409);return this.public(old);}
  const c=await this.refreshSources(input.taskId);if(c.revision!==input.revision||!c.canAdjust)throw new AppError('The task, sessions, outcomes, attempt, schedule or day changed. Compare current sources before preparing another estimate review.',409);
  const before=c.sources.task,after={...before,...schedule({...before,duration:input.duration})};if(before.duration===after.duration)throw new AppError('Choose a different planning estimate.');
  const notes=await this.planner.vault.list(),n=notes.find(n=>n.path===before.path);if(n?.revision!==before.revision)throw new AppError('The task note changed. Compare current sources.',409);
  const context=this.conflicts.context(notes,after,before,c.sources.timezone,after.planDate&&after.startTime?await this.planner.calendar?.context({includeLinked:true}):undefined),r={id:input.requestId,taskId:input.taskId,input:estimateInput(input),requestHash:hash(estimateInput(input)),sources:c.sources,status:'pending',created:this.planner.now().toISOString(),path:before.path,before,after,beforeContent:n.content,content:contentFor(n.content,before,after),contextHash:context.hash,conflicts:context.conflicts,warnings:[...c.sources.warnings,...context.warnings,...(after.planDate&&after.startTime?['Changing this estimate changes the block’s end time. Linked Google events keep their current times until a separate calendar sync review.']:['This task has no reserved time. The estimate does not reserve a new block.'])]};
  await this.verify(r);await this.planner.store.put(folder,r);return this.public(r);
 });}
 decide({id,action,allowConflicts=false}){return this.exclusive(async()=>{
  if(!['save','dismiss'].includes(action))throw new AppError('Choose save or return to editing.');const p=this.planner,r=await this.record(id);if(r.status==='saved')return this.public(r);if(r.status==='dismissed'){if(action==='save')throw new AppError('This estimate review was dismissed. Prepare another review.',409);return this.public(r);}
  try{
   if(await noteWriteCommitted(p.vault,r.path,r.intent,r.historyBefore)){r.status='saved';await p.store.put(folder,r);return this.public(r);}
   if(action==='dismiss'){r.status='dismissed';await p.store.put(folder,r);return this.public(r);}
   if(r.intent)throw new AppError('The earlier estimate write cannot be confirmed from the note or its history. Return to editing and prepare a fresh review before saving again.',409);
   if(r.conflicts.length&&allowConflicts!==true)throw new AppError('Review the schedule conflicts and explicitly allow them before saving.',409);
   if(r.after.planDate&&r.after.startTime)await p.calendar?.fresh(r.after.planDate);await this.verify(r);
   r.historyBefore=await p.vault.history(r.path);r.intent=sha(r.content);await p.store.put(folder,r);
   await p.vault.save(r.path,r.content,r.before.revision,{beforeCommit:()=>this.verify(r),taskSource:{kind:'estimate_review',proposalId:r.id,actions:{[r.taskId]:'adjust_estimate'}}});
   r.status='saved';await p.store.put(folder,r);return this.public(r);
  }catch(e){if(e.status)throw e;throw new AppError('The estimate save could not be confirmed. It may already be saved; reopen this same review to check its receipt.',503);}
 });}
 async index(){const rows=[];for(const raw of await this.planner.store.list(folder)){const r=await this.record(raw.id);rows.push({id:r.id,taskId:r.taskId,title:r.before.text,status:r.status,created:r.created,before:r.before.duration,after:r.after.duration,writeAttempted:!!r.intent});}return rows;}
 async overview(){const state=await this.planner.focusSessions.read(),tasks=await this.planner.vault.tasks(),ids=[...new Set(state.sessions.map(s=>s.taskId))];return {tasks:ids.map(taskId=>{const matches=tasks.filter(t=>t.id===taskId),sessions=state.sessions.filter(s=>s.taskId===taskId);return {taskId,text:(matches.length===1?matches[0]:sessions[0].card.context.task).text,duration:matches.length===1?matches[0].duration:null,sessions:sessions.length};}),reviews:await this.index()};}
}
