const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const selectedOK=a=>Array.isArray(a)&&a.length<=100&&a.every(x=>uuid(x?.id)&&hash(x.revision))&&new Set(a.map(x=>x.id)).size===a.length;
export const cleanupKey=vault=>'aurora-reminder-cleanup:'+vault;
export function validCleanupDraft(d){
 return !!d&&d.version===1&&Number.isInteger(d.offset)&&d.offset>=0&&d.offset<=100000&&selectedOK(d.selected)&&d.selected.every(x=>typeof x.title==='string'&&typeof x.targetDate==='string')&&(d.reviewId===null||uuid(d.reviewId))&&(d.request===null||uuid(d.request?.requestId)&&typeof d.request.today==='string'&&typeof d.request.timezone==='string'&&selectedOK(d.request.selected)&&d.request.selected.length>0);
}
export function cleanupDraft(storage,vault){
 const raw=storage.getItem(cleanupKey(vault));if(raw===null)return null;
 let d;try{d=JSON.parse(raw);}catch{}
 if(!validCleanupDraft(d))return {title:'Daily cleanup draft',route:{type:'reminder-cleanup'},unreadable:true,pending:false,text:'Saved cleanup choices cannot be read. They have been kept.',date:null};
 if(!d.selected.length&&!d.request&&!d.reviewId)return null;
 return {title:'Daily cleanup draft',route:{type:'reminder-cleanup'},unreadable:false,pending:!!(d.request||d.reviewId),text:d.reviewId?'Saved review reference · reopen to check its result':d.request?'Exact review request retained · no confirmation implied':d.selected.length+' reminder(s) selected for review · no dismissals confirmed',date:d.request?.today||null};
}
export function clearCleanupDraft(storage,vault,expected){
 const key=cleanupKey(vault);if(storage.getItem(key)!==expected)throw Error('Cleanup choices changed in another view. Reopen them before clearing.');
 storage.removeItem(key);
}
export async function cleanupRecovery({api,storage,vault,date,offset=0,includeLocal=true}){
 let local=null,localError=null,history=null,error=null;
 if(includeLocal)try{local=cleanupDraft(storage,vault);}catch{localError='Local cleanup choices could not be read. They have been kept.';}
 try{const q=new URLSearchParams({offset});if(date)q.set('date',date);history=await api('/api/reminder-cleanup/history?'+q);}catch(e){error=e.message;}
 return {local,localError,history,error,date};
}
export function cleanupRecoveryHTML(r,e,button,{id='cleanup-recovery',limit=3}={}){
 const h=r.history,rows=h?.rows.slice(0,limit)||[],labels={recorded:'Recorded dismissal',pending:'Awaiting confirmation',blocked:'Needs a new review',unavailable:'Result unavailable'};
 return '<section id="'+e(id)+'"><h3>Cleanup recovery</h3><p>'+(r.date?'Reviews originally prepared for '+e(r.date)+'. Local choices may belong to another day.':'Saved choices and original reviews. Opening them does not dismiss reminders.')+'</p>'+(r.local?'<article data-cleanup-local><h4>'+e(r.local.title)+'</h4><p>'+e(r.local.text)+(r.local.date?' · '+e(r.local.date):'')+'</p>'+button('Reopen local cleanup',r.local.route)+'</article>':'')+(r.localError?'<p class="planner-warning">'+e(r.localError)+'</p>':'')+(r.error?'<p class="planner-warning">'+e(r.error)+'</p>':'')+rows.map(row=>'<article data-cleanup-saved="'+e(row.id)+'"><h4>'+e(labels[row.status])+'</h4><p>Original review: '+e(row.date||'unavailable')+(row.timezone?' · '+e(row.timezone):'')+(row.count!==null?' · '+row.count+' reminder(s)':'')+'</p>'+(row.confirmedAt?'<p>Confirmed '+e(row.confirmedAt)+'</p>':'')+row.issues.map(x=>'<p class="planner-warning">'+e(x)+'</p>').join('')+button('Open exact review',{type:'reminder-cleanup',reviewId:row.id})+'</article>').join('')+(h&&!h.total?'<p>No saved cleanup reviews'+(r.date?' for this original date':'')+'.</p>':'')+(h&&h.total>rows.length?'<p>'+h.total+' saved review(s) in this list.</p>':'')+button('All cleanup reviews',{type:'cleanup-history'})+button('Daily cleanup',{type:'reminder-cleanup'})+'</section>';
}
