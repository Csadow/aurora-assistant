// Cosmetic navigation state only. Never store inputs, choices or task snapshots here.
export function readPosition(storage,key){
 const raw=storage.getItem(key);if(raw===null)return null;
 let p;try{p=JSON.parse(raw);}catch{}
 const short=v=>typeof v==='string'&&v.length<=500;
 if(p?.version!==1||!short(p.context)||!short(p.focus)||!Number.isFinite(p.scrollTop)||p.scrollTop<0||p.scrollTop>1e7||!Array.isArray(p.details)||p.details.length>100||p.details.some(v=>!short(v)))throw Error('Saved reading position cannot be read. It has been kept.');
 return p;
}
export function writePosition(storage,key,position){
 // Do not silently replace damaged saved state.
 readPosition(storage,key);storage.setItem(key,JSON.stringify(position));
}

export function createReviewPosition({api,body,panel,storage=localStorage}){
 let vault,readyPromise,restored=null,restoring=false;
 const ready=()=>readyPromise??=api('/api/bootstrap').then(b=>{vault=b.vault;}).catch(()=>{readyPromise=null;});
 const current=()=>{
  const anchor=body.querySelector('#briefing-overview,#shortlist-follow,#shortlist-import,#next-day-draft');
  return anchor&&{anchor,disabled:anchor.dataset.readingDisabled==='true',context:anchor.dataset.readingContext||'',key:'aurora-reading:'+vault+':'+anchor.id};
 };
 const controls=()=>[...body.querySelectorAll('[id], [data-day-start-route], [data-shortlist-carry], [data-shortlist-carry-confirm], [data-next-day-task], [data-reading-details] > summary')];
 const label=el=>{
  if(el.matches('summary'))return el.parentElement.dataset.readingDetails?'detail:'+el.parentElement.dataset.readingDetails:'';
  for(const a of ['data-day-start-route','data-shortlist-carry','data-shortlist-carry-confirm','data-next-day-task'])if(el.hasAttribute(a))return a+':'+el.getAttribute(a);
  return el.id?'id:'+el.id:'';
 };
 const warn=(message,key)=>{
  body.querySelector('#reading-position-warning')?.remove();
  const p=document.createElement('p');p.id='reading-position-warning';p.className='planner-warning';p.setAttribute('role','status');p.append(message+' Your planning choices are kept. ');
  const b=document.createElement('button');b.textContent='Reset reading position';b.onclick=()=>{try{storage.removeItem(key);p.remove();}catch{p.firstChild.textContent='Reading position could not be reset. ';}};p.append(b);body.append(p);
 };
 function capture(){
  if(!vault||!panel.open||body.inert||restoring)return;
  const c=current();if(!c||c.disabled)return;
  try{
   const old=readPosition(storage,c.key),active=document.activeElement;
   const focus=(body.contains(active)?label(active):'')||(old?.context===c.context?old.focus:'');
   writePosition(storage,c.key,{version:1,context:c.context,focus,scrollTop:panel.scrollTop,details:[...body.querySelectorAll('[data-reading-details][open]')].map(d=>d.dataset.readingDetails)});
  }catch(e){warn(e.message,c.key);}
 }
 function restore(){
  const c=current();if(!vault||!c||!panel.open||body.inert||restored===c.anchor)return;
  restored=c.anchor;restoring=true;
  try{
   const saved=c.disabled?null:readPosition(storage,c.key),p=saved?.context===c.context?saved:null;
   for(const d of body.querySelectorAll('[data-reading-details]'))d.open=!!p?.details.includes(d.dataset.readingDetails);
   const target=p&&controls().find(el=>label(el)===p.focus&&!el.disabled&&!el.closest('[inert]')&&el.getClientRects().length);
   const heading=body.querySelector('h2');if(heading)heading.tabIndex=-1;
   (target||heading)?.focus({preventScroll:true});panel.scrollTop=p?.focus&&!target?0:p?.scrollTop||0;
  }catch(e){warn(e.message,c.key);}finally{restoring=false;}
 }
 panel.addEventListener('scroll',capture,{passive:true});body.addEventListener('focusin',capture);body.addEventListener('toggle',capture,true);
 return {ready,capture,restore};
}
