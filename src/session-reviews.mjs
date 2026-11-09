import {DailySummaries} from './daily-summaries.mjs';
import {AppError} from './vault.mjs';
import {validDate} from './task-meta.mjs';
import {weekStart} from './weekly-planner.mjs';
import {focusSnapshot} from './focus-review.mjs';
import {stepOutcomeRows} from './step-outcomes.mjs';
const shift=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const quoted=s=>String(s??'').split('\n').map(l=>'> '+l).join('\n');
const duration=ms=>Math.floor(ms/60000)+'m '+String(Math.floor(ms/1000)%60).padStart(2,'0')+'s';
const ref=path=>path?/[\[\]|\r\n]/.test(path)?JSON.stringify(path):'[['+path+']]':'unavailable note';
const outcomeLabel={done:'Done for now',blocked:'Blocked',continue:'Continue'};
export function sessionReviewText(s){
 const text=[`Session review: ${s.start}${s.end===s.start?'':' to '+s.end} (${s.timezone}). Current task and attempt states observed on ${s.observedOn}.`,
  '## Recorded intervals\n\n'+duration(s.totals.recordedMilliseconds)+' recorded in '+s.totals.recordedIntervals+' closed interval(s). '+s.totals.unrecordedIntervals+' closed interval(s) have unknown duration; '+s.totals.openIntervals+' relevant interval(s) remain open.\n\nIntervals belong to the date they were paused or finished in this review timezone. An interval crossing midnight is counted wholly on its closing date. Open intervals and unknown durations contribute no time. Elapsed intervals are not proof of productive work or task completion.',
  ...s.days.map(d=>'### '+d.date+'\n\n'+duration(d.recordedMilliseconds)+' recorded · '+d.recordedIntervals+' known interval(s) · '+d.unrecordedIntervals+' unknown interval(s).'),
  '## Sessions and interruption notes\n\n'+(s.rows.map(r=>'### '+r.id+'\n\n'+quoted(r.card.context.task.text)+'\n\n'+quoted(r.card.text)+'\n\nOriginal step version '+r.card.sequence+'; original session timezone '+r.timezone+'. Current session status: '+r.status+'.'+(r.timezoneMismatch?' Dates below use the review timezone.':'')+'\n\n'+r.intervals.map(v=>quoted(v.from+' → '+v.to+' · Closed on '+v.date+' · '+(v.milliseconds===null?'Unrecorded: '+v.reason:duration(v.milliseconds)))).join('\n\n')+(r.open?'\n\nOpen interval since '+r.open.startedAt+'; excluded from recorded totals.'+(r.open.interruption?' '+r.open.interruption:''):'')+'\n\n'+(r.notes.map(e=>quoted(e.action+' · '+e.at+'\n'+e.note)).join('\n\n')||'No session notes recorded in this period.')+'\n\nSource: focus session '+r.id+'.').join('\n\n')||'No sessions or notes recorded for this period.'),
  '## Current tasks and self-reports\n\n'+(s.tasks.map(t=>quoted((t.current?'Current task: ':'Original task reference: ')+(t.current||t.reference).text)+'\n\n'+(t.issue||('Current planner checkbox: '+(t.current.done?'marked complete':'open')+'. This does not establish when work was completed.'))+'\n\nSource: '+ref(t.current?.path||t.reference.path)+'; task '+t.taskId+'.').join('\n\n')||'No related tasks.')+'\n\n'+(s.outcomes.map(o=>quoted(o.card.text+' · '+outcomeLabel[o.kind])+'\n\n'+quoted(o.note)+'\n\nSelf-report recorded '+o.recordedAt+'; step version '+o.cardSequence+'; outcome '+o.id+'. This is the latest report observed for that step, not verified AI work or planner completion.'+(o.followOnSequence?' Follow-on step '+o.followOnSequence+' exists.':'')).join('\n\n')||'No self-reports recorded for the reviewed step versions.'),
  '## Aurora results observed now\n\n'+(s.execution.map(e=>quoted(e.detail)+'\n\nExecution '+e.id+(e.workflowId?'; workflow '+e.workflowId:'')+'.'+(e.results?'\n\n'+quoted(e.results.notice||'Recorded attempt results')+'\n\nChecks recorded passing: '+e.results.checksPassed+' of '+e.results.checksTotal+'.'+(e.results.error?'\n\n'+quoted('Attempt error: '+e.results.error):'')+(e.results.question?'\n\n'+quoted('Waiting question: '+e.results.question):'')+'\n\nShowing '+e.results.steps.length+' of '+e.results.stepCount+' recorded steps.'+e.results.steps.map(x=>'\n\n'+quoted(x.title+' · '+x.status+'\n'+x.summary)).join('')+(e.results.unresolved.length?'\n\nUnresolved:\n\n'+e.results.unresolved.map(quoted).join('\n\n'):''):' No verified result record is available here.')).join('\n\n')||'No linked Aurora attempt results. Session elapsed time does not establish AI completion.'),
  '## My reflection\n\nAdd what helped, what interrupted you, and what you want to try next.'];
 return text.join('\n\n');
}
export class SessionReviews extends DailySummaries {
 constructor({planner,period}){super({planner});if(!['day','week'].includes(period))throw new AppError('Choose a daily or weekly session review.');this.period=period;this.folder='session-summaries-'+period;this.noteKind='session-summary-'+period;}
 isDate(date){return validDate(date)&&(this.period==='day'||weekStart(date)===date);}
 pathFor(date){return `90 Journal/Session reviews/${this.period}/${date}.md`;}
 titleFor(date){return (this.period==='day'?'Daily':'Weekly')+' session review · '+date;}
 render(s){return sessionReviewText(s);}
 report(date){return this.exclusive(()=>this.context(date));}
 async context(date){date??=this.day(this.planner.now());if(this.period==='week')date=weekStart(date);return super.context(date);}
 day(value){return new Intl.DateTimeFormat('en-CA',{timeZone:this.planner.dailyFocus.timezone(),year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}
 async sources(date){
  const p=this.planner,timezone=p.dailyFocus.timezone(),observedOn=this.day(p.now());if(!this.isDate(date)||date>observedOn)throw new AppError('Choose today or an earlier session review.');
  const end=this.period==='day'?date:shift(date,6),inside=d=>d>=date&&d<=end,days=Array.from({length:this.period==='day'?1:7},(_,i)=>({date:shift(date,i),recordedMilliseconds:0,recordedIntervals:0,unrecordedIntervals:0}));
  const state=await p.focusSessions.read(),stepState=await p.firstSteps.read(),tasks=await p.vault.tasks(),execution=await p.execution(),rows=[];
  for(const s of state.sessions){
   const intervals=s.segments.map(v=>({...v,date:this.day(v.to)})).filter(v=>inside(v.date)),notes=s.entries.filter(e=>e.note&&inside(this.day(e.at))),open=s.run&&(inside(this.day(s.run.startedAt))||inside(observedOn)&&this.day(s.run.startedAt)<=end)?{startedAt:s.run.startedAt,interruption:p.focusSessions.sample(s.run).reason}:null;
   if(!intervals.length&&!notes.length&&!open&&!inside(this.day(s.created)))continue;
   for(const v of intervals){const d=days.find(d=>d.date===v.date);if(v.milliseconds===null)d.unrecordedIntervals++;else{d.recordedMilliseconds+=v.milliseconds;d.recordedIntervals++;}}
   rows.push({id:s.id,taskId:s.taskId,card:s.card,timezone:s.timezone,timezoneMismatch:s.timezone!==timezone,status:p.focusSessions.view(s).status,created:s.created,intervals,notes,open});
  }
  const ids=new Set(rows.map(r=>r.taskId)),related=[...ids].map(taskId=>{const matches=tasks.filter(t=>t.id===taskId),current=matches.length===1?focusSnapshot(matches[0]):null,reference=rows.find(r=>r.taskId===taskId).card.context.task;return {taskId,current,reference,issue:matches.length>1?'Duplicate task ID; current completion is unknown.':!current?'Task unavailable; current completion is unknown.':current.scheduleError?'Task metadata needs repair.':null};});
  const outcomes=stepOutcomeRows(stepState).filter(o=>!o.superseded&&rows.some(r=>r.taskId===o.taskId&&r.card.sequence===o.cardSequence));
  return {period:this.period,date,start:date,end,observedOn,timezone,days,rows,tasks:related,outcomes,execution:execution.filter(e=>ids.has(e.taskId)&&related.some(t=>t.taskId===e.taskId&&t.current&&!t.issue)),totals:{recordedMilliseconds:days.reduce((n,d)=>n+d.recordedMilliseconds,0),recordedIntervals:days.reduce((n,d)=>n+d.recordedIntervals,0),unrecordedIntervals:days.reduce((n,d)=>n+d.unrecordedIntervals,0),openIntervals:rows.filter(r=>r.open).length}};
 }
 public(r){return {...super.public(r),period:this.period};}
 async index(){const pending=[];for(const raw of await this.planner.store.list(this.folder)){const r=await this.record(raw.id);if(r.status==='pending')pending.push({id:r.id,date:r.date,period:this.period,created:r.created,writeAttempted:!!r.intent});}return pending.sort((a,b)=>b.date.localeCompare(a.date)||b.created.localeCompare(a.created));}
}
