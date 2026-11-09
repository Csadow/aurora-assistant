import {taskLinks} from './task-links.js';
const randomUUID=()=>crypto.randomUUID();
class AppError extends Error { constructor(message){super(message);this.status=400;} }
export const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number(value.slice(0,4))>=2000&&Number(value.slice(0,4))<2200&&!Number.isNaN(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
export function schedule({due=null,remindAt=null,planDate=null,startTime=null,duration=30,priority='normal',project=null,parent=null,dependsOn=[]}={}){
  if(due===''||due===undefined)due=null;if(remindAt===''||remindAt===undefined)remindAt=null;
  if(due!==null&&!validDate(due))throw new AppError('Choose a valid due date.');
  if(remindAt!==null){if(typeof remindAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(remindAt)||!validDate(remindAt.slice(0,10))||!Number.isFinite(Date.parse(remindAt)))throw new AppError('Choose a reminder time with a timezone.');remindAt=new Date(remindAt).toISOString();}
  planDate=planDate||null;startTime=startTime||null;
  if(planDate!==null&&!validDate(planDate))throw new AppError('Choose a valid planned date.');
  if(startTime!==null&&(!planDate||typeof startTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)))throw new AppError('Choose a planned date and valid start time.');
  if(!Number.isInteger(duration)||duration<5||duration>720)throw new AppError('Duration must be between 5 and 720 minutes.');
  if(!['high','normal','low'].includes(priority))throw new AppError('Choose high, normal, or low priority.');
  if(startTime&&Number(startTime.slice(0,2))*60+Number(startTime.slice(3))+duration>1440)throw new AppError('A task block must end within its planned day.');
  return {due,remindAt,planDate,startTime,duration,priority,...taskLinks({project,parent,dependsOn})};
}
export function taskText(raw){
  const match=raw.match(/\s*<!-- aster-task:(\{.*\}) -->\s*$/);if(!match)return {text:raw,id:null,...schedule()};
  try{const meta=JSON.parse(match[1]);if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(meta.id))throw new Error();return {text:raw.slice(0,match.index).trimEnd(),id:meta.id,...schedule(meta)};}
  catch{return {text:raw,id:null,due:null,remindAt:null,scheduleError:true};}
}
export function taskLine(text,options={},id=randomUUID()){
  if(typeof text!=='string'||!text.trim()||text.length>600||/[\r\n]/.test(text)||text.includes('<!-- aster-task:'))throw new AppError('Enter a task on one line (up to 600 characters), without scheduling metadata.');
  const meta={id,...schedule(options)};return `${text.trim()} <!-- aster-task:${JSON.stringify(meta)} -->`;
}
export function tasksIn(notes){
  const tasks=[];
  for(const n of notes){
    if(['journal','draft','archived'].includes(n.status)||n.path.startsWith('99 Archive/'))continue;
    let fence=null;
    n.content.split('\n').forEach((line,index)=>{
      const code=line.match(/^\s{0,3}(`{3,}|~{3,})/);if(code){if(!fence)fence=code[1];else if(code[1][0]===fence[0]&&code[1].length>=fence.length)fence=null;return;}if(fence)return;
      const m=line.match(/^\s*[-*] \[([ xX])\] (.+)$/);if(m)tasks.push({path:n.path,line:index,done:m[1]!==' ',...taskText(m[2]),revision:n.revision});
    });
  }
  return tasks;
}
