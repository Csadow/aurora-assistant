import {readSelection} from './planning-selection.js';
export const captureStates=[['all','All states'],['no-step','No saved first step'],['draft','Unfinished edits on this desktop'],['changed','Changed focus / step context']];
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const date=v=>typeof v==='string'&&v>='2000-01-01'&&v<='2199-12-31'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
export function validateShortlist(s){
 if(s?.version!==1||!date(s.date)||typeof s.timezone!=='string'||!s.timezone||s.timezone.length>100||!Array.isArray(s.rows)||s.rows.length>10||new Set(s.rows.map(r=>r?.taskId)).size!==s.rows.length||s.rows.some(r=>!uuid(r?.taskId)||typeof r.contextRevision!=='string'||!r.contextRevision||r.contextRevision.length>200||typeof r.text!=='string'||r.text.length>600||r.task?.id!==r.taskId||typeof r.task.path!=='string'||typeof r.task.text!=='string'||typeof r.task.done!=='boolean'))throw Error('The saved shortlist cannot be read. It is kept until you explicitly reset it; tasks and day-plan drafts are unchanged.');
 return s;
}
export function readShortlist(storage,key){const raw=storage.getItem(key);if(raw===null)return null;let s;try{s=JSON.parse(raw);}catch{}return validateShortlist(s);}
export function writeShortlist(storage,key,s,expected){validateShortlist(s);if(storage.getItem(key)!==expected)throw Error('The shortlist changed in another view. Refresh captures before changing it.');storage.setItem(key,JSON.stringify(s));}
export function shortlistEntry(row){if(!row?.task||row.issue)throw Error(row?.issue||'Planning details are unavailable. Refresh captures.');return {taskId:row.taskId,text:row.text,task:structuredClone(row.task),contextRevision:row.contextRevision};}
export function validateShortlistCarry(d){
 if(d?.version!==1||typeof d.evidenceRevision!=='string'||!d.evidenceRevision||d.evidenceRevision.length>200)throw Error('The saved next-day shortlist review cannot be read. Reset that review explicitly; the original shortlist is kept.');
 validateShortlist(d.source);validateShortlist(d.selection);
 if(d.selection.date<=d.source.date||d.selection.rows.some(r=>!d.source.rows.some(s=>s.taskId===r.taskId)))throw Error('The saved next-day shortlist review has incompatible choices. Reset that review explicitly.');
 return d;
}
export function readShortlistCarry(storage,key){const raw=storage.getItem(key);if(raw===null)return null;let d;try{d=JSON.parse(raw);}catch{}return validateShortlistCarry(d);}
export function carryIssue(report,row){return !report.historyAvailable||!report.proposalsAvailable?'Planning evidence is unavailable. Refresh before choosing another day.':report.historyPending?'A task save awaits history reconciliation. Review it before choosing another day.':row?.pendingReview?'A planning review still has unsaved changes for this task. Reopen or dismiss it first.':null;}
export function verifyShortlistCarry(carry,source,report){
 validateShortlistCarry(carry);
 if(JSON.stringify(carry.source)!==JSON.stringify(source))throw Error('The original shortlist changed. Reset the next-day review to use its current choices; your existing day draft is kept.');
 if(report.date!==source.date||report.revision!==carry.evidenceRevision)throw Error('Shortlist evidence changed. Reopen the next-day review and compare the current plan receipts.');
 for(const entry of carry.selection.rows){const issue=carryIssue(report,report.rows.find(r=>r.taskId===entry.taskId));if(issue)throw Error(entry.text+': '+issue);}
 return carry.selection;
}
export function localCaptureDraftIds(storage,vault){
 const prefixes=['aurora-first-step:'+vault+':','aurora-schedule-draft:'+vault+':'],ids=new Set();
 for(let i=0;i<storage.length;i++){const key=storage.key(i),prefix=prefixes.find(p=>key?.startsWith(p));if(prefix){const id=key.slice(prefix.length);if(uuid(id)&&storage.getItem(key)!==null)ids.add(id);}}
 if(ids.size>2000)throw Error('Too many local editor drafts to filter safely. Review saved drafts before using this filter.');return [...ids];
}
export function mergeShortlist(draft,shortlist,report){
 validateShortlist(shortlist);
 if(!shortlist.rows.length)throw Error('Choose at least one captured task.');
 if(report.date!==shortlist.date||report.timezone!==shortlist.timezone||report.date<report.today)throw Error('Review the shortlist date and timezone before adding it to a day draft.');
 if(draft?.pending)throw Error('The existing day draft has a preview or interrupted request. Reopen it before merging a shortlist.');
 if(draft&&(draft.date!==report.date||draft.timezone!==report.timezone))throw Error('The existing day draft is for '+draft.date+' · '+draft.timezone+'. Choose that date in the shortlist, or review the existing draft and explicitly change its date first.');
 for(const saved of shortlist.rows){const current=report.rows.find(r=>r.taskId===saved.taskId);if(!current||current.issue||current.contextRevision!==saved.contextRevision)throw Error(saved.text+': '+(current?.issue||'Compare changed or unavailable details in the shortlist before merging.'));}
 const rows=structuredClone(draft?.rows||[]);
 for(const saved of shortlist.rows){const index=rows.findIndex(r=>r.taskId===saved.taskId);if(index>=0&&rows[index].selected)continue;const entry={...structuredClone(saved),selected:true};if(index>=0)rows[index]=entry;else rows.push(entry);}
 if(rows.filter(r=>r.selected).length>100)throw Error('The combined day draft exceeds 100 tasks. Review the existing selection first.');
 return {...(draft||{version:1,date:report.date,timezone:report.timezone,start:'09:00',end:'18:00',gap:10,expanded:true}),rows};
}
export function createShortlistImport({api,body,open,run,escape:e,openDay,storage=localStorage}){
 async function show({carry=false}={}){
  const vault=(await api('/api/bootstrap')).vault,shortKey='aurora-capture-shortlist:'+vault,dayKey='aurora-next-day-draft:'+vault;
  const carryKey='aurora-shortlist-next:'+vault,shortRaw=storage.getItem(shortKey),dayRaw=storage.getItem(dayKey),carryRaw=carry?storage.getItem(carryKey):null;let shortlist,draft,report,merged,error,savedCarry,source;
  const evidence=source=>api('/api/shortlist-review',{date:source.date,selectedIds:source.rows.map(r=>r.taskId)});
  try{source=readShortlist(storage,shortKey);if(!source)throw Error('Choose tasks in Captured tasks first.');shortlist=source;if(carry){savedCarry=readShortlistCarry(storage,carryKey);shortlist=verifyShortlistCarry(savedCarry,source,await evidence(source));}draft=readSelection(storage,dayKey);report=await api('/api/next-day?date='+encodeURIComponent(shortlist.date));merged=mergeShortlist(draft,shortlist,report);}catch(x){error=x.message;}
  body.innerHTML='<section id="shortlist-import"><h2>Review shortlist for the day draft</h2><p>This adds planning choices. You will still review workload and times before saving a schedule.</p>'+(error?'<p class="planner-warning" id="shortlist-import-error">'+e(error)+'</p>':'<p id="shortlist-import-summary">'+shortlist.rows.length+' shortlist task(s) · '+e(shortlist.date)+' · '+e(shortlist.timezone)+'. '+(draft?.rows.filter(r=>r.selected).length||0)+' existing choice(s) kept. Hours '+e(merged.start)+'–'+e(merged.end)+' and '+merged.gap+'-minute breaks are kept.</p>')+'<ul>'+(shortlist?.rows||[]).map(r=>'<li>'+e(r.text)+' · '+(draft?.rows.some(x=>x.taskId===r.taskId&&x.selected)?'Already selected; its original comparison stays intact':'Add to the day draft')+'</li>').join('')+'</ul><button id="shortlist-import-save" '+(error?'disabled':'')+'>Add to day draft</button><button id="shortlist-import-existing">Open existing day draft</button><button data-captures-list>Back to captured tasks</button><p>Your shortlist stays available until you clear it. Focus, first-step edits and task completion are separate choices.</p></section>';
  body.querySelector('#shortlist-import').dataset.readingContext=(carry?'carry:':'original:')+(shortlist?.date||'');
  body.querySelector('#shortlist-import').dataset.readingDisabled=String(!!error);
  if(carry)body.querySelector('#shortlist-import').insertAdjacentHTML('afterbegin','<p>Choices reviewed from '+e(source?.date||'the original shortlist')+'. The original shortlist and its snapshots will stay unchanged.</p><button data-shortlist-follow>Back to next-day shortlist review</button>');
  body.querySelector('#shortlist-import-existing').onclick=run(()=>openDay());
  body.querySelector('#shortlist-import-save').onclick=run(async()=>{
   if(!merged)throw Error(error||'Review the shortlist first.');
   if(carry)verifyShortlistCarry(savedCarry,source,await evidence(source));
   const fresh=await api('/api/next-day?date='+encodeURIComponent(shortlist.date));
   if(storage.getItem(shortKey)!==shortRaw||storage.getItem(dayKey)!==dayRaw||carry&&storage.getItem(carryKey)!==carryRaw)throw Error('The shortlist or day draft changed in another view. Reopen the merge review; neither has been replaced.');
   const next=mergeShortlist(draft,shortlist,fresh);storage.setItem(dayKey,JSON.stringify(next));await openDay();
  });open();
 }
 return {show};
}
