import {projectNotes} from './task-links.js';
import {validDate} from './tasks.js';
export const taskListStatuses=['open','today','unscheduled','done','all'];
const normalized=v=>String(v||'').normalize('NFKC').toLowerCase();
export function readTaskListState(storage,vault){
 const raw=storage.getItem('aurora-task-list:'+vault);if(raw===null)return null;
 let s;try{s=JSON.parse(raw);}catch{}
 if(s?.version!==1||typeof s.query!=='string'||s.query.length>500||typeof s.project!=='string'||s.project.length>220||!taskListStatuses.includes(s.status)||!validDate(s.date)||!Number.isFinite(s.scrollTop)||s.scrollTop<0||s.scrollTop>1e7||s.focus!==null&&(!s.focus||typeof s.focus.key!=='string'||s.focus.key.length>500||typeof s.focus.action!=='string'||s.focus.action.length>80))throw Error('Saved task filters cannot be read. They have been kept. Reset saved filters to replace them; your tasks and editor drafts are unaffected.');
 return {version:1,query:s.query,project:s.project,status:s.status,date:s.date,scrollTop:s.scrollTop,focus:s.focus===null?null:{key:s.focus.key,action:s.focus.action}};
}
export function taskListModel(tasks,notes,selection){
 const projects=new Map(projectNotes(notes).map(n=>[n.path,n.title||n.path])),counts=new Map();
 for(const t of tasks){if(t.id)counts.set(t.id,(counts.get(t.id)||0)+1);if(t.project&&!projects.has(t.project))projects.set(t.project,null);}
 if(!['all','none'].includes(selection.project)&&!projects.has(selection.project))projects.set(selection.project,null);
 const terms=normalized(selection.query).trim().split(/\s+/).filter(Boolean),entries=tasks.map(task=>({task,key:task.id&&counts.get(task.id)===1?'id:'+task.id:'source:'+JSON.stringify([task.path,task.line]),issue:task.scheduleError?'Invalid task metadata':task.id&&counts.get(task.id)>1?'Duplicate task ID':null}));
 const rows=entries.filter(({task:t})=>{
  const status=selection.status==='all'||selection.status==='done'&&t.done||!t.done&&(selection.status==='open'||selection.status==='today'&&t.planDate===selection.date||selection.status==='unscheduled'&&!t.planDate&&!t.scheduleError);
  const project=selection.project==='all'||selection.project==='none'&&!t.project&&!t.scheduleError||t.project===selection.project;
  const haystack=normalized([t.text,t.path,t.project,projects.get(t.project)].filter(Boolean).join(' '));
  return status&&project&&terms.every(term=>haystack.includes(term));
 });
 return {rows,problems:entries.filter(e=>e.issue),total:tasks.length,projects:[...projects].sort(([a],[b])=>a.localeCompare(b)).map(([path,title])=>({path,title:title||path,missing:title===null}))};
}
