import {calendarOptions,availableDay,exceptionalClasses} from './calendar-options.js';
import {validDate} from './tasks.js';
export const TIMETABLE_PATH='40 Tasks/Class timetable.md';
export const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const minute=s=>{if(typeof s!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))throw Error('Choose a valid class time.');return Number(s.slice(0,2))*60+Number(s.slice(3));};
export const emptyTimetable=()=>({availability:null,exceptions:[],format:'aurora-timetable-v1',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,classes:[],unknownDays:[],travelBefore:0,travelAfter:0,travelConfirmed:false,from:null,until:null});
export function validateTimetable(raw){
  if(!raw||raw.format!=='aurora-timetable-v1'||!Array.isArray(raw.classes)||raw.classes.length>100||!Array.isArray(raw.unknownDays)||raw.unknownDays.some(d=>!Number.isInteger(d)||d<0||d>6))throw Error('Invalid class timetable. Repair its Markdown note before planning.');
  try{new Intl.DateTimeFormat('en',{timeZone:raw.timezone}).format();}catch{throw Error('Choose a valid timetable timezone.');}
  if(typeof raw.timezone!=='string')throw Error('Timetable timezone is missing.');
  for(const k of ['travelBefore','travelAfter'])if(!Number.isInteger(raw[k])||raw[k]<0||raw[k]>180)throw Error('Travel buffers must be between 0 and 180 minutes.');
  for(const k of ['from','until'])if(raw[k]!=null&&!validDate(raw[k]))throw Error('Choose valid timetable start/end dates.');
  if(raw.from&&raw.until&&raw.from>raw.until)throw Error('Timetable end must follow its start.');
  const ids=new Set();
  const classes=raw.classes.map(c=>{
    if(!c||typeof c.id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(c.id)||ids.has(c.id)||!Number.isInteger(c.day)||c.day<0||c.day>6||typeof c.title!=='string'||!c.title.trim()||c.title.length>200||typeof c.location!=='string'||c.location.length>200)throw Error('Invalid class entry.');
    if(minute(c.end)<=minute(c.start))throw Error('A class must end after it starts on the same day.');ids.add(c.id);
    return {id:c.id,day:c.day,title:c.title.trim(),location:c.location,start:c.start,end:c.end};
  });
  return {...calendarOptions(raw,classes),format:raw.format,timezone:raw.timezone,classes,unknownDays:[...new Set(raw.unknownDays)],travelBefore:raw.travelBefore,travelAfter:raw.travelAfter,travelConfirmed:raw.travelConfirmed===true,from:raw.from||null,until:raw.until||null};
}
export function readTimetable(note){
  if(!note)return emptyTimetable();
  const blocks=[...note.content.matchAll(/```aurora-timetable\r?\n([\s\S]*?)\r?\n```/g)];
  if(blocks.length!==1)throw Error('Class timetable needs exactly one aurora-timetable block. Repair its Markdown note before planning.');
  try{return validateTimetable(JSON.parse(blocks[0][1]));}catch(e){throw Error('Class timetable: '+e.message);}
}
export function timetableMarkdown(value){
  const data=validateTimetable(value),plain=s=>s.replace(/[\r\n|]/g,' ');
  return '# Class timetable\n\nWeekly pattern in '+data.timezone+'. Edit it in Your day / Today → Class timetable.\nChanging the table below alone does not change the schedule; the structured block is authoritative.\n\n'+
    '| Day | Time | Class | Room |\n| --- | --- | --- | --- |\n'+data.classes.slice().sort((a,b)=>(a.day||7)-(b.day||7)||a.start.localeCompare(b.start)).map(c=>'| '+weekdays[c.day]+' | '+c.start+'–'+c.end+' | '+plain(c.title)+' | '+plain(c.location)+' |').join('\n')+
    '\n\nTravel before first class: '+data.travelBefore+' minutes. After last: '+data.travelAfter+' minutes. '+(data.travelConfirmed?'Configured.':'Not yet confirmed.')+'\n\nUnknown days: '+(data.unknownDays.map(d=>weekdays[d]).join(', ')||'none')+'. Automatic suggestions are blocked on unknown days.\n\n```aurora-timetable\n'+JSON.stringify(data,null,2)+'\n```\n';
}
export function classesForDay(data,date){
  if(!validDate(date))throw Error('Choose a valid plan date.');
  const day=new Date(date+'T12:00:00Z').getUTCDay(),active=!(data.from&&date<data.from||data.until&&date>data.until);
  const classes=exceptionalClasses(data,date,active?data.classes.filter(c=>c.day===day):[]);
  const busy=classes.map(c=>[minute(c.start),minute(c.end)]);
  if(busy.length){const first=Math.min(...busy.map(b=>b[0])),last=Math.max(...busy.map(b=>b[1]));if(data.travelBefore)busy.push([Math.max(0,first-data.travelBefore),first]);if(data.travelAfter)busy.push([last,Math.min(1440,last+data.travelAfter)]);}
  return {...availableDay(data,date),classes,busy,unknown:active&&data.unknownDays.includes(day)&&!(data.exceptions||[]).some(e=>e.kind==='holiday'&&e.date===date),active};
}
