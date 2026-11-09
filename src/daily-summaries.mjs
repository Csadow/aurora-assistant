import {AppError,markdown,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {localDay} from '../mobile/web/planner-core.js';
import {focusSnapshot} from './focus-review.mjs';
import {savedPlanEvents} from './saved-day-plans.mjs';
import {checkinReview} from './checkin-review.mjs';

const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const hash=v=>sha(JSON.stringify(v));
const quote=s=>String(s??'').split('\n').map(l=>'> '+l).join('\n');
const detail=t=>!t?'Unavailable task':`${t.text} · ${t.done?'marked complete':'open'} · ${t.planDate||'unscheduled'}${t.startTime?' '+t.startTime:''} · ${t.duration} min estimate`;
const noteReference=path=>path?/[\[\]|\n\r]/.test(path)?JSON.stringify(path):'[['+path+']]':'unavailable note';
const noteBody=n=>n.body.replace(/^\s*# [^\n]*\n*/, '');

// Shared receipt reconciliation: later edits/deletion must not replay an old write.
export async function noteWriteCommitted(vault,path,intent,excludeHistory=[]){
 if(!intent)return false;
 let n;try{n=await vault.read(path);}catch(e){if(e.status!==404)throw e;}
 if(n?.revision===intent)return true;
 for(const id of await vault.history(path))if(!excludeHistory.includes(id)&&sha(await vault.version(path,id))===intent)return true;
 return false;
}

export function summaryText(s){
 const sections=[`Review of ${s.date} (${s.timezone}). Current states were inspected on ${s.observedOn}.\n\nThis journal records intentions, saved changes and current task states. It does not measure time spent or establish when work was completed.`,
  '## Intentions\n\n'+(s.plans.map(p=>quote('Saved day plan: '+detail(p.task))+'\n\nSource: task-history receipt '+p.id+'; proposal '+p.proposalId+' ('+p.source+').').join('\n\n')||'No recorded day-plan saves for this date.')+'\n\n'+(s.focus.map(f=>quote('Focus intention: '+detail(f.task))).join('\n\n')||'No recorded focus intentions for this date.'),
  '## Check-ins and adjustments\n\n'+(s.checkins.entries.map(e=>`### ${e.kind} · ${e.status}\n\n${quote(e.note)}\n\nRequested work window: ${e.start}–${e.end} (${e.timezone}).${e.timezoneMismatch?' This check-in uses a different timezone.':''}\n\nSource: check-in ${e.id}.\n\n`+e.rows.map(r=>(r.original?quote('Original day plan: '+detail(r.original))+'\n\n':'')+(r.intention?quote('At check-in: '+detail(r.intention))+'\n\n':'')).join('')+(e.adjustments.map(a=>`Adjustment ${a.id}: ${a.status}; ${a.recorded.length} recorded task change(s), ${a.unrecorded} preview row(s) without a receipt.\n\n`+a.recorded.map(r=>quote('Saved change: '+detail(r.before)+' → '+detail(r.after))+'\n\nSource: task-history receipt '+r.id+' ('+r.source+', recorded '+r.recordedAt+').').join('\n\n')).join('\n\n')||'No recorded adjustment previews.')).join('\n\n')||'No recorded check-ins for this date.'),
  '## Current outcomes\n\n'+(s.tasks.map(r=>quote((r.current?'Current task: ':'Earlier reference only: ')+detail(r.current||r.reference))+(r.issue?'\n\n'+r.issue:'')+'\n\nSource: '+noteReference(r.current?.path||r.reference?.path)+'; task '+r.taskId+'.'+r.execution.map(e=>'\n\n'+quote('Aurora attempt: '+e.detail)+(e.workflowId?'\n\nWorkflow: '+e.workflowId+'.':'')).join('')).join('\n\n')||'No relevant current tasks.'),
  '## My reflection\n\nAdd what mattered, what changed, and what you want to remember.'];
 if(s.stepOutcomes?.entries.length)sections.splice(sections.length-1,0,'## Self-reported step outcomes\n\nThese are my recorded observations, not verified AI results or planner completion. Older unresolved outcomes are shown as observed now.\n\n'+s.stepOutcomes.entries.map(o=>quote(o.card.text+' · '+({done:'done for now',blocked:'blocked',continue:'continue'}[o.kind]))+'\n\n'+quote(o.note)+'\n\nRecorded '+o.context.date+' ('+o.context.timezone+'); step version '+o.cardSequence+'; outcome '+o.id+'.'+(o.superseded?' A later report supersedes this outcome.':o.followOnSequence?' Follow-on step version '+o.followOnSequence+' was saved.':o.unresolved?' Still unresolved.':'')).join('\n\n'));
 if(s.checkins.warnings.length)sections.push('## Recording limits\n\n'+s.checkins.warnings.join('\n\n'));
 return sections.join('\n\n');
}

export class DailySummaries {
 constructor({planner}){this.planner=planner;this.queue=Promise.resolve();this.folder='daily-summaries';this.noteKind='daily-summary';}
 isDate(date){return validDate(date);}
 pathFor(date){return `90 Journal/Daily summaries/${date}.md`;}
 titleFor(date){return 'Daily summary · '+date;}
 render(sources){return summaryText(sources);}
 exclusive(fn){const p=this.queue.then(fn,fn);this.queue=p.catch(()=>{});return p;}
 async target(path){try{return await this.planner.vault.read(path);}catch(e){if(e.status===404)return null;throw e;}}
 async sources(date){
  const p=this.planner,observedOn=localDay(p.now()),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  if(!validDate(date)||date>observedOn)throw new AppError('Choose today or an earlier summary date.');
  const tasks=await p.vault.tasks(),history=await p.dailyFocus?.history.read(),execution=await p.execution(),state=await p.dailyFocus?.read();
  const plans=savedPlanEvents(history,date,p.now()).map(e=>({id:e.id,proposalId:e.decision.proposalId,source:e.source,recordedAt:e.recordedAt,task:focusSnapshot(e.after)}));
  const focus=Object.entries(state?.days[timezone+'|'+date]?.choices||{}).filter(([,c])=>c.action==='focus').map(([taskId,c])=>({taskId,task:c.task,at:c.at,decision:state?.reviews?.[timezone+'|'+date]?.decisions?.[taskId]||null}));
  const checkins=await checkinReview(p,date,date,{history,tasks,execution}),ids=new Set([...tasks.filter(t=>t.planDate===date).map(t=>t.id),...plans.map(p=>p.task.id),...focus.map(f=>f.taskId),...checkins.entries.flatMap(e=>e.rows.map(r=>r.taskId))]);
  const rows=[...ids].sort().map(taskId=>{const matches=tasks.filter(t=>t.id===taskId),current=matches.length===1?focusSnapshot(matches[0]):null,reference=checkins.entries.flatMap(e=>e.rows).find(r=>r.taskId===taskId)?.intention||focus.find(f=>f.taskId===taskId)?.task||plans.find(p=>p.task.id===taskId)?.task||null;
   return {taskId,current,reference,issue:!taskId?'Task has no stable ID.':matches.length>1?'Duplicate task ID; current state is ambiguous.':!current?'Task no longer in active notes; completion is unknown.':current.scheduleError?'Task metadata needs repair.':null,execution:taskId&&current?execution.filter(e=>e.taskId===taskId):[]};
  });
  const stepOutcomes=await p.firstSteps?.outcomes.review(date);return {date,observedOn,timezone,plans,focus,checkins,tasks:rows,...(stepOutcomes?.entries.length?{stepOutcomes}: {})};
 }
 async context(date){const sources=await this.sources(date),path=this.pathFor(date),target=await this.target(path);return {date,path,sources,sourceRevision:hash(sources),suggested:this.render(sources),target:target?{revision:target.revision,content:target.content,body:noteBody(target),owned:target.kind===this.noteKind&&target.status==='journal'}:null};}
 report(date=localDay(this.planner.now())){return this.exclusive(()=>this.context(date));}
 async record(id){
  if(!uuid(id))throw new AppError('Use a valid summary review ID.');const r=await this.planner.store.get(this.folder,id);
  if(r.id!==id||!this.isDate(r.date)||r.path!==this.pathFor(r.date)||!['pending','saved','dismissed'].includes(r.status)||typeof r.body!=='string'||typeof r.content!=='string'||typeof r.sourceRevision!=='string'||!(r.targetRevision===null||typeof r.targetRevision==='string')||r.requestHash!==hash({date:r.date,sourceRevision:r.sourceRevision,targetRevision:r.targetRevision,body:r.body})||r.intent&&r.intent!==sha(r.content))throw new AppError('This summary review is damaged. Restore its record from a backup before continuing.',503);
  return r;
 }
 public(r){return {id:r.id,date:r.date,path:r.path,status:r.status,body:r.body,content:r.content,before:r.before,created:r.created,savedAt:r.savedAt||null,draft:{version:1,date:r.date,body:r.body,sourceRevision:r.sourceRevision,sourceText:r.sourceText||'Original source text was not retained. Compare the current sources before preparing another save.',targetRevision:r.targetRevision,targetContent:r.before}};}
 get(id){return this.exclusive(async()=>this.public(await this.record(id)));}
 preview(input){return this.exclusive(async()=>{
  const {requestId,date,sourceRevision,targetRevision,body}=input;
  if(!this.isDate(date)||!uuid(requestId)||typeof sourceRevision!=='string'||!(targetRevision===null||typeof targetRevision==='string')||typeof body!=='string'||!body.trim()||Buffer.byteLength(body)>120000)throw new AppError('Use a valid summary draft with 1–120,000 bytes of text.');
  const requestHash=hash({date,sourceRevision,targetRevision,body});let old;try{old=await this.record(requestId);}catch(e){if(e.status!==404)throw e;}
  if(old){if(old.requestHash!==requestHash)throw new AppError('This request was already used for another summary.',409);return this.public(old);}
  const c=await this.context(date);this.verify(c,{sourceRevision,targetRevision});
  const created=this.planner.now().toISOString(),r={id:requestId,date,path:c.path,status:'pending',body,sourceRevision,targetRevision,requestHash,before:c.target?.content||null,created,sourceText:c.suggested,taskContext:{date,timezone:c.sources.timezone,observedOn:c.sources.observedOn,tasks:c.sources.tasks.map(({taskId,current,reference,issue})=>({taskId,current,reference,issue}))},content:markdown(this.titleFor(date),body,{status:'journal',kind:this.noteKind,summary_date:date,summary_request:requestId,source_revision:sourceRevision,reviewed_at:created})};
  await this.planner.store.put(this.folder,r);return this.public(r);
 });}
 verify(c,r){if(c.target&&!c.target.owned)throw new AppError('Another note occupies this summary path. Keep it and choose a different location in the note editor.',409);if(c.sourceRevision!==r.sourceRevision||(c.target?.revision||null)!==r.targetRevision)throw new AppError('Summary sources or the saved note changed. Compare current sources and the saved note before preparing another review.',409);}
 committed(r){return noteWriteCommitted(this.planner.vault,r.path,r.intent);}
 decide({id,action}){return this.exclusive(async()=>{
  if(!['save','dismiss'].includes(action))throw new AppError('Choose save or return to editing.');
  const r=await this.record(id);if(r.status==='saved')return this.public(r);
  if(r.status==='dismissed'){if(action==='save')throw new AppError('This summary review was dismissed. Prepare a new review.',409);return this.public(r);}
  try{
   if(await this.committed(r)){r.status='saved';r.savedAt=this.planner.now().toISOString();await this.planner.store.put(this.folder,r);return this.public(r);}
   if(action==='dismiss'){r.status='dismissed';await this.planner.store.put(this.folder,r);return this.public(r);}
   if(r.intent)throw new AppError('The earlier summary write cannot be confirmed from the note or its history. Return to editing, compare the current note and prepare a fresh review before writing again.',409);
   this.verify(await this.context(r.date),r);
   r.intent=sha(r.content);await this.planner.store.put(this.folder,r);
   await this.planner.vault.save(r.path,r.content,r.targetRevision,{beforeCommit:async()=>this.verify(await this.context(r.date),r)});
   r.status='saved';r.savedAt=this.planner.now().toISOString();await this.planner.store.put(this.folder,r);return this.public(r);
  }catch(e){if(e.status)throw e;throw new AppError('The summary save could not be confirmed. It may already be saved; retry the same review.',503);}
 });}
}
