import {AppError} from './vault.mjs';
import {validDate,schedule,taskLine} from './task-meta.mjs';
export const localZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
export const shiftDate=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
export function dateParts(value,timezone=localZone()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));
 return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`,minute:Number(p.hour)*60+Number(p.minute)};
}
export function taskSlot(t){return t?.planDate?{title:t.text,date:t.planDate,time:t.startTime,duration:t.startTime?t.duration:null}:null;}
export function validateEventTime(e){
 if(e.status==='cancelled')return;
 if(e.start?.date&&e.end?.date&&validDate(e.start.date)&&validDate(e.end.date)&&e.end.date>e.start.date)return;
 if(e.start?.dateTime&&e.end?.dateTime&&Number.isFinite(Date.parse(e.start.dateTime))&&Date.parse(e.end.dateTime)>Date.parse(e.start.dateTime))return;
 throw new AppError('Google returned an event with incomplete times. Calendar availability is incomplete.',502);
}
export function eventSlot(e,timezone=localZone()){
 if(!e||e.status==='cancelled')return null;
 if(e.attendees?.length||e.recurrence?.length||e.recurringEventId||e.eventType&&e.eventType!=='default')throw new AppError('Meetings with guests, recurring events and special event types stay read-only in this release.');
 const title=e.summary||'Untitled Google event';taskLine(title);
 if(e.start?.date&&e.end?.date){if(!validDate(e.start.date)||e.end.date!==shiftDate(e.start.date,1))throw new AppError('Only single-day events can link to planner tasks.');return {title,date:e.start.date,time:null,duration:null};}
 if(!e.start?.dateTime||!e.end?.dateTime)throw new AppError('This event has no supported time range.');
 const start=dateParts(e.start.dateTime,timezone),end=dateParts(e.end.dateTime,timezone),duration=(Date.parse(e.end.dateTime)-Date.parse(e.start.dateTime))/60000;
 if(end.date!==start.date&&!(end.time==='00:00'&&end.date===shiftDate(start.date,1))||duration!==((end.date===start.date?end.minute:1440)-start.minute))throw new AppError('Overnight or daylight-saving transition events stay read-only.');
 schedule({planDate:start.date,startTime:start.time,duration});
 return {title,date:start.date,time:start.time,duration};
}
export function eventBody(slot){
 if(!slot)throw new AppError('Choose a planned date before sending a task to Google.');
 taskLine(slot.title);schedule({planDate:slot.date,startTime:slot.time,duration:slot.duration??30});
 if(!slot.time)return {summary:slot.title,start:{date:slot.date},end:{date:shiftDate(slot.date,1)}};
 const start=new Date(`${slot.date}T${slot.time}:00`),end=new Date(start.getTime()+slot.duration*60000);
 const a=dateParts(start),b=dateParts(end),expected=Number(slot.time.slice(0,2))*60+Number(slot.time.slice(3))+slot.duration;
 if(a.date!==slot.date||a.time!==slot.time||b.minute!==(expected%1440)||b.date!==(expected===1440?shiftDate(slot.date,1):slot.date))throw new AppError('This time crosses a daylight-saving clock change. Choose a different block.');
 return {summary:slot.title,start:{dateTime:start.toISOString(),timeZone:localZone()},end:{dateTime:end.toISOString(),timeZone:localZone()}};
}
export function calendarBlocks(events,date,timezone=localZone()){
 const blocks=[];
 for(const e of events){
  if(e.status==='cancelled'||e.transparency==='transparent'||e.attendees?.some(a=>a.self&&a.responseStatus==='declined'))continue;
  let start,end,allDay=false;
  try{if(e.start?.date&&e.end?.date){if(date<e.start.date||date>=e.end.date)continue;start=0;end=1440;allDay=true;}
   else{const a=dateParts(e.start.dateTime,timezone),b=dateParts(e.end.dateTime,timezone);if(date<a.date||date>b.date)continue;start=date===a.date?a.minute:0;end=date===b.date?b.minute:1440;if(end<=start)continue;}
  }catch{continue;}
  blocks.push({kind:'calendar',title:e.summary||'Busy (Google Calendar)',start,end,allDay,location:e.location||'',calendarId:e.calendarId,eventId:e.id,taskId:e.taskId||null});
 }
 return blocks;
}
