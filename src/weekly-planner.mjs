import {calendarBlocks} from './calendar-time.mjs';
import {config} from './config.mjs';
import {taskGraph,taskRef} from '../mobile/web/task-links.js';
import {recurringSummary} from './recurring-tasks.mjs';
import {AppError} from './vault.mjs';
import {tasksIn,validDate} from './task-meta.mjs';
import {readTimetable,classesForDay,TIMETABLE_PATH} from '../mobile/web/timetable.js';
import {minutes,clock} from '../mobile/web/planner-core.js';
const shift=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
export function weekStart(date){
  if(!validDate(date))throw new AppError('Choose a valid week date.');
  const start=shift(date,-((new Date(date+'T12:00:00Z').getUTCDay()+6)%7));
  if(!validDate(start)||!validDate(shift(start,6)))throw new AppError('Choose a full week between 2000 and 2199.');
  return start;
}
function occupied(blocks){
  let sum=0,end=0;
  for(const b of blocks.slice().sort((a,b)=>a.start-b.start)){sum+=Math.max(0,b.end-Math.max(end,b.start));end=Math.max(end,b.end);}
  return sum;
}
export function buildWeek(notes,{date,timezone=config.timezone,now=new Date(),calendar}={}){
  let today;
  try{if(typeof timezone!=='string'||timezone.length>100)throw Error();today=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}catch{throw new AppError('Choose a valid planner timezone.');}
  const start=weekStart(date??today),tasks=tasksIn(notes),open=tasks.filter(t=>!t.done),warnings=[];
  if(calendar?.enabled)warnings.push(...calendar.warnings);
  const graph=taskGraph(tasks);
  const recurring=recurringSummary(notes);if(recurring.error)warnings.push('Recurring tasks: '+recurring.error);
  let timetable=null;
  try{timetable=readTimetable(notes.find(n=>n.path===TIMETABLE_PATH));}catch(e){warnings.push(e.message);}
  const mismatch=!!(timetable?.classes.length||timetable?.availability)&&timetable.timezone!==timezone;
  if(mismatch)warnings.push('Classes use '+timetable.timezone+', but this device uses '+timezone+'. Review the timetable timezone before combining class and task times.');
  const invalid=open.filter(t=>t.scheduleError);if(invalid.length)warnings.push(invalid.length+' task(s) have invalid scheduling metadata. Repair their Markdown notes.');
  if(timetable?.classes.length&&!timetable.travelConfirmed)warnings.push('Travel time is not configured. Reserved time does not include an assumed commute.');
  if(timetable?.classes.length&&!timetable.until)warnings.push('Trimester end is not set. Weekly classes continue until you set it.');
  const days=Array.from({length:7},(_,i)=>{
    const day=shift(start,i),c=timetable?classesForDay(timetable,day):{classes:[],busy:[],unknown:true,active:false,windows:null,unavailable:[]};
    const planned=open.filter(t=>!t.scheduleError&&t.planDate===day),blocks=[];
    for(const t of planned.filter(t=>t.startTime))blocks.push({kind:'task',title:t.text,start:minutes(t.startTime),end:minutes(t.startTime)+t.duration,path:t.path,line:t.line});
    if(!mismatch){
      for(const item of c.classes)blocks.push({kind:'class',title:item.title,start:minutes(item.start),end:minutes(item.end),location:item.location});
      for(const [a,b] of c.busy.slice(c.classes.length))blocks.push({kind:'travel',title:'Travel',start:a,end:b});
    }
    if(calendar?.enabled){blocks.push(...calendarBlocks(calendar.events,day,timezone));if(!calendar.complete||day<calendar.from||day>=calendar.to)warnings.push(day+': Google Calendar coverage is incomplete. Refresh to check availability.');}
    blocks.sort((a,b)=>a.start-b.start||a.end-b.end);
    const outsideAvailability=planned.filter(t=>t.startTime&&c.unavailable.some(([a,b])=>minutes(t.startTime)<b&&minutes(t.startTime)+t.duration>a));
    if(outsideAvailability.length)warnings.push(day+': '+outsideAvailability.length+' task(s) outside your available hours.');
    const conflicts=[];for(let a=0;a<blocks.length;a++)for(let b=a+1;b<blocks.length&&blocks[b].start<blocks[a].end;b++)conflicts.push({first:blocks[a],second:blocks[b]});
    const blocked=planned.filter(t=>graph.states.get(taskRef(t))?.blocked).map(t=>({...t,reasons:graph.states.get(taskRef(t)).reasons}));
    if(blocked.some(t=>t.startTime))warnings.push(day+': some saved task blocks are waiting on prerequisites.');
    return {blocked,breakMinutes:c.gap??null,availability:c.windows,outsideAvailability,date:day,today:day===today,classes:c.classes,unknown:c.unknown,timetableActive:c.active,blocks:blocks.map(b=>({...b,time:clock(b.start)+'–'+clock(b.end)})),conflicts,
      classMinutes:c.classes.reduce((n,c)=>n+minutes(c.end)-minutes(c.start),0),taskMinutes:planned.filter(t=>t.startTime).reduce((n,t)=>n+t.duration,0),occupiedMinutes:c.unknown||mismatch||!timetable||invalid.length||calendar?.enabled&&(!calendar.complete||day<calendar.from||day>=calendar.to)?null:occupied(blocks),
      untimed:planned.filter(t=>!t.startTime),due:open.filter(t=>!t.scheduleError&&t.due===day),completed:tasks.filter(t=>t.done&&t.planDate===day)};
  });
  return {recurring,start,end:shift(start,6),today,timezone,timetableTimezone:timetable?.timezone||null,timezoneMismatch:mismatch,warnings,days,
    totals:{classes:days.reduce((n,d)=>n+d.classes.length,0),classMinutes:days.reduce((n,d)=>n+d.classMinutes,0),taskMinutes:days.reduce((n,d)=>n+d.taskMinutes,0),conflicts:days.reduce((n,d)=>n+d.conflicts.length,0),completed:days.reduce((n,d)=>n+d.completed.length,0)},
    backlog:open.filter(t=>!t.scheduleError&&!t.planDate),overdue:open.filter(t=>!t.scheduleError&&t.due&&t.due<today),missed:open.filter(t=>!t.scheduleError&&t.planDate&&t.planDate<today)};
}
export async function weeklyPlanner(vault,options){return buildWeek(await vault.list(),options);}
