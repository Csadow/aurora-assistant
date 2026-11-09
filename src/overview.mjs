import { tasksIn } from './task-meta.mjs';
import {config} from './config.mjs';
export const localDate=(time,zone=config.timezone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
export async function overview({vault,settings,now=Date.now()}){
  const notes=await vault.list(),tasks=tasksIn(notes),date=localDate(now),open=tasks.filter(t=>!t.done),effective=t=>t.planDate||t.due||(t.remindAt?localDate(t.remindAt):null);
  const overdue=t=>!!t.due&&t.due<date,today=t=>!overdue(t)&&(t.planDate===date||t.due===date||t.remindAt&&localDate(t.remindAt)<=date);
  const order=(a,b)=>(effective(a)||'9999').localeCompare(effective(b)||'9999')||(a.remindAt||'').localeCompare(b.remindAt||'')||a.text.localeCompare(b.text);
  const available=notes.filter(n=>!['draft','journal','archived'].includes(n.status)&&!n.path.startsWith('99 Archive/'));
  const card=n=>({path:n.path,title:n.title,excerpt:n.body.replace(/^#{1,6}[^\n]*\n?/gm,'').trim().slice(0,350),updated:n.updated});
  return {date,timezone:config.timezone,counts:{open:open.length,completed:tasks.length-open.length,overdue:open.filter(overdue).length,dueToday:open.filter(today).length},
    overdue:open.filter(overdue).sort(order),today:open.filter(today).sort(order),upcoming:open.filter(t=>!overdue(t)&&!today(t)&&effective(t)).sort(order),unscheduled:open.filter(t=>!effective(t)),
    projects:available.filter(n=>n.path.startsWith('20 Projects/')).sort((a,b)=>b.updated.localeCompare(a.updated)).slice(0,12).map(card),profile:available.filter(n=>n.path.startsWith('10 Profile/')).slice(0,12).map(card),remindersEnabled:settings.value.remindersEnabled,invalidSchedules:tasks.filter(t=>t.scheduleError).length};
}
