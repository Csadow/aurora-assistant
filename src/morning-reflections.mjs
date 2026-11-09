import {AppError,sha} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {focusHash,focusSnapshot} from './focus-review.mjs';
import {localDay} from '../mobile/web/planner-core.js';
const hash=value=>sha(JSON.stringify(value));
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const summaryDate=n=>n.kind==='daily-summary'&&n.status==='journal'?n.path.match(/^90 Journal\/Daily summaries\/(\d{4}-\d{2}-\d{2})\.md$/)?.[1]:null;
function excerpt(n){const body=n.body.replace(/^\s*# [^\n]*\n*/,''),reflection=body.match(/^## My reflection\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim().replace(/^Add what mattered, what changed, and what you want to remember\.\s*/,'');const text=reflection||body.trim();return {text:text.slice(0,1800),truncated:text.length>1800};}
export class MorningReflections {
 constructor({planner}){this.planner=planner;}
 async index(){
  const p=this.planner,date=localDay(p.now()),notes=(await p.vault.list()).filter(n=>validDate(summaryDate(n))&&summaryDate(n)<=date).sort((a,b)=>b.path.localeCompare(a.path)),records=await p.store.list('daily-summaries');
  // Validate recovery records as well: unreadable state must never look like an empty inbox.
  const pending=[];for(const raw of records.filter(r=>r.status==='pending')){const r=await p.summaries.record(raw.id);if(r.status==='pending')pending.push({id:r.id,date:r.date,created:r.created,writeAttempted:!!r.intent});}
  return {date,notes,records,pending:pending.sort((a,b)=>b.date.localeCompare(a.date)||b.created.localeCompare(a.created))};
 }
 async overview(){const r=await this.index(),n=r.notes[0];return {date:r.date,latest:n?{date:summaryDate(n),path:n.path,revision:n.revision,...excerpt(n)}:null,pending:r.pending,savedDays:r.notes.map(n=>summaryDate(n))};}
 report(date){return this.planner.vault.exclusive(()=>this.build(date));}
 // Non-locking for focus's atomic commit guard.
 async build(selectedDate){
  const p=this.planner,index=await this.index(),date=index.date,timezone=p.dailyFocus.timezone();selectedDate??=index.notes[0]&&summaryDate(index.notes[0]);
  if(!validDate(selectedDate)||selectedDate>date)throw new AppError('Choose an available saved reflection from today or earlier.');
  const note=index.notes.find(n=>summaryDate(n)===selectedDate);if(!note)throw new AppError('This saved reflection is no longer available. Reload the briefing.',409);
  const front=note.content.match(/^---\r?\n([\s\S]*?)\r?\n---/),raw=front?.[1].match(/^summary_request:\s*(.+)$/m)?.[1];let id;try{id=JSON.parse(raw);}catch{}
  let record=null,context=null;const warnings=[];
  if(uuid(id))try{const candidate=await p.summaries.record(id);if(candidate.date===selectedDate&&candidate.path===note.path&&(candidate.status==='saved'||await p.summaries.committed(candidate))){record=candidate;context=candidate.taskContext||null;}}catch(e){warnings.push(e.status===404?'The publication record is missing. Recorded summary task context is unavailable.':e.message);}
  if(!context)warnings.push('This summary has no retained structured task context. Tasks are not inferred from its text; only recorded carry-forward decisions can be offered.');
  if(context?.timezone!==undefined&&context.timezone!==timezone)warnings.push('The summary task context was recorded in '+context.timezone+'. Compare dates in your current timezone.');
  const history=await p.dailyFocus.history.read(),carry=new Map();
  for(const e of history?.events||[])if(uuid(e.taskId)&&['aurora_save','recovered_save'].includes(e.source)&&['evening_review','weekly_review'].includes(e.decision?.kind)&&e.decision.action==='move'&&validDate(e.before?.planDate)&&validDate(e.after?.planDate)&&e.after.planDate>e.before.planDate&&e.kinds.includes('rescheduled')&&Number.isFinite(Date.parse(e.recordedAt))&&new Date(e.recordedAt)<=p.now()&&localDay(new Date(e.recordedAt))>=selectedDate)carry.set(e.taskId,e);
  if(history?.pending)warnings.push('A task save is awaiting history reconciliation. Unrecorded changes are not offered as carry-forward decisions.');
  if(context&&(context.date!==selectedDate||!validDate(context.observedOn)||typeof context.timezone!=='string'||!Array.isArray(context.tasks)||context.tasks.some(t=>!t||!uuid(t.taskId)&&t.taskId!=null||[t.current,t.reference].some(s=>s!=null&&(typeof s!=='object'||s.id!==t.taskId||typeof s.text!=='string'||typeof s.path!=='string')))))throw new AppError('The saved summary task context is damaged. Restore its record before choosing from it.',503);
  const originals=new Map((context?.tasks||[]).filter(t=>uuid(t.taskId)).map(t=>[t.taskId,t.current||t.reference])),ids=[...new Set([...originals.keys(),...carry.keys()])],focus=await p.dailyFocus.build(undefined,{includeIds:ids});
  const rows=ids.map(taskId=>{const f=focus.rows.find(r=>r.taskId===taskId),e=carry.get(taskId),original=originals.get(taskId)||null,c= e?{id:e.id,source:e.source,recordedAt:e.recordedAt,proposalId:e.decision.proposalId,from:focusSnapshot(e.before),to:focusSnapshot(e.after)}:null;
   return {taskId,text:f?.text||original?.text||e?.after.text||'Unavailable task',original,carry:c,current:f?.task||null,changed:!!original&&focusHash(original)!==focusHash(f?.task)||!!c&&focusHash(c.to)!==focusHash(f?.task),identityIssue:f?.identityIssue||null,contextRevision:f?.contextRevision||null,readiness:f?.readiness||'unavailable',detail:f?.detail||'Task is no longer available.',choice:f?.choice||null,execution:f?.execution||[],selectable:!!f?.task&&!f.identityIssue&&!f.task.done};
  });
  const summary={date:selectedDate,path:note.path,revision:note.revision,...excerpt(note),editedSincePublication:!!record&&sha(record.content)!==note.revision,hasTaskContext:!!context};
  return {date,timezone,summary,rows,warnings,pending:index.pending,savedDays:index.notes.map(n=>summaryDate(n)),focusRevision:focus.revision,revision:hash({date,timezone,summary,context,rows,warnings,focusRevision:focus.revision})};
 }
 request(input){
  const {requestId,date,timezone,summaryDate,revision,focusRevision,taskId,contextRevision}=input;
  if(!uuid(requestId)||!uuid(taskId)||!validDate(summaryDate)||[revision,focusRevision,contextRevision,timezone].some(v=>typeof v!=='string'))throw new AppError('Choose a task from the current reflection review.');
  const source={kind:'reflection',date:summaryDate,path:`90 Journal/Daily summaries/${summaryDate}.md`,revision};
  return {input:{requestId,date,timezone,revision:focusRevision,taskId,contextRevision,action:'focus'},options:{source,includeIds:[taskId],verifySource:async()=>{const r=await this.build(summaryDate),row=r.rows.find(r=>r.taskId===taskId);if(r.date!==date||r.timezone!==timezone||r.revision!==revision||r.focusRevision!==focusRevision||!row?.selectable||row.contextRevision!==contextRevision)throw new AppError('The reflection, task, saved decision, focus or day changed. Reload and compare the current details before choosing focus.',409);}}};
 }
 async choose(input){const r=this.request(input);try{return await this.planner.dailyFocus.decide(r.input,r.options);}catch(e){if(e.status)throw e;throw new AppError('The focus choice could not be confirmed. It may already be recorded; retry the exact request or check its receipt.',503);}}
 status(input){const r=this.request(input);return this.planner.dailyFocus.decisionStatus(r.input,r.options);}
}
