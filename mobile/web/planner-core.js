import {taskGraph,taskRef} from './task-links.js';
import {tasksIn,taskLine,schedule,validDate} from './tasks.js';
export const TASK_PATH='40 Tasks/Tasks.md';
export const localDay=(date=new Date())=>[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
export const minutes=value=>{if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw Error('Choose a valid time.');return Number(value.slice(0,2))*60+Number(value.slice(3));};
export const clock=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
export function mobileTasks(state){
  return tasksIn(state.notes.map(n=>{
    const fm=n.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]||'';
    const status=fm.match(/^status:\s*["']?([a-z]+)["']?\s*$/m)?.[1];
    return {...n,status};
  }));
}
export const taskKey=t=>t.path+'\n'+t.line;
export const taskSignature=t=>JSON.stringify([t.id,t.text,t.done,t.due,t.remindAt,t.planDate,t.startTime,t.duration,t.priority,t.project||null,t.parent||null,t.dependsOn||[],t.scheduleError||false]);
export function currentTask(tasks,expected){
  const matches=tasks.filter(t=>t.path===expected.path&&(expected.id?t.id===expected.id:t.line===expected.line));
  if(matches.length!==1||taskSignature(matches[0])!==taskSignature(expected))throw Error('This task changed. Refresh and review the current version before saving.');
  return matches[0];
}
export function editTaskContent(note,expected,changes){
  const t=currentTask(mobileTasks({notes:[note]}),expected), lines=note.content.split('\n');
  const done=changes.done??t.done;
  if(typeof done!=='boolean')throw Error('Invalid completion state.');
  if(t.scheduleError)throw Error('Fix invalid task metadata in its Markdown note first.');
  lines[t.line]=lines[t.line].replace(/^(\s*[-*] )\[[ xX]\] .+$/,(_,prefix)=>prefix+'['+(done?'x':' ')+'] '+taskLine(changes.text??t.text,{...t,...changes},t.id||undefined));
  return lines.join('\n');
}
export function agenda(tasks,date){
  if(!validDate(date))throw Error('Choose a valid day.');
  const open=tasks.filter(t=>!t.done&&!t.scheduleError);
  const blocks=open.filter(t=>t.planDate===date&&t.startTime).sort((a,b)=>a.startTime.localeCompare(b.startTime)||taskKey(a).localeCompare(taskKey(b)));
  const conflicts=[];
  for(let i=0;i<blocks.length;i++)for(let j=i+1;j<blocks.length;j++){
    if(minutes(blocks[j].startTime)<minutes(blocks[i].startTime)+blocks[i].duration)conflicts.push([blocks[i],blocks[j]]);
  }
  return {blocks,conflicts,minutes:blocks.reduce((n,t)=>n+t.duration,0),today:open.filter(t=>t.planDate===date&&!t.startTime),overdue:open.filter(t=>t.due&&t.due<date),missed:open.filter(t=>t.planDate&&t.planDate<date),invalid:tasks.filter(t=>t.scheduleError)};
}
export function suggestDay(tasks,{date,start='09:00',end='18:00',gap=10,now=new Date(),reserved=[],windows=null,allTasks=tasks}){
  if(!validDate(date)||date<localDay(now))throw Error('Choose today or a future day for a suggested plan.');
  const begin=minutes(start),finish=minutes(end);
  if(finish<=begin)throw Error('Your day must end after it starts.');
  if(!Number.isInteger(gap)||gap<0||gap>120)throw Error('Breaks must be between 0 and 120 minutes.');
  const view=agenda(tasks,date);
  if(view.conflicts.length)throw Error('Resolve overlapping blocks before suggesting more.');
  if(view.invalid.length)throw Error('Repair invalid task metadata before suggesting a plan.');
  const busy=[...view.blocks.map(t=>[minutes(t.startTime),minutes(t.startTime)+t.duration]),...reserved.map(b=>{if(!Array.isArray(b)||b.length!==2||!Number.isInteger(b[0])||!Number.isInteger(b[1])||b[0]<0||b[1]>1440||b[0]>=b[1])throw Error('Invalid reserved class interval.');return [...b];})];
  const rank={high:0,normal:1,low:2};
  // Keep already planned days intact. Missed blocks stay visible for explicit rescheduling.
  const candidates=tasks.filter(t=>!t.done&&!t.scheduleError&&(!t.planDate||(t.planDate===date&&!t.startTime))).sort((a,b)=>
    Number(!(a.due&&a.due<=date))-Number(!(b.due&&b.due<=date))||rank[a.priority]-rank[b.priority]||(a.due||'9999').localeCompare(b.due||'9999')||taskKey(a).localeCompare(taskKey(b)));
  const available=windows===null?[[begin,finish]]:windows.map(([s,e])=>[Math.max(begin,minutes(s)),Math.min(finish,minutes(e))]).filter(([s,e])=>s<e);
  const proposed=[],unplaced=[],blocked=[],graph=taskGraph(allTasks);
  const floor=date===localDay(now)?Math.max(begin,Math.ceil((now.getHours()*60+now.getMinutes()+1)/5)*5):begin;
  for(const t of candidates){
    const state=graph.states.get(taskRef(t));if(state?.blocked){blocked.push({task:t,reasons:state.reasons});continue;}
    let at=null;
    for(const [windowStart,windowEnd] of available){
    let candidate=Math.max(floor,windowStart);
    for(const [s,e] of busy.slice().sort((a,b)=>a[0]-b[0])){
      if(candidate+t.duration+gap<=s)break;
      if(candidate<e+gap&&candidate+t.duration+gap>s)candidate=e+gap;
    }
    if(candidate+t.duration<=windowEnd){at=candidate;break;}
    }
    if(at===null){unplaced.push(t);continue;}
    const changes=schedule({...t,planDate:date,startTime:clock(at)});
    proposed.push({task:t,changes});busy.push([at,at+t.duration]);
  }
  return {proposed,unplaced,blocked};
}
