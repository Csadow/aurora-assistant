import {taskLinks} from '../mobile/web/task-links.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomic,AppError,parseNote} from './vault.mjs';
import {tasksIn} from './task-meta.mjs';
const fields=['id','path','text','done','due','remindAt','planDate','startTime','duration','priority'];
const snapshot=notes=>tasksIn(notes).map(t=>({...Object.fromEntries([...fields,'scheduleError'].map(k=>[k,t[k]??null])),...taskLinks(t)}));
const signature=t=>JSON.stringify(t);
function indexed(tasks){const groups=new Map();for(const t of tasks){if(!t.id||t.scheduleError)continue;const list=groups.get(t.id)||[];list.push(t);groups.set(t.id,list);}return groups;}
export function taskChanges(before,after){
 const a=indexed(before),b=indexed(after),changes=[];
 for(const id of new Set([...a.keys(),...b.keys()])){
  if((a.get(id)?.length||0)>1||(b.get(id)?.length||0)>1)continue;
  const old=a.get(id)?.[0]||null,next=b.get(id)?.[0]||null;if(signature(old)===signature(next))continue;
  const kinds=[];
  if(!old)kinds.push('appeared');else if(!next)kinds.push('disappeared');else{
   if(old.done!==next.done)kinds.push(next.done?'marked_complete':'reopened');
   if(old.planDate!==next.planDate||old.startTime!==next.startTime)kinds.push('rescheduled');
   if((old.project||null)!==(next.project||null))kinds.push('project_changed');if((old.parent||null)!==(next.parent||null))kinds.push('parent_changed');if(JSON.stringify(old.dependsOn||[])!==JSON.stringify(next.dependsOn||[]))kinds.push('dependencies_changed');
   if(old.text!==next.text)kinds.push('renamed');if(old.duration!==next.duration)kinds.push('estimate_changed');if(old.priority!==next.priority)kinds.push('priority_changed');
   if(old.due!==next.due)kinds.push('deadline_changed');if(old.remindAt!==next.remindAt)kinds.push('reminder_changed');if(old.path!==next.path)kinds.push('note_changed');
  }
  changes.push({taskId:id,before:old,after:next,kinds});
 }
 return changes;
}
export class TaskHistory{
 constructor({vault,data,now=()=>new Date().toISOString()}){Object.assign(this,{vault,now});this.path=join(data,'task-history.json');this.marker=join(data,'task-history-started.json');}
 async read(){try{const value=JSON.parse(await readFile(this.path,'utf8'));if(value.version!==1||!Array.isArray(value.tasks)||!Array.isArray(value.events)||typeof value.startedAt!=='string'||value.events.some(e=>!e||!Array.isArray(e.kinds)||typeof e.recordedAt!=='string'||!['aurora_save','recovered_save','external_observation'].includes(e.source))||value.pending&&(!Array.isArray(value.pending.afterTasks)||typeof value.pending.path!=='string'))throw Error();return value;}catch(e){if(e.code==='ENOENT'){try{await readFile(this.marker);}catch(m){if(m.code==='ENOENT')return null;throw m;}throw new AppError('Task history is missing. Restore its backup before changing tasks.',503);}throw new AppError('Task history cannot be read. Restore its backup before changing tasks.',503);}}
 async write(state){await atomic(this.path,JSON.stringify(state,null,2));}
 append(state,tasks,source,at,receiptId,decision=null){for(const c of taskChanges(state.tasks,tasks))state.events.push({...c,id:randomUUID(),source,recordedAt:at,changedAt:source==='aurora_save'?at:null,receiptId:receiptId||null,decision:decision?{kind:decision.kind,proposalId:decision.proposalId,action:decision.actions?.[c.taskId]||null}:null});state.tasks=tasks;}
 async sync(){
  const notes=await this.vault.list(),tasks=snapshot(notes);let state=await this.read();const at=this.now();
  if(!state){state={version:1,startedAt:at,tasks,events:[],pending:null};await this.write(state);return state;}
  const original=JSON.stringify(state);
  if(state.pending){const p=state.pending,note=notes.find(n=>n.path===p.path),revision=note?.revision??null;
   if(revision===p.afterRevision){const expected=[...state.tasks.filter(t=>t.path!==p.path),...p.afterTasks];this.append(state,expected,'recovered_save',at,p.id,p.decision);}
   // If bytes no longer match the intent, only the current observed difference is known.
   state.pending=null;
  }
  this.append(state,tasks,'external_observation',at);if(JSON.stringify(state)!==original)await this.write(state);return state;
 }
 async init(){const state=await this.vault.exclusive(()=>this.sync());await atomic(this.marker,JSON.stringify({startedAt:state.startedAt}));this.vault.taskHistory=this;}
 async prepare(path,content,decision=null){const state=await this.sync();const after=content===null?null:parseNote(path,content);state.pending={id:randomUUID(),path,decision,afterRevision:after?.revision??null,afterTasks:after?snapshot([after]):[]};await this.write(state);return state.pending.id;}
 async committed(id){const state=await this.read();if(!state?.pending||state.pending.id!==id)throw new AppError('Task history receipt changed.',409);const p=state.pending;const tasks=[...state.tasks.filter(t=>t.path!==p.path),...p.afterTasks];this.append(state,tasks,'aurora_save',this.now(),id,p.decision);state.pending=null;await this.write(state);}
 async report(){return this.vault.exclusive(async()=>{const s=await this.sync(),groups=indexed(s.tasks);return {startedAt:s.startedAt,total:s.events.length,events:s.events.slice(-200).reverse(),untracked:s.tasks.filter(t=>!t.id||t.scheduleError||(groups.get(t.id)?.length||0)>1).length,limitations:['History begins at setup; existing task states are a baseline, not past completion events.','External and recovered changes have observation times, not known completion times.','Edits made and undone between observations may be invisible. Legacy tasks without stable IDs and duplicate IDs cannot be reliably tracked.']};});}
}
