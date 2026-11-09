import {readView} from './read-view.mjs';
import {weekCapacityReport,assessWeekCapacity,assessWeekWorkload} from './week-capacity.mjs';
import {dayStart} from './day-start.mjs';
import {dayHandoff} from './day-handoff.mjs';
import {noteWriteCommitted} from './daily-summaries.mjs';
import {checkinReview} from './checkin-review.mjs';
import {outcomePlanningRows} from './outcome-planning.mjs';
import {remainderCandidates,previewRemainder,verifyRemainder} from './remainder-planning.mjs';
import {savedDayPlans} from './saved-day-plans.mjs';
import {planningCapacity} from './planning-capacity.mjs';
import {nextDayReport,previewNextDay,verifyNextDay} from './next-day-planning.mjs';
import {verifyReviewFocus} from './focus-review.mjs';
import {previewFocus,verifyFocusPlan} from './focus-planning.mjs';
import {calendarBlocks} from './calendar-time.mjs';
import {projectContext} from './task-projects.mjs';
import {taskGraph,taskRef} from '../mobile/web/task-links.js';
import {AppError,sha} from './vault.mjs';
import {tasksIn,taskLine,schedule,validDate} from './task-meta.mjs';
import {suggestDay,localDay,minutes,taskKey} from '../mobile/web/planner-core.js';
import {readTimetable,classesForDay,TIMETABLE_PATH} from '../mobile/web/timetable.js';
import {buildWeek} from './weekly-planner.mjs';
const zone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
const fingerprint=notes=>sha(JSON.stringify(notes.filter(n=>n.path===TIMETABLE_PATH||tasksIn([n]).length).map(n=>[n.path,n.revision]).sort()));
const executionStamp=items=>JSON.stringify((items||[]).map(x=>[x.id,x.executionRevision]).sort((a,b)=>a[0].localeCompare(b[0])));
export class DayPlanning {
 constructor({vault,store,calendar,taskWorkflows,now=()=>new Date()}){Object.assign(this,{vault,store,calendar,taskWorkflows,now});this.queue=Promise.resolve();}
 briefing(){return readView(()=>this.buildBriefing());}
 async buildBriefing(){const now=this.now(),date=localDay(now),notes=await this.vault.list(),week=buildWeek(notes,{date,timezone:zone(),now,calendar:await this.calendar?.context()}),day=week.days.find(d=>d.date===date);if(this.recurring?.error)week.warnings.push('Recurring task generation needs attention: '+this.recurring.error);let focus=null,focusError=null;try{focus=await this.dailyFocus?.report()||null;}catch(e){focusError=e.message;}let savedPlans=null,savedPlansError=null;try{savedPlans=await this.savedPlans(date);}catch(e){savedPlansError=e.message;}let checkins=null,checkinsError=null;try{checkins=await this.checkins?.report()||null;}catch(e){checkinsError=e.message;}let reflection=null,reflectionError=null;try{reflection=await this.reflections?.overview()||null;}catch(e){reflectionError=e.message;}let firstSteps=null,firstStepsError=null;try{firstSteps=await this.firstSteps?.overview()||[];}catch(e){firstStepsError=e.message;}let followThrough=null,followThroughError=null;try{followThrough=await this.followThrough?.overview()||null;}catch(e){followThroughError=e.message;}let estimateFollowThrough=null,estimateFollowThroughError=null;try{estimateFollowThrough=await this.estimateFollowThrough?.report()||null;}catch(e){estimateFollowThroughError=e.message;}let capturedTasks=null,capturedTasksError=null;try{capturedTasks=await this.capturedTasks?.report()||null;}catch(e){capturedTasksError=e.message;}let handoff=null,handoffError=null;try{handoff=await dayHandoff(this);}catch(e){handoffError=e.message;}const b={handoff,handoffError,capturedTasks,capturedTasksError,estimateFollowThrough,estimateFollowThroughError,followThrough,followThroughError,firstSteps,firstStepsError,reflection,reflectionError,focus,focusError,savedPlans,savedPlansError,checkins,checkinsError,execution:await this.taskWorkflows?.summary()||[],date,timezone:zone(),generatedAt:now.toISOString(),recurring:week.recurring,projectContext:projectContext(notes,date),day,next:day.blocks.find(b=>b.end>now.getHours()*60+now.getMinutes())||null,overdue:week.overdue,missed:week.missed,warnings:week.warnings,greeting:now.getHours()<12?'Good morning. Let’s make a realistic plan for today.':'Here’s where your day stands. One manageable step at a time.'};let start=null,startError=null;try{start=await dayStart(this,b);}catch(e){startError=e.message;}return {...b,start,startError};}
 candidates(){return remainderCandidates(this);}

