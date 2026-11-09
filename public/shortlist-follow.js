import {readShortlist,readShortlistCarry,validateShortlistCarry,shortlistEntry,carryIssue,verifyShortlistCarry} from './capture-shortlist.js';

const describe=t=>t?`${t.text} · ${t.planDate||'Unscheduled'} · ${t.startTime||'No time'} · ${t.duration} min · ${t.done?'Marked complete':'Open'}`:'Task unavailable';
const labels={scheduled:'Currently scheduled for this day',complete:'Marked complete',changed:'Changed since the recorded plan',held:'Held in the latest preview',preview:'Proposed; no recorded save for this day',unplanned:'No recorded day-plan save for this day',unavailable:'Current task unavailable'};
export function shortlistEvidenceHTML(row,report,e){
 if(!row)return '<p class="planner-warning">Plan comparison unavailable. Refresh before choosing work.</p>';
 const receipt=row.receipt,p=row.preview;
 return '<div class="shortlist-evidence"><p><strong>'+e(!report.historyAvailable&&['unplanned','preview','changed'].includes(row.placement)?'Plan receipt comparison unavailable':labels[row.placement]||'Comparison unavailable')+'</strong></p>'+
  (!report.historyAvailable?'<p class="planner-warning">Saved-plan history is unavailable; a missing receipt is not evidence of an unsaved task.</p>':'')+
  (row.issue?'<p class="planner-warning">'+e(row.issue)+'</p>':'')+
  (p?.calendar==='changed'?'<p class="planner-warning">Calendar context changed since the latest preview.</p>':'')+
  (receipt?'<details data-reading-details="'+e(row.taskId)+':receipt"><summary>Recorded day-plan save'+(row.receiptChanged?' · current task changed':'')+'</summary><p>'+e(describe(receipt.task))+'</p><p>'+e(receipt.recordedAt)+' · '+(receipt.source==='recovered_save'?'Recovered note save; exact change time unknown':'Recorded note save')+'. This records scheduling, not completion.</p></details>':row.placement==='scheduled'?'<p>The current note has a time slot. No matching day-plan save is available here.</p>':'')+
  (p?'<details data-reading-details="'+e(row.taskId)+':preview"><summary>Latest planning preview · '+e(p.status)+'</summary><p>'+e(p.kind==='held'?'No slot proposed: '+p.reason:'Proposed: '+describe(p.proposed))+'</p>'+(p.contextChanged?'<p>Task details changed since this preview.</p>':'')+'<p>'+e(p.calendar==='changed'?'Calendar context changed since this preview. Review fresh availability before planning again.':p.calendar==='unavailable'?'Calendar comparison unavailable. This preview does not establish current free time.':'Calendar revision matches this preview; fresh availability is checked when you prepare times.')+'</p><p>A preview alone does not establish a saved schedule.</p></details>':'')+
  (row.pendingReview?'<button data-shortlist-plan-review="'+e(row.pendingReview)+'">Reopen unsaved planning review</button>':'')+'</div>';
}
export async function shortlistBriefing({api,vault,escape:e,storage=localStorage}){
 try{
  const shortlist=readShortlist(storage,'aurora-capture-shortlist:'+vault);if(!shortlist?.rows.length)return '';
  const r=await api('/api/shortlist-review',{date:shortlist.date,selectedIds:shortlist.rows.map(s=>s.taskId)});
  return '<section id="briefing-shortlist" class="focus-card"><h3>Your daily shortlist · '+e(shortlist.date)+'</h3><p>'+e(shortlist.timezone)+' · '+shortlist.rows.length+' retained choices.'+(shortlist.date<r.today?' This is an earlier shortlist; nothing has been carried forward.':'')+'</p>'+r.warnings.map(w=>'<p class="planner-warning">'+e(w)+'</p>').join('')+shortlist.rows.map(s=>{
   const row=r.rows.find(x=>x.taskId===s.taskId);return '<article data-briefing-shortlist-task="'+e(s.taskId)+'"><h4>'+e(s.text)+'</h4>'+shortlistEvidenceHTML(row,r,e)+(row?.contextRevision!==s.contextRevision?'<p>Details have changed since you selected this task. The original choice is kept.</p>':'')+'<p>Current: '+e(describe(row?.task))+'</p></article>';
  }).join('')+'<button data-shortlist-follow>Review remaining choices for another day</button><button data-captures-list>Open original shortlist</button><p>Plan saves, completion, focus and first steps remain separate decisions.</p></section>';
 }catch(x){return '<section id="briefing-shortlist" class="focus-card"><h3>Your daily shortlist</h3><p class="planner-warning">'+e(x.message)+'</p><button data-captures-list>Review saved shortlist</button></section>';}
}

