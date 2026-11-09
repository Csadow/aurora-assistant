import {validScheduleDraft} from './planner-editor-drafts.js';
import {validFirstStepDraft} from './first-steps.js';
import {validStepOutcomeDraft} from './step-outcomes.js';
import {validDailySummaryDraft} from './daily-summary.js';
import {recoveryDate,recoveryGroups,captureRecovery,localDraftReview,clearReviewedLocalDraft} from './recovery-groups.js';
import {cleanupKey,cleanupDraft,cleanupRecovery,cleanupRecoveryHTML} from './cleanup-recovery.js';
import {adjustmentSummary} from './remaining-adjustments.js';
import {dayStartHTML} from './day-start.js';
import {dayHandoffHTML} from './day-handoff.js';
import {readPosition,writePosition} from './reading-position.js';
import {shortlistWorkspace,shortlistWorkspaceHTML} from './shortlist-workspace.js';
import {sessionDuration} from './focus-sessions.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const coveragePattern=/^(\d{4}-\d{2}-\d{2}): Google Calendar coverage is incomplete\. Refresh to check availability\.$/;
export function planningWarningsHTML(notices,e,{id='calendar-coverage',readingKey}={}){
 const coverage=notices.filter(w=>coveragePattern.test(w)),dates=coverage.map(w=>w.slice(0,10)).sort();
 const ordinary=notices.filter(w=>coverage.length<2||!coveragePattern.test(w)).map(w=>'<p class="planner-warning">'+e(w)+'</p>').join('');
 return ordinary+(coverage.length>1?'<details id="'+e(id)+'"'+(readingKey?' data-continue-details="'+e(readingKey)+'"':'')+'><summary class="planner-warning">Google Calendar coverage incomplete · '+coverage.length+' dates ('+e(dates[0])+'–'+e(dates.at(-1))+') · Refresh to check availability</summary>'+coverage.map(w=>'<p class="planner-warning">'+e(w)+'</p>').join('')+'</details>':'');
}
// Discover only this vault's known planning drafts. Opening the owning editor
// performs full validation; discovery never writes, repairs or retries a request.
export function continueDayDrafts(storage,vault){
 const rows=[],warnings=[];
 const fixed={
  ['aurora-next-day-draft:'+vault]:['Day planning choices',{type:'next'}],
  ['aurora-outcome-plan-draft:'+vault]:['Unfinished-step planning choices',{type:'outcome-plan'}],
  ['aurora-focus-schedule-draft:'+vault]:['Focus scheduling choices',{type:'focus'}],
  ['aurora-remainder-draft:'+vault]:['Remaining-day adjustment',{type:'remainder'}],
  ['aurora-checkin-draft:'+vault]:['Check-in draft',{type:'checkin'}],
  ['aurora-checkin-decision:'+vault]:['Check-in decision',{type:'checkins'}],
  ['aurora-reflection-choice:'+vault]:['Reflection focus request',{type:'reflection'}],
  ['aurora-follow-through-choice:'+vault]:['Follow-through focus request',{type:'follow-through'}]
 };
 try{for(let i=0;i<storage.length;i++){
  const key=storage.key(i);if(key===cleanupKey(vault)){const local=cleanupDraft(storage,vault);if(local)rows.push(local);continue;}let match=fixed[key],suffix;
  const tail=prefix=>key.startsWith(prefix+vault+':')?key.slice((prefix+vault+':').length):null;
  if(!match&&(suffix=tail('aurora-estimate-adjustment:'))!==null){const [reviewId,taskId,...rest]=suffix.split(':');if(!rest.length&&uuid(reviewId)&&uuid(taskId))match=['Estimate schedule adjustment',{type:'estimate-adjust',reviewId,taskId}];}
  if(!match&&(suffix=tail('aurora-estimate-draft:'))!==null&&uuid(suffix))match=['Task estimate draft',{type:'estimate',taskId:suffix}];
  if(!match&&(suffix=tail('aurora-session-summary:'))!==null){const [period,day,...rest]=suffix.split(':');if(!rest.length&&['day','week'].includes(period)&&date(day)&&(period==='day'||new Date(day+'T12:00:00Z').getUTCDay()===1))match=[(period==='day'?'Daily':'Weekly')+' session summary · '+day,{type:'session-summary',period,date:day}];}
  if(!match&&(suffix=tail('aurora-focus-session:'))!==null){const [kind,id,...rest]=suffix.split(':');if(!rest.length&&uuid(id)&&['session','start'].includes(kind))match=['Focus session note / action',{type:'focus-session',...(kind==='session'?{id}:{taskId:id})}];}
  if(!match&&(suffix=tail('aurora-schedule-draft:'))!==null&&uuid(suffix))match=['Task schedule edit',{type:'task-schedule',taskId:suffix}];
  if(!match&&(suffix=tail('aurora-first-step:'))!==null&&uuid(suffix))match=['First-step edit',{type:'first-step',taskId:suffix}];
  if(!match&&(suffix=tail('aurora-step-outcome:'))!==null){const [id,n,...extra]=suffix.split(':');if(uuid(id)&&/^[1-9]\d*$/.test(n)&&Number.isSafeInteger(Number(n))&&!extra.length)match=['Outcome edit · step '+n,{type:'outcome',taskId:id,sequence:Number(n)}];}
  if(!match&&(suffix=tail('aurora-summary-draft:'))!==null&&date(suffix))match=['Daily summary · '+suffix,{type:'summary',date:suffix}];
  if(!match&&(suffix=tail('aurora-evening-choices:'))!==null){const [day,pending,...extra]=suffix.split(':');if(date(day)&&!extra.length&&(!pending||pending==='focus-review-request'))match=[pending?'Evening focus request · '+day:'Evening choices · '+day,{type:'evening',date:day}];}
  if(!match&&(suffix=tail('aurora-weekly-choices:'))!==null&&date(suffix))match=['Weekly choices · '+suffix,{type:'weekly',date:suffix}];
  if(!match&&(suffix=tail('aurora-remainder-draft:'))!==null){const parts=suffix.split(':');if(parts.length===1&&uuid(suffix))match=['Check-in adjustment',{type:'checkin-adjust',id:suffix}];else if(parts.length===3&&parts[0]==='follow'&&uuid(parts[1])&&uuid(parts[2]))match=['Follow-through adjustment',{type:'follow-adjust',proposalId:parts[1],taskId:parts[2]}];}
  if(!match)continue;
  const raw=storage.getItem(key);if(raw===null)continue;let d;try{d=JSON.parse(raw);}catch{}
  const [title,route]=match,unreadable=!object(d)||(route.type==='task-schedule'&&!validScheduleDraft(d,route.taskId))||(route.type==='first-step'&&(!validFirstStepDraft(d)||d.taskId!==route.taskId))||(route.type==='outcome'&&(!validStepOutcomeDraft(d)||d.taskId!==route.taskId||d.cardSequence!==route.sequence))||(route.type==='summary'&&(!validDailySummaryDraft(d)||d.date!==route.date));
  if(route.type==='checkins'&&uuid(d?.id))Object.assign(route,{type:'checkin-detail',id:d.id});
  const pending=!!d?.pending||key.startsWith('aurora-reflection-choice:')||key.startsWith('aurora-follow-through-choice:')||key.startsWith('aurora-checkin-decision:')||key.endsWith(':focus-review-request');
  const taskText=typeof d?.context?.task?.text==='string'?d.context.task.text:typeof d?.taskText==='string'?d.taskText:'',edit=[d?.text,d?.note,d?.body].find(v=>typeof v==='string'&&v.trim())||'';
  const text=route.type==='task-schedule'&&!unreadable?d.fields.text:[...new Set([taskText,edit].filter(Boolean))].join(' · ');
  rows.push({title,route,unreadable,pending,text:text.slice(0,180),date:date(route.date)?route.date:route.type==='task-schedule'?(date(d?.fields?.planDate)?d.fields.planDate:null):date(d?.date)?d.date:date(d?.context?.date)?d.context.date:null,...(['task-schedule','first-step','outcome','summary'].includes(route.type)?{...(route.type==='task-schedule'?{dateLabel:'Draft planned date'}:{}),localKey:key,clearType:unreadable||pending?null:({'task-schedule':'task-schedule','first-step':'first-step',outcome:'step-outcome',summary:'daily-summary'})[route.type]}:{})});
 }}catch{warnings.push('Some local drafts could not be read. They have been kept; use their original editors to recover them.');}
 return {rows:rows.sort((a,b)=>Number(b.unreadable)-Number(a.unreadable)||Number(b.pending)-Number(a.pending)||(b.date||'').localeCompare(a.date||'')||a.title.localeCompare(b.title)),warnings};
}
export function mountContinueDay(root,{api,escape:e,navigate}){
 let generation=0,bootPromise,boot,position=null,returnPending=false,filter={query:'',kind:'all',date:'all'},filterDetails=null;
 const positionKey=()=>boot?'aurora-reading:'+boot.vault+':continue-day':null;
 const scroll=()=>root.closest('.view')||document.scrollingElement;
 const warning=message=>{root.querySelector('#continue-reading-warning')?.remove();const p=document.createElement('p');p.id='continue-reading-warning';p.className='planner-warning';p.setAttribute('role','status');p.append(message+' ');const b=document.createElement('button');b.textContent='Reset workspace reading position';b.onclick=()=>{try{localStorage.removeItem(positionKey());position=null;p.remove();}catch{p.firstChild.textContent='Reading position could not be reset. ';}};p.append(b);root.append(p);};
 const remember=b=>{position={version:1,context:'workspace',focus:b.dataset.continueKey,scrollTop:scroll().scrollTop,details:[...root.querySelectorAll('[data-continue-details][open]')].map(d=>d.dataset.continueDetails)};try{writePosition(localStorage,positionKey(),position);}catch(e){warning(e.message);}};
 function restoreReturn(target=position){
  if(root.hasAttribute('aria-busy')){returnPending=true;return true;}
  if(!target)return false;
  for(const d of root.querySelectorAll('[data-continue-details]'))d.open=target.details.includes(d.dataset.continueDetails);
  const buttons=[...root.querySelectorAll('[data-continue-key]')],legacy=buttons.filter(b=>b.dataset.continueLegacy===target.focus);
  const b=buttons.find(b=>b.dataset.continueKey===target.focus)||(legacy.length===1?legacy[0]:null)||(target.focus.startsWith('detail:')?[...root.querySelectorAll('[data-continue-details]')].find(d=>'detail:'+d.dataset.continueDetails===target.focus)?.querySelector('summary'):target.focus.startsWith('control:')?root.querySelector('#'+target.focus.slice(8)):null);
  if(!b||b.disabled)return false;for(let p=b.parentElement;p&&p!==root;p=p.parentElement)if(p.tagName==='DETAILS'&&!(b.tagName==='SUMMARY'&&p===b.parentElement))p.open=true;if(!b.getClientRects().length)return false;
  b.focus({preventScroll:true});scroll().scrollTop=target.scrollTop;return true;
 }

 async function load(){
  const request=++generation;root.setAttribute('aria-busy','true');let report=null,error=null;
  try{boot??=await(bootPromise??=api('/api/bootstrap').catch(x=>{bootPromise=null;throw x;}));report=await api('/api/continue-day');}catch(x){error=x.message;}
  if(request!==generation)return;
  const [shortlist,cleanup,capture]=boot?await Promise.all([shortlistWorkspace({api,storage:localStorage,vault:boot.vault}),cleanupRecovery({api,storage:localStorage,vault:boot.vault,includeLocal:false}),captureRecovery({api,storage:localStorage,vault:boot.vault})]):[null,null,null];
  if(request!==generation)return;
  let positionError='';try{if(boot)position=readPosition(localStorage,positionKey());}catch(e){positionError=e.message;}
  const local=boot?continueDayDrafts(localStorage,boot.vault):{rows:[],warnings:[]},routes=[];
  if(capture){local.rows.push(...capture.drafts);local.warnings.push(...capture.warnings);}
  const button=(label,route,primary=false)=>{const index=routes.push(route)-1;return '<button data-continue-open="'+index+'" data-continue-type="'+e(route.type)+'"'+(primary?' class="primary"':'')+'>'+e(label)+'</button>';};
  const clearRows=[];
  const item=(title,detail,route,label='Open review',recovery=null)=>'<article class="continue-item" data-continue-item="'+e(String(title??'').slice(0,140))+'"'+(recovery?' data-recovery-kind="'+(recovery.kind||'draft')+'"'+(recovery.clearType?' data-recovery-clearable="true"':''):'')+'><div><h4>'+e(title)+'</h4><p>'+e(detail)+'</p></div>'+button(label,route)+(recovery?.clearType?'<button type="button" data-continue-clear="'+(clearRows.push(recovery)-1)+'">Review clear</button>':'')+'</article>';
  const more=(html,count,name)=>html.length>count?html.slice(0,count).join('')+'<details data-continue-details="'+name+'"><summary>Show '+(html.length-count)+' more</summary>'+html.slice(count).join('')+'</details>':html.join('');
  const dated=d=>recoveryDate(d.date)?' · '+(d.dateLabel||'Original date')+': '+d.date:' · Date not recorded';
  const grouped=(rows,name,render)=>recoveryGroups(rows,report?.date).map(g=>{
   const contents=more(g.rows.map(render),4,name+'-'+g.key+'-more'),label=g.label+' · '+g.rows.length;
   return g.key==='earlier'?'<details data-continue-details="'+name+'-earlier" data-recovery-group="'+g.key+'"><summary>'+e(label)+'</summary>'+contents+'</details>':'<div data-recovery-group="'+g.key+'"><h4 class="recovery-group-title">'+e(label)+'</h4>'+contents+'</div>';
  }).join('');
  const draftHTML=grouped(local.rows,'drafts',d=>item(d.title,(d.unreadable?'Unreadable local draft · retained for review':d.pending?'Saved request / preview · check its receipt or review':'Choices or text saved on this desktop')+dated(d)+(d.text?' · '+d.text:''),d.route,'Reopen',d));
  const active=document.activeElement,searchSelection=active?.id==='continue-recovery-search'?[active.selectionStart,active.selectionEnd]:null,activeKey=root.contains(active)?active.dataset.continueKey||(active.tagName==='SUMMARY'&&active.parentElement.dataset.continueDetails?'detail:'+active.parentElement.dataset.continueDetails:['continue-day-title','continue-day-reload','continue-recovery-search','continue-recovery-kind','continue-recovery-date','continue-recovery-reset'].includes(active.id)?'control:'+active.id:null):null;
  const livePosition=activeKey?{version:1,context:'workspace',focus:activeKey,scrollTop:scroll().scrollTop,details:[...root.querySelectorAll('[data-continue-details][open]')].map(d=>d.dataset.continueDetails)}:null;
  const openDetails=root.children.length?[...root.querySelectorAll('details[data-continue-details][open]')].map(d=>d.dataset.continueDetails):(position?.details||[]);
  const shortlistHTML=shortlist?shortlistWorkspaceHTML(shortlist,e,button):'';
  const handoffHTML=dayHandoffHTML(report?.handoff,report?.handoffError,e,{id:'continue-day-handoff',compact:true,button});
  const data=report,focused=(data?.focused||[]).map(r=>{
   const c=r.step?.card,o=r.step?.latest;
   return '<article class="continue-focus" data-continue-task="'+e(r.taskId)+'"><p class="eyebrow">'+e(r.readiness==='ready'?'Chosen focus':r.readiness==='working'?'Work in progress':'Review before continuing')+'</p><h3>'+e(r.text)+'</h3><p>'+e(r.detail)+'</p>'+(r.task?'<p class="panel-help">'+e(r.task.planDate||'Unscheduled')+' · '+e(r.task.startTime||'No reserved time')+' · '+e(String(r.task.duration))+' min estimate</p>':'')+(c?'<div class="continue-step"><p><strong>'+e(c.mode==='manual'?'Your next step':'Step for Aurora')+'</strong> · Saved '+e(c.context.date)+'</p><p class="summary-prose">'+e(c.text)+'</p>'+(r.step.changed?'<p class="planner-warning">Step context changed. Compare the current details in its review.</p>':'')+'</div>':'<p>No readable first-step card saved for this task.</p>')+(r.stepError?'<p class="planner-warning">'+e(r.stepError)+'</p>':'')+(o?'<p><strong>Your report: '+e(o.kind==='done'?'Done for now':o.kind==='blocked'?'Blocked':'Continue')+'</strong> · '+e(o.context.date)+'</p><p class="summary-prose">'+e(o.note.slice(0,300))+'</p><p class="panel-help">A step report does not mark the planner task complete.</p>':'')+'<div class="focus-actions">'+button('Task details',{type:'task-detail',taskId:r.taskId},true)+button(c?'Review / reopen first step':'Write a first step',{type:'first-step',taskId:r.taskId},!r.identityIssue)+button('Review focus',{type:'focus',taskId:r.taskId})+(c?button('Record / review outcome',{type:'outcome',taskId:r.taskId,sequence:c.sequence}):'')+(c?button('Focus session',{type:'focus-session',taskId:r.taskId}):'')+r.execution.map(x=>button(x.attention?'Review current decision':x.workflowId?'Open current attempt':'Open execution draft',{type:x.attention?'attention':'execution',id:x.id})).join('')+'</div></article>';
  });
  const extraExecutions=(data?.executionDrafts||[]).filter(x=>!data.attention.some(a=>a.id===x.id)&&!data.focused.some(r=>r.execution.some(e=>e.id===x.id)));
  const reviewRows=[...(capture?.reviews||[]),...(data?.estimateReviews||[]).map(r=>({title:'Estimate · '+r.title,date:r.date,detail:r.before+' → '+r.after+' min · '+(r.writeAttempted?'Save was attempted; inspect its receipt':'Estimate review is still open'),route:{type:'estimate-review',id:r.id}})),...(data?.sessionReviews||[]).map(r=>({title:(r.period==='day'?'Daily':'Weekly')+' session summary · '+r.date,date:r.date,period:r.period,detail:r.writeAttempted?'Save was attempted; inspect its receipt':'Publication review is still open',route:{type:'session-summary-review',period:r.period,id:r.id}})),...(data?.reviews||[]).map(p=>({title:p.title,date:p.date,period:p.period,detail:p.savedNotes+' of '+p.totalNotes+' task note(s) recorded saved',route:{type:'proposal',id:p.id}})),...(data?.summaryReviews||[]).map(r=>({title:'Daily summary · '+r.date,date:r.date,detail:r.writeAttempted?'Save was attempted; inspect its receipt':'Publication review is still open',route:{type:'summary-review',id:r.id}}))];
  const reviews=grouped(reviewRows,'reviews',r=>item(r.title,r.detail+dated(r),r.route,'Open review',{kind:'review'}));
  const notices=[...(data?.warnings||[]),...local.warnings];
  const noticeHTML=planningWarningsHTML(notices,e,{id:'continue-calendar-coverage',readingKey:'calendar-coverage'});
  const sessions=data?.sessions;
  const sessionActions=button('All sessions / history',{type:'focus-sessions'})+button('Review task estimates',{type:'estimate-list'})+button('Follow up on estimates',{type:'estimate-follow'})+button('Daily session review',{type:'session-review',period:'day'})+button('Weekly session review',{type:'session-review',period:'week'});
  const sessionHTML=sessions&&!sessions.open.length?'<details id="continue-day-sessions" data-continue-details="sessions-empty"><summary>Focus sessions · none open</summary><div class="focus-actions">'+sessionActions+'</div></details>':'<section id="continue-day-sessions"><h3>Focus sessions</h3>'+sessionActions+(sessions?more(sessions.open.map(s=>item(s.card.context.task.text,s.status+' · '+sessionDuration(s.recordedMilliseconds)+' recorded'+(s.interruption?' · '+s.interruption:''),{type:'focus-session',id:s.id},'Open session')),3,'sessions'):'<p class="planner-warning">Focus sessions could not be loaded. Open their review to inspect the problem.</p>')+'</section>';
  root.innerHTML='<div class="continue-heading"><div><h2 tabindex="-1" id="continue-day-title">Continue my day</h2><p>'+ (data?'Updated '+e(new Date(data.generatedAt).toLocaleTimeString()):'Current day information is unavailable.')+'</p></div><button id="continue-day-reload">Refresh workspace</button></div>'+(error?'<p class="planner-warning" role="status">'+e(error)+' Your saved drafts remain available below.</p>':'')+noticeHTML+dayStartHTML(data?.start,data?.startError,e,{id:'continue-day-start',button})+adjustmentSummary(data?.adjustments,data?.adjustmentsError,e,button)+((data?.attention||[]).length?'<section class="continue-attention"><h3>Decisions waiting for you</h3>'+more(data.attention.map(x=>item(x.text,x.detail,{type:'attention',id:x.id},'Review current decision')),4,'attention')+'</section>':'')+shortlistHTML+handoffHTML+sessionHTML+'<div class="continue-columns"><section><h3>Your chosen focus'+(data?' · '+data.focusTotal:'')+'</h3><div class="continue-focus-list">'+(focused.join('')||(data?.focusAvailable?'<p>No unfinished focus tasks to show. Choose a task in the focus review when you’re ready.</p>':'<p>Focus could not be read. Open its review to inspect the problem.</p>'))+'</div>'+(data?.focusTotal>focused.length?'<p>Showing '+focused.length+' of '+data.focusTotal+' focus tasks. Open the focus review for all of them.</p>':'')+'</section><aside><section id="continue-day-drafts"><h3>Drafts and recovery · '+local.rows.length+'</h3><p class="panel-help">Local edits and saved requests. Dates stay with their original work.</p>'+ (draftHTML||(local.warnings.length?'<p>The local draft list is incomplete. Use the original editors to inspect saved work.</p>':'<p>No saved local planning drafts.</p>'))+'</section><section id="continue-day-reviews"><h3>Saved planning reviews · '+reviewRows.length+'</h3><p class="panel-help">Saved reviews and receipts. Opening one does not apply it again.</p>'+ (reviews||(data?.reviewsAvailable?'<p>No unfinished planning or summary reviews.</p>':'<p>Saved reviews could not all be loaded.</p>'))+'</section>'+(extraExecutions.length?'<section><h3>Execution drafts</h3>'+more(extraExecutions.map(x=>item(x.text,x.detail,{type:'execution',id:x.id})),3,'execution')+'</section>':'')+'</aside></div><details data-continue-details="planning"><summary>Planning, check-ins and reflection</summary><div class="focus-actions">'+button('Daily briefing',{type:'briefing'})+button('Task capture / saved receipt',{type:'task-capture'})+button('Plan tomorrow / reopen draft',{type:'next'})+button('Plan from unfinished steps',{type:'outcome-plan'})+button('Follow through on plans',{type:'follow-through'})+button('Replan remaining tasks',{type:'remainder'})+(data?button('Write / reopen daily summary',{type:'summary',date:data.date}):'')+(data?.reflection?button('Read reflection · '+data.reflection.date,{type:'reflection',date:data.reflection.date}):'')+'</div>'+more((data?.checkins||[]).map(c=>item('Open check-in · '+c.date,c.note.slice(0,180),{type:'checkin-detail',id:c.id})),3,'checkins')+'</details>';
  const group=(key,title,nodes)=>{const d=document.createElement('details');d.dataset.continueDetails=key;const summary=document.createElement('summary');summary.textContent=title;d.append(summary);for(const n of nodes)if(n)d.append(n);return d;};
  if(cleanup){
   const holder=document.createElement('div');holder.innerHTML=cleanupRecoveryHTML(cleanup,e,button,{id:'continue-cleanup-recovery'});
   const needsReview=cleanup.history?.rows.some(row=>['pending','blocked','unavailable'].includes(row.status));
   const label='Cleanup recovery'+(cleanup.history?' · '+cleanup.history.total+' saved review'+(cleanup.history.total===1?'':'s'):'')+(cleanup.local||needsReview?' · review needed':'')+(cleanup.error||cleanup.localError?' · some information unavailable':'');
   root.querySelector('#continue-day-reviews').after(group('cleanup-recovery',label,[holder.firstElementChild]));
  }
  const records=group('focus-records','All focus, drafts and saved reviews · '+((data?.focusTotal||0)+local.rows.length+reviewRows.length+(cleanup?.history?.total||0)),[root.querySelector('.continue-columns')]);
  const controls=document.createElement('div');controls.className='recovery-controls';controls.innerHTML='<label>Search drafts and reviews<input id="continue-recovery-search" type="search" maxlength="160" placeholder="Task, draft text, or date"></label><label>Show<select id="continue-recovery-kind"><option value="all">All records</option><option value="draft">Drafts</option><option value="clearable">Review to clear</option><option value="review">Saved reviews</option></select></label><label>Original date<select id="continue-recovery-date"><option value="all">All dates</option><option value="today">Today</option><option value="week">This week</option><option value="upcoming">Upcoming</option><option value="earlier">Earlier dates</option><option value="undated">Undated</option></select></label><button id="continue-recovery-reset" type="button" hidden>Clear filters</button><p id="continue-recovery-count" role="status"></p><p id="continue-recovery-empty" hidden>No matching recovery records. Clear filters to see the full list.</p></div>';
  records.querySelector('.continue-columns aside').prepend(controls);
  const clearPanel=document.createElement('section');clearPanel.id='continue-clear-review';clearPanel.hidden=true;controls.after(clearPanel);
  const history=group('day-history','Shortlist, previous-day notes and session history',[root.querySelector('#continue-day-shortlist'),root.querySelector('#continue-day-handoff'),root.querySelector('#continue-day-sessions')]);
  root.querySelector('[data-continue-details="planning"]').before(records,history);
  for(const d of root.querySelectorAll('details[data-continue-details]'))d.open=openDetails.includes(d.dataset.continueDetails);
  const search=root.querySelector('#continue-recovery-search'),kind=root.querySelector('#continue-recovery-kind'),when=root.querySelector('#continue-recovery-date'),reset=root.querySelector('#continue-recovery-reset');search.value=filter.query;kind.value=filter.kind;when.value=filter.date;if(!data)when.querySelector('[value="undated"]').textContent='Current day unavailable';
  const filtering=()=>!!(filter.query||filter.kind!=='all'||filter.date!=='all');
  function applyFilter(){
   const active=filtering(),q=filter.query.trim().normalize('NFKC').toLocaleLowerCase();let found=0;
   if(active&&!filterDetails)filterDetails=new Map([...root.querySelectorAll('[data-continue-details]')].map(d=>[d.dataset.continueDetails,d.open]));
   for(const section of [root.querySelector('#continue-day-drafts'),root.querySelector('#continue-day-reviews')]){
    let sectionCount=0;
    for(const g of section.querySelectorAll('[data-recovery-group]')){
     let count=0;for(const row of g.querySelectorAll('[data-recovery-kind]')){const content=row.querySelector(':scope > div')?.textContent||'';const kindMatches=filter.kind==='all'||filter.kind==='clearable'&&row.dataset.recoveryClearable==='true'||row.dataset.recoveryKind===filter.kind;const show=(!q||content.normalize('NFKC').toLocaleLowerCase().includes(q))&&kindMatches&&(filter.date==='all'||g.dataset.recoveryGroup===filter.date);row.hidden=!show;if(show)count++;}g.hidden=count===0;sectionCount+=count;
     const heading=g.querySelector(':scope > summary, :scope > h4');heading.dataset.unfilteredText??=heading.textContent;heading.textContent=active?heading.dataset.unfilteredText.replace(/ · \d+$/,` · ${count}`):heading.dataset.unfilteredText;
     for(const overflow of g.querySelectorAll('details[data-continue-details]')){const summary=overflow.querySelector(':scope > summary');summary.dataset.unfilteredText??=summary.textContent;const visible=[...overflow.querySelectorAll('[data-recovery-kind]')].filter(row=>!row.hidden).length;overflow.hidden=active&&visible===0;summary.textContent=active?`Show ${visible} more`:summary.dataset.unfilteredText;}
     if(active&&count&&g.tagName==='DETAILS')g.open=true;
    }
    const heading=section.querySelector(':scope > h3');heading.dataset.unfilteredText??=heading.textContent;heading.textContent=active?heading.dataset.unfilteredText.replace(/ · \d+$/,` · ${sectionCount} of ${section.querySelectorAll('[data-recovery-kind]').length}`):heading.dataset.unfilteredText;
    section.hidden=active&&sectionCount===0;found+=sectionCount;
   }
   if(active){records.open=true;for(const d of records.querySelectorAll('details[data-continue-details]'))if(d.querySelector('[data-recovery-kind]:not([hidden])'))d.open=true;}
   else if(filterDetails){for(const d of root.querySelectorAll('[data-continue-details]'))if(filterDetails.has(d.dataset.continueDetails))d.open=filterDetails.get(d.dataset.continueDetails);filterDetails=null;}
   reset.hidden=!active;
   root.querySelector('#continue-recovery-count').textContent=found+' matching '+(filter.kind==='clearable'?'local draft'+(found===1?'':'s')+' eligible for reviewed clearing':'recovery record'+(found===1?'':'s'))+(local.warnings.length||!data||data.reviewsAvailable===false?' · Some sources are unavailable.':'');
   root.querySelector('#continue-recovery-empty').hidden=found!==0||!active;
  }
  search.oninput=()=>{filter.query=search.value;applyFilter();};kind.onchange=()=>{filter.kind=kind.value;applyFilter();};when.onchange=()=>{filter.date=when.value;applyFilter();};reset.onclick=()=>{filter={query:'',kind:'all',date:'all'};search.value='';kind.value='all';when.value='all';applyFilter();search.focus({preventScroll:true});};applyFilter();
  for(const b of root.querySelectorAll('[data-continue-clear]'))b.onclick=()=>{
   const refreshReview=()=>{const refresh=document.createElement('button');refresh.type='button';refresh.textContent='Refresh drafts';refresh.onclick=async()=>{refresh.disabled=true;try{await load();root.querySelector('#continue-day-title')?.focus({preventScroll:true});}catch(x){refresh.disabled=false;const alert=clearPanel.querySelector('[role="alert"]');if(alert)alert.textContent=x.message;}};return refresh;};
   let review;try{review=localDraftReview(localStorage,clearRows[Number(b.dataset.continueClear)]);}catch(x){clearPanel.hidden=false;clearPanel.replaceChildren();const p=document.createElement('p');p.className='planner-warning';p.setAttribute('role','alert');p.textContent=x.message;clearPanel.append(p,refreshReview());return;}
   clearPanel.hidden=false;clearPanel.replaceChildren();const title=document.createElement('h3');title.textContent='Review clearing '+review.title;const description=document.createElement('p');description.textContent='This removes only the local draft shown below from this desktop. Task notes, shared capture, saved reviews and receipts stay in place.';const exact=document.createElement('pre');exact.className='summary-prose';exact.textContent=review.raw;const actions=document.createElement('div');actions.className='focus-actions';const confirm=document.createElement('button');confirm.textContent='Clear this local draft';const cancel=document.createElement('button');cancel.textContent='Keep draft';const error=document.createElement('p');error.className='planner-warning';error.setAttribute('role','alert');const refresh=refreshReview();refresh.hidden=true;actions.append(confirm,cancel,refresh);clearPanel.append(title,description,exact,actions,error);cancel.onclick=()=>{clearPanel.hidden=true;b.focus({preventScroll:true});};confirm.onclick=async()=>{confirm.disabled=true;try{clearReviewedLocalDraft(localStorage,review);await load();root.querySelector('#continue-day-title')?.focus({preventScroll:true});}catch(x){error.textContent=x.message;refresh.hidden=false;refresh.focus({preventScroll:true});}};title.tabIndex=-1;title.focus({preventScroll:true});
  };
  root.querySelector('#continue-day-reload').onclick=load;
  for(const b of root.querySelectorAll('[data-continue-open]')){const route=routes[Number(b.dataset.continueOpen)];b.dataset.continueLegacy=(b.closest('section[id]')?.id||'workspace')+':'+JSON.stringify(route)+':'+b.textContent;b.dataset.continueKey=b.dataset.continueLegacy+(b.closest('[data-continue-item]')?':row:'+b.closest('[data-continue-item]').dataset.continueItem:'');b.onclick=async()=>{if(b.disabled||root.dataset.navigating==='true')return;root.dataset.navigating='true';for(let p=b.parentElement;p&&p!==root;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;remember(b);root.querySelector('#continue-navigation-error')?.remove();b.disabled=true;try{await navigate(route);}catch(e){const p=document.createElement('p');p.id='continue-navigation-error';p.className='planner-warning';p.setAttribute('role','alert');p.textContent=e.message;root.append(p);}finally{root.dataset.navigating='false';if(b.isConnected)b.disabled=false;}};}
  if(positionError)warning(positionError);
  root.dataset.date=report?.date||'';root.removeAttribute('aria-busy');
  const pendingReturn=returnPending;returnPending=false;
  if((pendingReturn||livePosition)&&root.getClientRects().length&&!restoreReturn(pendingReturn?position:livePosition))root.querySelector('#continue-day-title').focus({preventScroll:true});
  if(searchSelection&&document.activeElement===search)search.setSelectionRange(...searchSelection);
  return report;
 }
 return {load,restoreReturn};
}
