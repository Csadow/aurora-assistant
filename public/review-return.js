const sources=new WeakMap();
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const offset=v=>v===undefined||Number.isInteger(v)&&v>=0&&v<=100000;
export function reviewReturnRoute(r){
 if(!r||typeof r!=='object')return null;
 if(r.type==='briefing')return {type:r.type};
 if(['evening','weekly'].includes(r.type)&&date(r.date)&&offset(r.workloadOffset))return {type:r.type,date:r.date,...(r.workloadOffset===undefined?{}:{workloadOffset:r.workloadOffset})};
 if(r.type==='reminder-cleanup'&&(r.reviewId===undefined||uuid(r.reviewId)))return {type:r.type,...(r.reviewId?{reviewId:r.reviewId}:{})};
 if(r.type==='cleanup-history'&&offset(r.offset)&&(r.date===undefined||date(r.date)))return {type:r.type,...(r.offset===undefined?{}:{offset:r.offset}),...(r.date?{date:r.date}:{})};
 return null;
}
// Only explicitly registered read-only reviews can become return destinations.
// Drafts remain owned by their editors. This short-lived trail stores no inputs.
export function markPlanningReview(body,owner,route,label){
 const safe=reviewReturnRoute(route);if(!safe||!owner||!body.contains(owner))throw Error('Invalid review return location.');
 sources.set(body,{owner,route:safe,label});
}
export function createReviewReturn({body,panel,button,dispatch}){
 let stack=[],returning=false,pendingFocus=null;
 const current=()=>{const s=sources.get(body);return s&&body.contains(s.owner)?s:null;};
 const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const detailKey=d=>d.id||d.querySelector('summary')?.textContent?.slice(0,300)||'';
 function capture(){
  const s=current();if(returning||!s||!panel.open)return;
  const entry={route:s.route,label:s.label,scrollTop:panel.scrollTop,details:[...body.querySelectorAll('details[open]')].map(detailKey),weeklyFilter:body.querySelector('#weekly-filter')?.value};
  if(equal(stack.at(-1)?.route,entry.route))stack[stack.length-1]=entry;else stack.push(entry);
  stack=stack.slice(-10);
 }
 function sync(){const entry=stack.at(-1);button.hidden=!entry||equal(current()?.route,entry.route);button.textContent=entry?'Back to '+entry.label:'Back to review';}
 async function back(){
  const entry=stack.at(-1);if(!entry)return;
  returning=true;
  try{
   await dispatch(entry.route);
   if(!equal(current()?.route,entry.route))throw Error('The original review could not be restored. Its drafts are kept.');
   for(const d of body.querySelectorAll('details'))d.open=entry.details.includes(detailKey(d));
   const filter=body.querySelector('#weekly-filter');if(filter&&[...filter.options].some(o=>o.value===entry.weeklyFilter)){filter.value=entry.weeklyFilter;filter.dispatchEvent(new Event('change',{bubbles:true}));}
   const owner=current().owner;pendingFocus=()=>{if(body.contains(owner)){const h=body.querySelector('h2');if(h){h.tabIndex=-1;h.focus({preventScroll:true});}panel.scrollTop=entry.scrollTop;}};
   stack.pop();
  }finally{returning=false;sync();}
 }
 panel.addEventListener('close',()=>{if(!panel.open){stack=[];pendingFocus=null;sync();}});
 return {capture,sync,back,clear(){stack=[];pendingFocus=null;sync();},settle(){const fn=pendingFocus;pendingFocus=null;fn?.();}};
}
