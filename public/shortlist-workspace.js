import {readShortlist,readShortlistCarry} from './capture-shortlist.js';

// Read independently so one damaged draft never hides the other recovery entry.
export async function shortlistWorkspace({api,storage,vault}){
 let source=null,carry=null,sourceError='',carryError='',report=null,error='';
 try{source=readShortlist(storage,'aurora-capture-shortlist:'+vault);}catch(e){sourceError=e.message;}
 try{carry=readShortlistCarry(storage,'aurora-shortlist-next:'+vault);}catch(e){carryError=e.message;}
 if(source?.rows.length)try{report=await api('/api/shortlist-review',{date:source.date,selectedIds:source.rows.map(r=>r.taskId)});}catch(e){error=e.message;}
 return {source,carry,sourceError,carryError,report,error};
}
export function shortlistWorkspaceHTML(s,e,button){
 const {source,carry,sourceError,carryError,report,error}=s;
 const warnings=[sourceError,carryError,error,...(report?.warnings||[])].filter(Boolean);
 const counts=new Map(),pending=new Set();
 for(const saved of source?.rows||[]){
  const r=report?.rows.find(r=>r.taskId===saved.taskId);
  const state=!r?'Comparison unavailable':!report.historyAvailable&&['unplanned','preview','changed'].includes(r.placement)?'Receipt comparison unavailable':({scheduled:'Scheduled',complete:'Marked complete',changed:'Changed since plan',held:'Held in preview',preview:'Preview only',unplanned:'No recorded plan save',unavailable:'Task unavailable'}[r.placement]||'Comparison unavailable');
  counts.set(state,(counts.get(state)||0)+1);if(r?.pendingReview)pending.add(r.pendingReview);
 }
 const changed=carry&&JSON.stringify(carry.source)!==JSON.stringify(source);
 return '<section id="continue-day-shortlist"><h3>Daily shortlist</h3>'+(source?.rows.length?'<p>'+e(source.date+' · '+source.timezone)+' · '+source.rows.length+' retained choices.'+(report&&source.date<report.today?' Earlier shortlist; nothing has been carried forward.':'')+'</p><p>'+[...counts].map(([label,n])=>e(label)+' · '+n).join(' · ')+'</p>':'<p>'+(sourceError?'Your original shortlist needs review.':'No tasks on the daily shortlist yet.')+'</p>')+warnings.map(w=>'<p class="planner-warning">'+e(w)+'</p>').join('')+'<div class="focus-actions">'+button(source?.rows.length?'Open original shortlist':'Captured tasks / choose shortlist',{type:'captures'})+(source?.rows.length?button('Review remaining choices',{type:'shortlist-follow'}):'')+[...pending].map(id=>button('Reopen unsaved planning review',{type:'proposal',id})).join('')+'</div>'+(carry||carryError?'<div class="continue-carry"><h4>Next-day shortlist review</h4><p>'+(carry?e(carry.selection.date+' · '+carry.selection.timezone)+' · '+carry.selection.rows.length+' choices kept.':'Saved review needs recovery.')+'</p>'+(changed?'<p class="planner-warning">Original shortlist changed or is unavailable. Reopen the review before reusing its choices.</p>':carry&&report&&carry.evidenceRevision!==report.revision?'<p class="planner-warning">Plan comparison changed. Compare current details before reusing these choices.</p>':'')+button('Reopen next-day review',{type:'shortlist-follow'})+'</div>':'')+'<p class="panel-help">'+(source?.rows.length?'Choices stay here until you clear them. ':'')+'Review times in the day draft before saving a schedule.</p>'+button('Open day draft',{type:'next'})+'</section>';
}
