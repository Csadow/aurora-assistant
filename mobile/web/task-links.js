const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value);
const fail=message=>{const e=Error(message);e.status=400;throw e;};
export function taskLinks({project=null,parent=null,dependsOn=[]}={}){
 if(project!==null&&(typeof project!=='string'||project.length>220||!project.endsWith('.md')||project.includes('\\')||/[\x00-\x1f]/.test(project)||project.split('/').some(p=>!p||p.startsWith('.'))))fail('Choose a relative project note path.');
 if(parent!==null&&!uuid(parent))fail('Choose a parent task with a stable ID.');
 if(!Array.isArray(dependsOn)||dependsOn.length>50||dependsOn.some(id=>!uuid(id))||new Set(dependsOn).size!==dependsOn.length)fail('Choose up to 50 distinct prerequisite tasks.');
 return {...(project?{project}:{}),...(parent?{parent}:{}),...(dependsOn.length?{dependsOn:[...dependsOn].sort()}: {})};
}
export const taskRef=t=>t.path+'\n'+t.line;
export const projectNotes=notes=>notes.filter(n=>(n.path.startsWith('20 Projects/')||n.kind==='project')&&!['draft','journal','archived'].includes(n.status)&&!n.path.startsWith('99 Archive/'));
export function taskGraph(tasks){
 const ids=new Map();for(const t of tasks)if(t.id){const a=ids.get(t.id)||[];a.push(t);ids.set(t.id,a);}
 const one=id=>ids.get(id)?.length===1?ids.get(id)[0]:null;
 function cycle(start,field){const active=new Set(),seen=new Set();const walk=id=>{if(active.has(id))return true;if(seen.has(id))return false;seen.add(id);active.add(id);const t=one(id);for(const next of field==='parent'?(t?.parent?[t.parent]:[]):t?.dependsOn||[])if(walk(next))return true;active.delete(id);return false;};return start?walk(start):false;}
 const states=new Map();
 for(const t of tasks){
  const reasons=[],warnings=[];
  if(t.scheduleError)reasons.push('Invalid task metadata; repair the Markdown note before planning.');
  if(t.id&&ids.get(t.id)?.length>1)reasons.push('Duplicate task ID; repair the note before planning.');
  for(const id of t.dependsOn||[]){const d=one(id);if(!d)reasons.push('Missing or ambiguous prerequisite: '+id);else if(d.scheduleError)reasons.push('Invalid prerequisite: '+d.text);else if(!d.done)reasons.push('Waiting for '+d.text);}
  if(cycle(t.id,'dependsOn'))reasons.push('Dependency cycle; repair the task links.');
  if(t.parent&&!one(t.parent))warnings.push('Parent task is missing or ambiguous.');
  if(cycle(t.id,'parent'))warnings.push('Parent cycle; repair the task links.');
  const children=tasks.filter(c=>c.parent&&c.parent===t.id);
  states.set(taskRef(t),{blocked:reasons.length>0,reasons,warnings,parent:one(t.parent)?.text||null,children:children.map(c=>({id:c.id,path:c.path,line:c.line,text:c.text,done:c.done})),completedChildren:children.filter(c=>c.done).length});
 }
 return {states,one,cycle};
}
export function validateTaskLinks(tasks,task,notes,{requireReady=false,changed=true}={}){
 if(!task)fail('The task could not be read. Check for an unclosed Markdown code block.');
 const graph=taskGraph(tasks),state=graph.states.get(taskRef(task));
 if(changed){
  if(task.id&&!graph.one(task.id))fail('This task ID is duplicated. Repair it before changing links.');
  if(task.project&&!projectNotes(notes).some(n=>n.path===task.project))fail('The linked project note is missing, archived or not a project. Choose an existing project note.');
  for(const id of [task.parent,...(task.dependsOn||[])].filter(Boolean))if(id===task.id||!graph.one(id)||graph.one(id).scheduleError)fail('Task links must point to a different, existing task with a unique valid ID.');
  if(graph.cycle(task.id,'parent')||graph.cycle(task.id,'dependsOn'))fail('This change would create a parent or dependency cycle.');
 }
 if(requireReady&&state?.blocked)fail('This task is no longer ready: '+state.reasons.join('; '));
 return state;
}
