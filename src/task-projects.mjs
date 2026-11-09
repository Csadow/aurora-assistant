import {randomUUID} from 'node:crypto';
import {AppError,parseNote} from './vault.mjs';
import {tasksIn,taskLine} from './task-meta.mjs';
import {projectNotes,taskGraph,taskRef,validateTaskLinks} from '../mobile/web/task-links.js';
export function projectContext(notes,date){
 const tasks=tasksIn(notes),graph=taskGraph(tasks),projects=projectNotes(notes);
 const relevant=tasks.filter(t=>!t.done&&!t.scheduleError&&t.project&&(t.planDate===date||t.due&&t.due<=date));
 const paths=[...new Set(relevant.map(t=>t.project))];
 return {total:paths.length,projects:paths.slice(0,4).map(path=>{
  const n=projects.find(n=>n.path===path),linked=relevant.filter(t=>t.project===path);
  const ready=linked.filter(t=>!graph.states.get(taskRef(t))?.blocked);
  const body=n?.body??n?.content??'';
  const excerpt=body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').replace(/```[\s\S]*?```/g,'').replace(/<!-- aster-task:.*? -->/g,'').replace(/^#+\s+.*$/gm,'').trim().slice(0,600);
  return {path,title:n?.title||path,revision:n?.revision||null,missing:!n,excerpt:n?excerpt:'This linked project note is missing or archived. Repair the link in Project tasks.',ready:ready.slice(0,3),blocked:linked.filter(t=>graph.states.get(taskRef(t))?.blocked).slice(0,3).map(t=>({text:t.text,reasons:graph.states.get(taskRef(t)).reasons.slice(0,3)})),taskCount:linked.length};
 })};
}
export class TaskProjects{
 constructor({vault}){this.vault=vault;}
 async report(){const notes=await this.vault.list(),tasks=tasksIn(notes),graph=taskGraph(tasks);return {projects:projectNotes(notes).map(n=>({path:n.path,title:n.title,revision:n.revision})),tasks:tasks.map(t=>({...t,links:graph.states.get(taskRef(t))}))};}
 async subtask({task,text,duration=30}){
  const note=await this.vault.read(task?.path),parent=tasksIn([note]).find(t=>t.id===task.id&&t.line===task.line);
  if(!parent||!parent.id||parent.scheduleError||note.revision!==task.revision)throw new AppError('The parent task changed. Reopen Project tasks.',409);
  const id=randomUUID(),content=note.content.trimEnd()+'\n- [ ] '+taskLine(text,{parent:parent.id,project:parent.project||null,duration},id)+'\n';
  const verify=async()=>{const notes=await this.vault.list(),next=parseNote(note.path,content),tasks=tasksIn([...notes.filter(n=>n.path!==note.path),next]),child=tasks.find(t=>t.id===id);validateTaskLinks(tasks,child,notes);};
  await verify();return this.vault.save(note.path,content,note.revision,{beforeCommit:verify,taskSource:{kind:'subtask_create'}});
 }
}