 async savedPlans(date=localDay(this.now())){if(!validDate(date)||date>localDay(this.now()))throw new AppError('Choose today or an earlier saved plan date.');return this.vault.exclusive(async()=>savedDayPlans(this,date,await this.dailyFocus?.history.read(),await this.vault.tasks()));}
 weekCapacity(date){return weekCapacityReport(this,date);}
 assessWeekWorkload(input){return assessWeekWorkload(this,input);}
 assessWeekCapacity(input){return assessWeekCapacity(this,input);}
 nextDay(date){return nextDayReport(this,date);}
 async outcomePlan(date){return outcomePlanningRows(this,await nextDayReport(this,date));}
 nextDayPreview(input){return previewNextDay(this,input,fingerprint);}
 focusPreview(input){return previewFocus(this,input,fingerprint);}
 preview(input){return previewRemainder(this,input,i=>this.prepareRemainder(i),fingerprint);}
 async assessRemainder(input){
  if(input.date!==localDay(this.now())||input.timezone!==zone())throw new AppError('The day or timezone changed. Reload the remaining-day draft.',409);
  const p=await this.prepareRemainder({...input,requestId:'assessment'},{assessment:true});
  if(input.date!==localDay(this.now())||input.timezone!==zone())throw new AppError('The day or timezone changed while checking fit. Reload the draft.',409);
  return {date:p.date,timezone:p.timezone,generatedAt:this.now().toISOString(),warnings:p.warnings,targetDays:p.targetDays,changes:p.changes.map(({before,after,unplaced})=>({before,after,unplaced}))};
 }
 async prepareRemainder({selected,start='00:00',end='18:00',gap=10,requestId,checkin,followThrough,estimateFollowThrough},{assessment=false}={}){
  const now=this.now(),date=localDay(now),at=now.getHours()*60+now.getMinutes();
  if([checkin,followThrough,estimateFollowThrough].filter(Boolean).length>1)throw new AppError('Choose one adjustment source.');
  const estimateSource=estimateFollowThrough?await this.estimateFollowThrough.source(estimateFollowThrough):null;
  if(estimateSource&&(!requestId||selected?.length!==1||selected[0]?.id!==estimateSource.taskId))throw new AppError('Adjust only the task from the reviewed estimate decision.');
  const followThroughSource=followThrough?await this.followThrough.source(followThrough,{adjust:true}):null;
  if(followThroughSource&&(!requestId||selected?.length!==1||selected[0]?.id!==followThroughSource.taskId))throw new AppError('Adjust only the reviewed follow-through task.');
  const checkinSource=checkin?await this.checkins?.source(checkin):null;
  if(checkin&&!checkinSource)throw new AppError('Check-ins are unavailable.',503);
  if(checkinSource&&(start<checkinSource.start||end>checkinSource.end))throw new AppError('Keep this adjustment within the check-in work window. Save another check-in to change the constraint.');
  if(!Array.isArray(selected)||!assessment&&!selected.length||selected.some(t=>!t||typeof t.path!=='string'||!Number.isInteger(t.line)||typeof t.revision!=='string')||selected.length>100||new Set(selected.map(taskKey)).size!==selected.length)throw new AppError('Select one or more unfinished tasks for today.');
  const current=await this.candidates();
  for(const t of selected){const row=current.tasks.find(x=>taskKey(x)===taskKey(t));if(row?.dependencyReasons.length)throw new AppError('A selected task is waiting on prerequisites. '+row.issue,409);if(!row||row.locked||t.contextRevision&&t.contextRevision!==row.contextRevision)throw new AppError('Task selection changed or is in progress; compare the current attempt. Reload the remaining-day draft.',409);}
  const keys=selected.map(taskKey),notes=await this.vault.list(),tasks=tasksIn(notes),chosen=tasks.filter(t=>keys.includes(taskKey(t)));
  if(chosen.some(t=>selected.find(s=>taskKey(s)===taskKey(t))?.revision!==t.revision))throw new AppError('Task selection changed. Refresh today’s tasks.',409);
  if(chosen.length!==selected.length||chosen.some(t=>t.done||t.scheduleError||t.planDate!==date))throw new AppError('Task selection changed. Refresh today’s tasks.',409);
  if(chosen.some(t=>t.startTime&&minutes(t.startTime)<=at&&minutes(t.startTime)+t.duration>at))throw new AppError('A task is currently in progress. Leave its block in place.');
  const timetable=readTimetable(notes.find(n=>n.path===TIMETABLE_PATH)),day=classesForDay(timetable,date);
  if(day.unknown||(timetable.classes.length||timetable.availability)&&timetable.timezone!==zone())throw new AppError('Review incomplete class times or the timetable timezone before replanning.');
  const graph=taskGraph(tasks);if(chosen.some(t=>graph.states.get(taskRef(t))?.blocked))throw new AppError('A selected task is waiting on prerequisites. Complete them or change its dependencies before replanning.');
  gap=day.gap??gap;
  // Only selected tasks become candidates. All other tasks keep their existing blocks.
  const fixed=tasks.filter(t=>!keys.includes(taskKey(t))),candidates=chosen.map(t=>({...t,startTime:null}));
  const calendar=assessment?await this.calendar?.context({includeLinked:true}):await this.calendar?.fresh(date);this.calendarReady(calendar,[date]);
  const reserved=[...day.busy,...calendarBlocks(calendar?.events||[],date).map(b=>[b.start,b.end]),...fixed.filter(t=>t.done&&t.planDate===date&&t.startTime&&!t.scheduleError).map(t=>[minutes(t.startTime),minutes(t.startTime)+t.duration])];
  const result=suggestDay([...fixed.filter(t=>t.planDate===date&&t.startTime||t.scheduleError),...candidates],{date,start,end,gap,now,reserved,windows:day.windows,allTasks:tasks});
  const placed=new Map(result.proposed.map(p=>[taskKey(p.task),p.changes]));
  const changes=chosen.map(before=>({before,after:{...before,...(placed.get(taskKey(before))||{startTime:null})},unplaced:!placed.has(taskKey(before)),execution:current.tasks.find(t=>taskKey(t)===taskKey(before)).execution,planContext:current.tasks.find(t=>taskKey(t)===taskKey(before)).contextRevision}));
  const warnings=result.blocked.map(b=>b.task.text+': '+b.reasons.join('; '));if(day.classes.length&&!timetable.travelConfirmed)warnings.push('Travel time is not configured.');if(timetable.classes.length&&!timetable.until)warnings.push('Trimester end is not set.');
  const busy=[...day.busy.map(([start,end])=>({start,end,title:'Class / travel',kind:'class'})),...calendarBlocks(calendar?.events||[],date),...fixed.filter(t=>t.planDate===date&&t.startTime&&!t.scheduleError).map(t=>({start:minutes(t.startTime),end:minutes(t.startTime)+t.duration,title:t.text,kind:'task'}))];
  const targetDays=[{date,hours:[start,end],windows:day.windows||[[start,end]],breakMinutes:gap,busy,capacity:{...planningCapacity({date,start,end,windows:day.windows??null,gap,now,busy:busy.map(b=>[b.start,b.end]),placed:changes.filter(c=>!c.unplaced).map(c=>[minutes(c.after.startTime),minutes(c.after.startTime)+c.after.duration])}),selectedMinutes:chosen.reduce((n,t)=>n+t.duration,0),placedMinutes:changes.filter(c=>!c.unplaced).reduce((n,c)=>n+c.after.duration,0),untimedMinutes:changes.filter(c=>c.unplaced).reduce((n,c)=>n+c.after.duration,0)}}];
  const p={kind:'day_replan',calendarRevision:calendar?.revision||'off',title:'Replan the rest of '+date,date,timezone:zone(),start,end,gap,changes,warnings,targetDays,...(estimateSource?{estimateFollowThrough:{reviewId:estimateSource.reviewId,taskId:estimateSource.taskId,revision:estimateSource.revision,snapshot:estimateSource}}:{}),...(checkinSource?{checkin:checkinSource}:{} ),...(followThroughSource?{followThrough:{proposalId:followThrough.proposalId,taskId:followThrough.taskId,revision:followThrough.revision,snapshot:followThroughSource}}:{}),contextHash:fingerprint(notes),saved:[],intents:[]};return requestId?p:this.public(await this.store.proposal(p));
 }
 async evening(date=localDay(this.now())){
  const today=localDay(this.now());if(!validDate(date)||date>today)throw new AppError('Choose today or an earlier review date.');
  const focusReview=await this.dailyFocus?.review(date)||null,all=await this.vault.tasks(),tasks=all.filter(t=>t.planDate===date||!t.planDate&&focusReview?.rows.some(r=>r.taskId===t.id&&!r.identityIssue)),graph=taskGraph(all),execution=await this.execution(),now=this.now(),at=now.getHours()*60+now.getMinutes();
  let checkins=null,checkinsError=null;try{checkins=await checkinReview(this,date,date,{tasks:all,execution});}catch(e){checkinsError=e.message;}
  let stepOutcomes=null,stepOutcomesError=null;try{stepOutcomes=await this.firstSteps?.outcomes.review(date)||null;}catch(e){stepOutcomesError=e.message;}
  return {stepOutcomes,stepOutcomesError,date,today,timezone:zone(),focusReview,checkins,checkinsError,completed:tasks.filter(t=>t.done),unfinished:tasks.filter(t=>!t.done).map(t=>({...t,focusChoice:focusReview?.rows.find(r=>r.taskId===t.id)?.choiceRevision||null,execution:execution.filter(e=>t.id&&e.taskId===t.id),dependencyReasons:graph.states.get(taskRef(t))?.reasons||[],locked:!!t.scheduleError||all.filter(x=>x.id===t.id).length>1||t.planDate===today&&!!t.startTime&&minutes(t.startTime)<=at&&minutes(t.startTime)+t.duration>at}))};
 }
 async execution(){return await this.taskWorkflows?.summary({includeResults:true})||[];}
 async eveningPreview({date,choices,reserveTimes=false,start='09:00',end='18:00',gap=10}){
  const report=await this.evening(date),notes=await this.vault.list(),tasks=tasksIn(notes);
  if(typeof reserveTimes!=='boolean')throw new AppError('Choose whether to find time for carried-forward tasks.');
  if(!Array.isArray(choices)||!choices.length||choices.length>100||choices.some(c=>!c?.task||typeof c.task.path!=='string'||!Number.isInteger(c.task.line))||new Set(choices.map(c=>taskKey(c.task))).size!==choices.length)throw new AppError('Choose unfinished tasks to change.');
  const changes=choices.map(c=>{
   const before=tasks.find(t=>taskKey(t)===taskKey(c.task));
   if(!before||before.revision!==c.task.revision||before.done||before.scheduleError)throw new AppError('The task changed. Refresh the evening review.',409);
   const current=report.unfinished.find(t=>taskKey(t)===taskKey(before));
   if(!current||(current.focusChoice||null)!==(c.task.focusChoice||null))throw new AppError('Focus intention changed. Refresh the evening review.',409);
   if(current.locked)throw new AppError('Leave the task currently in progress in place.');
   if(executionStamp(current?.execution)!==executionStamp(c.task.execution))throw new AppError('Task execution changed. Reopen the evening review and review the current attempt.',409);
   if(!['move','unschedule','reduce'].includes(c.action))throw new AppError('Choose move, unschedule, or reduce.');
   if(c.action==='move'&&(!validDate(c.date)||c.date<=report.today))throw new AppError('Choose a future day for carried-forward work.');
   const duration=c.duration??before.duration,text=c.text??before.text;
   if(duration>before.duration)throw new AppError('A smaller step cannot increase the time estimate.');
   if(c.action==='reduce'&&duration===before.duration&&text===before.text)throw new AppError('Describe a smaller step or shorten its estimate.');
   const meta=schedule({...before,duration,planDate:c.action==='move'?c.date:null,startTime:null});taskLine(text,meta);
   return {before,after:{...before,...meta,text:text.trim()},action:c.action,execution:current?.execution||[],focusChoice:current.focusChoice};
  });
  const planning=await this.planReviewTimes({notes,tasks,changes,reserveTimes,start,end,gap});
  return this.public(await this.store.proposal({kind:'evening_review',title:'Evening review · '+report.date,date:report.today,reviewDate:report.date,timezone:zone(),changes,...planning,reserveTimes,contextHash:fingerprint(notes),saved:[],intents:[]}));
 }
 async planReviewTimes({notes,tasks,changes,reserveTimes=false,start='09:00',end='18:00',gap=10,keepUnplaced=false,assessment=false,calendarSnapshot,targetDates,now=this.now()}){
  if(typeof reserveTimes!=='boolean')throw new AppError('Choose whether to find time for selected tasks.');
  const warnings=['Deadlines and reminders are preserved. Check any reminders that now fall before the new planned day.','These decisions do not resume workflows, complete tasks or send changes to Google Calendar.'],targetDays=[];
  const today=localDay(now),moved=changes.filter(c=>c.after.planDate>=today&&!c.after.startTime),dates=targetDates||[...new Set(moved.map(c=>c.after.planDate))].sort();let calendarRevision;
  if(reserveTimes&&dates.length){
   const timetable=readTimetable(notes.find(n=>n.path===TIMETABLE_PATH)),calendar=assessment?calendarSnapshot:await this.calendar?.fresh(dates[0]);calendarRevision=calendar?.revision||'off';
   const effective=tasks.map(t=>changes.find(c=>taskKey(c.before)===taskKey(t))?.after||t),keys=new Set(moved.map(c=>taskKey(c.before))),fixed=effective.filter(t=>!keys.has(taskKey(t)));
   for(const target of dates){
    this.calendarReady(calendar,[target]);const day=classesForDay(timetable,target);
    if(day.unknown||(timetable.classes.length||timetable.availability)&&timetable.timezone!==zone())throw new AppError('Review incomplete class times or the timetable timezone before reserving time.');
    const selected=moved.filter(c=>c.after.planDate===target),events=calendarBlocks(calendar?.events||[],target),blocks=fixed.filter(t=>t.planDate===target&&t.startTime&&!t.scheduleError);
    const result=suggestDay([...fixed.filter(t=>t.planDate===target&&t.startTime||t.scheduleError),...selected.map(c=>c.after)],{date:target,start,end,gap:day.gap??gap,now,windows:day.windows,allTasks:effective,reserved:[...day.busy,...events.map(b=>[b.start,b.end]),...blocks.filter(t=>t.done).map(t=>[minutes(t.startTime),minutes(t.startTime)+t.duration])]});
    for(const c of selected){const placed=result.proposed.find(p=>taskKey(p.task)===taskKey(c.after));c.unplaced=!placed;if(placed)c.after={...c.after,...placed.changes};else {c.unplacedReason=result.blocked.find(b=>taskKey(b.task)===taskKey(c.after))?.reasons.join('; ')||'No room in the chosen hours';warnings.push(c.after.text+': '+(result.blocked.find(b=>taskKey(b.task)===taskKey(c.after))?.reasons.join('; ')||'No room in the chosen hours')+(keepUnplaced?'. Existing schedule kept.':'. Left on the chosen day without a reserved time.'));}}
    targetDays.push({date:target,capacity:{...planningCapacity({includeSlots:assessment,date:target,start,end,windows:day.windows??null,gap:day.gap??gap,now,busy:[...day.busy,...events.map(b=>[b.start,b.end]),...blocks.map(t=>[minutes(t.startTime),minutes(t.startTime)+t.duration])],placed:selected.filter(c=>!c.unplaced).map(c=>[minutes(c.after.startTime),minutes(c.after.startTime)+c.after.duration])}),selectedMinutes:selected.reduce((n,c)=>n+c.after.duration,0),placedMinutes:selected.filter(c=>!c.unplaced).reduce((n,c)=>n+c.after.duration,0),untimedMinutes:selected.filter(c=>c.unplaced).reduce((n,c)=>n+c.after.duration,0)},hours:[start,end],windows:day.windows||[[start,end]],breakMinutes:day.gap??gap,busy:[...day.busy.map(([start,end])=>({start,end,title:'Class / travel',kind:'class'})),...events.map(({start,end,title,kind})=>({start,end,title,kind})),...blocks.map(t=>({start:minutes(t.startTime),end:minutes(t.startTime)+t.duration,title:t.text,kind:'task'}))].sort((a,b)=>a.start-b.start)});
    if(day.classes.length&&!timetable.travelConfirmed)warnings.push(target+': Travel time is not configured.');
   }
   if(timetable.classes.length&&!timetable.until)warnings.push('Trimester end is not set.');
  }else if(moved.length)warnings.push('Changed tasks without a start time remain untimed; use the day planner to find room around classes.');
  if(reserveTimes&&changes.some(c=>c.after.planDate&&c.after.planDate<today&&!c.after.startTime))warnings.push('Past planned days cannot receive new time slots. Carry those tasks to a future day to schedule them.');
  const graph=taskGraph(tasks);for(const c of moved){if(!reserveTimes){const reasons=graph.states.get(taskRef(c.before))?.reasons||[];if(reasons.length)warnings.push(c.before.text+': '+reasons.join('; '));}if(c.after.due&&c.after.due<c.after.planDate)warnings.push(c.after.text+': The planned day is after its unchanged deadline.');}
  return {warnings,targetDays,calendarRevision};
 }
 calendarReady(c,dates){if(c&&(!c.complete||c.enabled&&(!validDate(c.from)||!validDate(c.to)||dates.some(date=>date<c.from||date>=c.to))))throw new AppError('Refresh Google Calendar and plan within its downloaded date range.',409);}
 async weeklyPreview({date,choices,reserveTimes=false,start='09:00',end='18:00',gap=10}){
  const report=await this.weeklyReview.report(date),notes=await this.vault.list(),tasks=tasksIn(notes);
  if(!Array.isArray(choices)||!choices.length||choices.length>100||choices.some(c=>!c?.task||typeof c.task.path!=='string'||!Number.isInteger(c.task.line))||new Set(choices.map(c=>taskKey(c.task))).size!==choices.length)throw new AppError('Choose unfinished tasks to adjust.');
  const changes=choices.map(c=>{
   const before=tasks.find(t=>taskKey(t)===taskKey(c.task)),eligible=report.unfinished.find(t=>taskKey(t)===taskKey(c.task));
   if(!before||before.revision!==c.task.revision||!eligible||eligible.locked||before.done||before.scheduleError)throw new AppError('The task changed or is in progress. Refresh the weekly review.',409);
   if(executionStamp(eligible.execution)!==executionStamp(c.task.execution))throw new AppError('Task execution changed. Reopen the weekly review and review the current attempt.',409);
   if((eligible.deferrals?.revision||null)!==(c.task.deferrals?.revision||null))throw new AppError('Recorded carry-forward history changed. Reopen the weekly review.',409);
   if(!['adjust','move','unschedule'].includes(c.action))throw new AppError('Choose an adjustment, carry-forward, or unschedule.');
   if(c.action==='move'&&(!validDate(c.date)||c.date<=report.today))throw new AppError('Choose a future day for carried-forward work.');
   const duration=c.duration??before.duration,text=c.text??before.text;
   const meta=schedule({...before,duration,priority:c.priority??before.priority,planDate:c.action==='move'?c.date:c.action==='unschedule'?null:before.planDate,startTime:c.action==='adjust'&&duration===before.duration?before.startTime:null});taskLine(text,meta);
   const after={...before,...meta,text:text.trim()};
   if(['text','duration','priority','planDate','startTime'].every(k=>before[k]===after[k]))throw new AppError('Choose an actual task change.');
   return {before,after,action:c.action,execution:eligible.execution||[],deferrals:eligible.deferrals};
  });
  const planning=await this.planReviewTimes({notes,tasks,changes,reserveTimes,start,end,gap});
  planning.warnings.push('Wording changes keep this task and its previous execution history. Review that history before starting a changed scope.');
  return this.public(await this.store.proposal({kind:'weekly_review',title:'Weekly decisions · '+report.start+' to '+report.end,date:report.today,reviewDate:report.start,timezone:zone(),changes,...planning,reserveTimes,contextHash:fingerprint(notes),saved:[],intents:[]}));
 }
 public(p){const {intents,contextHash,requestHash,...value}=p;return value;}
 decide(id,action){const work=this.queue.then(()=>this.apply(id,action));this.queue=work.catch(()=>{});return work;}
 async apply(id,action){
  const p=await this.store.get('proposals',id);if(!['day_replan','evening_review','weekly_review','focus_schedule','future_schedule'].includes(p.kind)||!['accept','dismiss'].includes(action))throw new AppError('Invalid day review.');
  if(p.status!=='pending'){if(p.status==='accepted'&&action==='accept')return this.public(p);throw new AppError('This review was already handled.',409);}
  if(!p.changes.length){p.status=action==='accept'?'accepted':'dismissed';return this.public(await this.store.put('proposals',p));}
  // Reconcile a write whose completion record was interrupted.
  let reconciled=0;for(const i of p.intents){if(p.estimateFollowThrough){if(!Array.isArray(i.historyBefore))throw new AppError('The adjustment receipt is damaged. Restore its record.',503);if(p.saved.includes(i.path)||await noteWriteCommitted(this.vault,i.path,sha(i.content),i.historyBefore)){reconciled++;if(!p.saved.includes(i.path)){p.saved.push(i.path);await this.store.put('proposals',p);}}continue;}let n;try{n=await this.vault.read(i.path);}catch(e){if(e.status===404)continue;throw e;}if(n.revision===sha(i.content)){reconciled++;if(!p.saved.includes(i.path)){p.saved.push(i.path);await this.store.put('proposals',p);}}}
  if(reconciled===new Set(p.changes.map(c=>c.before.path)).size){p.status='accepted';return this.public(await this.store.put('proposals',p));}
  if(action==='dismiss'){p.status='dismissed';return this.public(await this.store.put('proposals',p));}
  if(p.estimateFollowThrough&&p.intents.length)throw new AppError('The earlier adjustment write cannot be confirmed. Dismiss the remaining changes and prepare a fresh review.',409);
  const now=this.now();if(localDay(now)!==p.date||zone()!==p.timezone)throw new AppError('The day or timezone changed. Prepare a fresh review.',409);
  const calendarDates=p.kind==='day_replan'?[p.date]:['evening_review','weekly_review','focus_schedule','future_schedule'].includes(p.kind)&&p.reserveTimes?(p.targetDays||[]).map(d=>d.date):[];
  if(calendarDates.length&&this.calendar){const c=await this.calendar.fresh(calendarDates[0]);this.calendarReady(c,calendarDates);if((p.calendarRevision||'off')!==c.revision)throw new AppError('Google Calendar changed. Prepare a fresh review.',409);}
  const at=now.getHours()*60+now.getMinutes();if(p.changes.some(c=>!p.saved.includes(c.before.path)&&c.after.planDate===p.date&&c.after.startTime&&c.after.startTime!==c.before.startTime&&minutes(c.after.startTime)<=at))throw new AppError('A proposed start time has passed. Prepare a fresh review.',409);
  const verify=async()=>{
   if(p.kind==='day_replan'&&p.changes.every(c=>c.planContext))await verifyRemainder(this,p);
   if(p.kind==='focus_schedule')await verifyFocusPlan(this,p);
   if(p.kind==='future_schedule')await verifyNextDay(this,p);
   if(p.kind==='evening_review')await verifyReviewFocus(this,p);
   if(calendarDates.length&&this.calendar){const c=await this.calendar.context();this.calendarReady(c,calendarDates);if((p.calendarRevision||'off')!==c.revision)throw new AppError('Google Calendar changed during saving. Prepare a fresh review.',409);}
   if(['evening_review','weekly_review','focus_schedule','future_schedule'].includes(p.kind)&&p.changes.some(c=>c.execution)){
    const current=await this.execution();for(const c of p.changes.filter(c=>!p.saved.includes(c.before.path)))if(executionStamp(current.filter(e=>c.before.id&&e.taskId===c.before.id))!==executionStamp(c.execution))throw new AppError('Task execution changed. Prepare a fresh '+(p.kind==='weekly_review'?'weekly':'evening')+' review of the current attempt.',409);
   }
   if(p.kind==='weekly_review'&&p.changes.some(c=>c.deferrals)){
    const revisions=await this.weeklyReview.deferralRevisions();for(const c of p.changes.filter(c=>!p.saved.includes(c.before.path)))if((revisions.get(c.before.id)||null)!==(c.deferrals?.revision||null))throw new AppError('Recorded carry-forward history changed. Prepare a fresh weekly review.',409);
   }
   const current=this.now(),minute=current.getHours()*60+current.getMinutes();
   if(localDay(current)!==p.date||zone()!==p.timezone||p.changes.some(c=>!p.saved.includes(c.before.path)&&((c.after.planDate===p.date&&c.after.startTime&&c.after.startTime!==c.before.startTime&&minutes(c.after.startTime)<=minute)||(c.before.planDate===localDay(current)&&c.before.startTime&&minutes(c.before.startTime)<=minute&&minutes(c.before.startTime)+c.before.duration>minute))))throw new AppError('Time moved on or a task started. Prepare a fresh review.',409);
   const notes=await this.vault.list();const original=notes.map(n=>{const i=p.intents.find(i=>i.path===n.path);if(i&&p.saved.includes(n.path)){if(n.revision!==sha(i.content))throw new AppError('An applied task note changed. Refresh before reviewing again.',409);return {...n,revision:i.revision,content:i.beforeContent};}return n;});
   if(fingerprint(original)!==p.contextHash)throw new AppError('Your tasks or classes changed. Prepare a fresh review.',409);
  };
  try{
   await verify();
   for(const path of [...new Set(p.changes.map(c=>c.before.path))]){
    if(p.saved.includes(path))continue;
    let intent=p.intents.find(i=>i.path===path);
    if(!intent){const n=await this.vault.read(path),lines=n.content.split('\n');for(const c of p.changes.filter(c=>c.before.path===path))lines[c.before.line]=lines[c.before.line].replace(/^(\s*[-*] )\[[ xX]\] .+$/,(_,prefix)=>prefix+'[ ] '+taskLine(c.after.text,c.after,c.after.id||undefined));intent={path,revision:n.revision,beforeContent:n.content,content:lines.join('\n')};if(p.estimateFollowThrough)intent.historyBefore=await this.vault.history(path);p.intents.push(intent);await this.store.put('proposals',p);}
    await this.vault.save(path,intent.content,intent.revision,{beforeCommit:verify,taskSource:{kind:p.kind,proposalId:p.id,actions:Object.fromEntries(p.changes.filter(c=>c.before.id&&c.action).map(c=>[c.before.id,c.action]))}});p.saved.push(path);await this.store.put('proposals',p);
   }
   p.status='accepted';await this.store.put('proposals',p);return this.public(p);
  }catch(e){throw new AppError(`Saved ${p.saved.length} of ${new Set(p.changes.map(c=>c.before.path)).size} task notes. ${e.message} Reopen the review to inspect progress before retrying.`,e.status||409);}
 }
}
