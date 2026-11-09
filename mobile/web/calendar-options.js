import {validDate} from './tasks.js';
const time=s=>{if(typeof s!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))throw Error('Use times from 00:00 to 23:59.');return Number(s.slice(0,2))*60+Number(s.slice(3));};
export function calendarOptions(raw,classes){
  let availability=null;
  if(raw.availability!=null){
    const a=raw.availability;
    if(!Array.isArray(a.days)||a.days.length!==7||!Number.isInteger(a.gap)||a.gap<0||a.gap>120)throw Error('Availability needs seven weekdays and a break of 0–120 minutes.');
    availability={gap:a.gap,days:a.days.map(windows=>{
      if(!Array.isArray(windows)||windows.length>8)throw Error('Use at most eight available windows per day.');
      const result=windows.map(w=>{if(!Array.isArray(w)||w.length!==2||time(w[0])>=time(w[1]))throw Error('Each available window must end after it starts.');return [...w];}).sort((a,b)=>time(a[0])-time(b[0]));
      if(result.some((w,i)=>i&&time(w[0])<time(result[i-1][1])))throw Error('Available windows must not overlap.');return result;
    })};
  }
  const exceptions=raw.exceptions??[];
  if(!Array.isArray(exceptions)||exceptions.length>500)throw Error('Use at most 500 class exceptions.');
  const ids=new Set(),origins=new Set();
  return {availability,exceptions:exceptions.map(e=>{
    if(!e||typeof e.id!=='string'||!/^[\w-]{1,80}$/.test(e.id)||ids.has(e.id)||!validDate(e.date)||!['holiday','cancel','move'].includes(e.kind))throw Error('Invalid class exception.');ids.add(e.id);
    const key=e.date+':'+(e.kind==='holiday'?'holiday':e.classId);if(origins.has(key))throw Error('Only one exception per class occurrence or holiday date.');origins.add(key);
    if(e.kind==='holiday')return {id:e.id,date:e.date,kind:e.kind};
    const c=classes.find(c=>c.id===e.classId);
    if(!c||c.day!==new Date(e.date+'T12:00:00Z').getUTCDay())throw Error('Choose a class that normally occurs on the original date. Remove its exceptions before deleting the weekly class.');
    const out={id:e.id,date:e.date,kind:e.kind,classId:e.classId};
    if(e.kind==='move'){
      if(!validDate(e.targetDate)||time(e.start)>=time(e.end))throw Error('Choose a valid replacement date and time.');
      Object.assign(out,{targetDate:e.targetDate,start:e.start,end:e.end});
    }return out;
  })};
}
export function availableDay(data,date){
  if(!data.availability)return {windows:null,unavailable:[],gap:null};
  const windows=data.availability.days[new Date(date+'T12:00:00Z').getUTCDay()],unavailable=[];let end=0;
  for(const [s,e] of windows){const start=time(s);if(start>end)unavailable.push([end,start]);end=time(e);}
  if(end<1440)unavailable.push([end,1440]);return {windows,unavailable,gap:data.availability.gap};
}
export function exceptionalClasses(data,date,regular){
  const exceptions=data.exceptions||[];
  if(exceptions.some(e=>e.kind==='holiday'&&e.date===date))return [];
  const classes=regular.filter(c=>!exceptions.some(e=>e.date===date&&e.classId===c.id));
  for(const e of exceptions.filter(e=>e.kind==='move'&&e.targetDate===date)){
    if(data.from&&e.date<data.from||data.until&&e.date>data.until)continue;
    const c=data.classes.find(c=>c.id===e.classId);if(c)classes.push({...c,start:e.start,end:e.end,movedFrom:e.date});
  }return classes.sort((a,b)=>a.start.localeCompare(b.start));
}
