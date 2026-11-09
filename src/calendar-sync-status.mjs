import {taskSlot,eventSlot} from './calendar-time.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// A local projection only: opening a view never reads Google or approves a write.
export function calendarSyncStatus(state,tasks,{connected,now,timezone}){
 const cache=state.cache,counts={synced:0,pending:0,conflict:0,blocked:0,unknown:0};
 const fresh=connected&&!!cache&&!state.error&&now-cache.at<=900000;
 const links=state.links.map(link=>{
  const matches=tasks.filter(t=>t.id===link.taskId),task=matches[0];
  const out={taskId:link.taskId,calendarId:link.calendarId,eventId:link.eventId,title:task?.text||link.base?.title||'Missing task'};
  const result=(status,detail)=>({...out,status,detail});
  if(matches.length>1||task?.scheduleError)return result('blocked','Repair the task metadata or duplicate ID before syncing.');
  const observed=cache?.linked?.find(e=>e.calendarId===link.calendarId&&e.eventId===link.eventId);
  const cached=cache?.events.find(e=>e.calendarId===link.calendarId&&e.id===link.eventId);
  if(!observed&&!cached)return result('unknown','Refresh to check this linked event. Absence from the date range does not mean deletion.');
  try{
   const local=taskSlot(task),remote=eventSlot(observed?observed.event:cached,timezone);
   const lc=!same(local,link.base),rc=!same(remote,link.base);
   if(!lc&&!rc)return result('synced','Copies match the last sync.');
   const writable=['owner','writer'].includes(state.calendars.find(c=>c.id===link.calendarId)?.accessRole);
   let allowed=lc&&rc&&!same(local,remote)?['google','aurora']:lc?['aurora']:['google'];
   if(!task&&remote)allowed=allowed.filter(d=>d!=='google');
   if(!writable)allowed=allowed.filter(d=>d!=='aurora');
   if(!allowed.length)return result('blocked','This change cannot sync. Check calendar access or unlink this pair.');
   if(same(local,remote))return result('agree','Both copies agree; review to update the saved sync baseline.');
   if(lc&&rc)return result('conflict','Both copies changed. Review which version to keep.');
   return lc?result('to_google',local?'Aurora changes await review.':'Google block deletion awaits review.'):
    result('to_aurora',remote?'Google changes await review.':'Google block was deleted; removing the Aurora schedule awaits review.');
  }catch(e){return result('blocked',e.message);}
 });
 for(const l of links){if(['to_google','to_aurora','conflict','agree'].includes(l.status))counts.pending++;if(l.status in counts)counts[l.status]++;}
 const r=state.review,remaining=r?.items.filter(i=>!i.done)||[];
 return {connected,fresh,lastChecked:cache?.at||null,error:state.error,counts,links,
  review:r?{id:r.id,remaining:remaining.length,interrupted:remaining.filter(i=>i.intent).length,expired:now-r.created>900000||r.timezone!==timezone}:null};
}