export function createShortlistFollow({api,body,open,run,escape:e,onMerge,storage=localStorage}){
 async function show(){
  const vault=(await api('/api/bootstrap')).vault,key='aurora-shortlist-next:'+vault,sourceKey='aurora-capture-shortlist:'+vault;
  const sourceRaw=storage.getItem(sourceKey),raw=storage.getItem(key);let source,draft,report,target,error='';
  try{
   source=readShortlist(storage,sourceKey);if(!source?.rows.length)throw Error('Choose tasks in Captured tasks first.');
   report=await api('/api/shortlist-review',{date:source.date,selectedIds:source.rows.map(r=>r.taskId)});
   draft=readShortlistCarry(storage,key);
   if(!draft){const next=new Date(source.date+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);draft={version:1,source:structuredClone(source),evidenceRevision:report.revision,selection:{version:1,date:[next.toISOString().slice(0,10),report.today].sort().at(-1),timezone:report.timezone,rows:[]}};}
   validateShortlistCarry(draft);
   if(JSON.stringify(draft.source)!==JSON.stringify(source))throw Error('The original shortlist changed. Reset this next-day review to compare its current choices.');
   target=await api('/api/next-day?date='+encodeURIComponent(draft.selection.date));
  }catch(x){error=x.message;}
  const d=draft?.selection,stale=report&&draft?.evidenceRevision!==report.revision;
  body.innerHTML='<section id="shortlist-follow"><h2>Review remaining shortlist choices</h2><p>The original shortlist keeps its date and snapshots. Choose tasks for a separate day draft; no task dates change until you save reviewed times.</p><p id="shortlist-follow-error" class="planner-warning" role="status">'+e(error)+'</p>'+(!error?'<p>Original shortlist: '+e(source.date)+' · '+e(source.timezone)+'</p><label>Consider for <input id="shortlist-follow-date" type="date" min="'+e(report.today)+'" value="'+e(d.date)+'"></label><p>'+e(d.timezone)+'</p>'+(d.date<report.today?'<p class="planner-warning">The selected day is now in the past. Choose a current or future date.</p>':'')+(d.timezone!==target.timezone?'<p class="planner-warning">The device timezone changed.</p><button id="shortlist-follow-zone">Use '+e(target.timezone)+'</button>':'')+report.warnings.map(w=>'<p class="planner-warning">'+e(w)+'</p>').join('')+(stale?'<p class="planner-warning">Plan receipts or current context changed since this next-day review was saved. Compare the original and current details below.</p><button id="shortlist-follow-confirm">Use this current plan comparison</button>':'')+source.rows.map(s=>{
   const r=report.rows.find(r=>r.taskId===s.taskId),t=target.rows.find(r=>r.taskId===s.taskId),saved=d.rows.find(r=>r.taskId===s.taskId),issue=carryIssue(report,r)||t?.issue||(!t?'Task missing or archived.':null),changed=saved&&saved.contextRevision!==t?.contextRevision;
   return '<article data-shortlist-follow-row="'+e(s.taskId)+'"><h3>'+e(s.text)+'</h3><p>Originally selected: '+e(describe(s.task))+'</p><p>Current: '+e(describe(t?.task))+'</p>'+shortlistEvidenceHTML(r,report,e)+(saved?'<p>Selected for this next-day review: '+e(describe(saved.task))+'</p>':'')+(changed?'<p class="planner-warning">Compare changed next-day selection.</p>':'')+(issue&&issue!==r?.issue?'<p class="planner-warning">'+e(issue)+'</p>':'')+'<label class="check-row"><input type="checkbox" data-shortlist-carry="'+e(s.taskId)+'" '+(saved?'checked ':'')+(!saved&&issue?'disabled':'')+'>Consider for '+e(d.date)+'</label>'+(changed&&!issue?'<button data-shortlist-carry-confirm="'+e(s.taskId)+'">Keep with current details</button>':'')+'</article>';
  }).join('')+'<button id="shortlist-follow-merge" '+(!d.rows.length||stale||d.date<report.today?'disabled':'')+'>Review choices for day draft</button>':'')+'<button id="shortlist-follow-refresh">Refresh comparison</button><button id="shortlist-follow-reset">Reset next-day review</button><button data-captures-list>Open original shortlist</button></section>';
  body.querySelector('#shortlist-follow').dataset.readingContext=(source?.date||'')+':'+(d?.date||'');
  body.querySelector('#shortlist-follow').dataset.readingDisabled=String(!!error);
  const el=s=>body.querySelector(s);
  const act=fn=>run(async()=>{try{await fn();}catch(x){el('#shortlist-follow-error').textContent=x.message;const date=el('#shortlist-follow-date');if(date)date.value=d.date;for(const b of body.querySelectorAll('[data-shortlist-carry]'))b.checked=!!d.rows.find(r=>r.taskId===b.dataset.shortlistCarry);}});
  const check=()=>{if(storage.getItem(sourceKey)!==sourceRaw||storage.getItem(key)!==raw)throw Error('This shortlist review changed in another view. Refresh before saving choices.');};
  const save=async next=>{validateShortlistCarry(next);check();storage.setItem(key,JSON.stringify(next));await show();};
  el('#shortlist-follow-refresh').onclick=run(show);
  el('#shortlist-follow-reset').onclick=act(async()=>{if(confirm('Reset this next-day review? Your original shortlist, task notes and day draft stay unchanged.')){check();storage.removeItem(key);await show();}});
  if(!error){
   el('#shortlist-follow-date').onchange=act(()=>save({...draft,selection:{...d,date:el('#shortlist-follow-date').value}}));
   if(el('#shortlist-follow-zone'))el('#shortlist-follow-zone').onclick=act(()=>save({...draft,selection:{...d,timezone:target.timezone}}));
   if(el('#shortlist-follow-confirm'))el('#shortlist-follow-confirm').onclick=act(()=>save({...draft,evidenceRevision:report.revision}));
   for(const b of body.querySelectorAll('[data-shortlist-carry]'))b.onchange=act(async()=>{
    const id=b.dataset.shortlistCarry,rows=d.rows.filter(r=>r.taskId!==id);
    if(b.checked){const issue=carryIssue(report,report.rows.find(r=>r.taskId===id));if(issue)throw Error(issue);rows.push(shortlistEntry(target.rows.find(r=>r.taskId===id)));}
    await save({...draft,selection:{...d,rows}});
   });
   for(const b of body.querySelectorAll('[data-shortlist-carry-confirm]'))b.onclick=act(()=>save({...draft,selection:{...d,rows:d.rows.map(r=>r.taskId===b.dataset.shortlistCarryConfirm?shortlistEntry(target.rows.find(t=>t.taskId===r.taskId)):r)}}));
   el('#shortlist-follow-merge').onclick=act(async()=>{
    check();verifyShortlistCarry(draft,source,report);storage.setItem(key,JSON.stringify(draft));await onMerge();
   });
  }
  open();
 }
 return {show};
}
