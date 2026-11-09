export function mountTaskProjects(root,{api,refresh}){
 const n=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
 const dialog=n('dialog'),title=n('h2','Project tasks'),body=n('div'),message=n('p');dialog.id='task-projects-dialog';title.id='task-projects-title';dialog.setAttribute('aria-labelledby',title.id);message.setAttribute('role','status');
 let data,selected=null,busy=false,dirty=false,filter='all';
 const run=fn=>async()=>{if(busy)return;busy=true;message.textContent='';dialog.setAttribute('aria-busy','true');try{await fn();}catch(e){message.textContent=e.message;}finally{busy=false;dialog.removeAttribute('aria-busy');}};
 const button=(label,fn)=>{const b=n('button',label);b.type='button';b.onclick=run(fn);return b;};
 const field=(parent,label,type,value='')=>{const l=n('label',label),i=n('input');i.type=type;i.value=value;i.setAttribute('aria-label',label);if(type==='checkbox')l.prepend(i);else l.append(i);parent.append(l);return i;};
 const select=(parent,label,options,value)=>{const l=n('label',label),s=n('select');s.setAttribute('aria-label',label);for(const [v,text] of options){const o=n('option',text);o.value=v;s.append(o);}s.value=value;l.append(s);parent.append(l);return s;};
 const identity=t=>t.id||t.path+'\n'+t.line;
 const submit=(form,label,fn)=>{const b=n('button',label);b.type='submit';form.append(b);form.onsubmit=e=>{e.preventDefault();run(fn)();};};
 const discard=()=>!dirty||confirm('Discard unsaved task links or subtask wording?');
 async function load(){const previous=data?.tasks.find(t=>identity(t)===selected);data=await api('/api/task-projects');if(previous){const current=data.tasks.find(t=>previous.id?t.id===previous.id:t.path===previous.path&&t.line===previous.line);if(current)selected=identity(current);}dirty=false;render();}
 async function saved(){await load();await refresh();message.textContent='Saved. Other tasks keep their own completion state.';}
 function render(){
  body.replaceChildren();
  const projectFilter=select(body,'Show project',[['all','All projects'],['none','No project'],...data.projects.map(p=>[p.path,p.title])],filter);
  projectFilter.onchange=()=>{if(!discard()){projectFilter.value=filter;return;}filter=projectFilter.value;selected=null;dirty=false;render();};
  const tasks=data.tasks.filter(t=>filter==='all'||(filter==='none'?!t.project:t.project===filter));
  if(!tasks.some(t=>identity(t)===selected))selected=tasks[0]?identity(tasks[0]):null;
  const pick=select(body,'Task to connect',tasks.map(t=>[identity(t),(t.done?'Complete · ':t.links.blocked?'Waiting · ':'Ready · ')+t.text]),selected);
  pick.onchange=()=>{if(!discard()){pick.value=selected;return;}selected=pick.value;dirty=false;render();};
  const task=tasks.find(t=>identity(t)===selected);if(!task){body.append(n('p','No tasks here. Add a task in the daily planner first.'));return;}
  body.append(n('h3',task.text),n('p',task.path),n('p',task.done?'Marked complete. Reopening affects only this task.':task.links.blocked?task.links.reasons.join('; '):'Ready: no unfinished prerequisites.'));
  for(const w of task.links.warnings)body.append(n('p',w));
  body.append(button(task.done?'Reopen this task':'Complete this task',async()=>{if(!discard())return;await api('/api/task-toggle',{...task,done:!task.done});await saved();}));
  const form=n('form');form.oninput=()=>dirty=true;form.onchange=()=>dirty=true;
  const projects=[['','No project'],...data.projects.map(p=>[p.path,p.title+' · '+p.path])];if(task.project&&!data.projects.some(p=>p.path===task.project))projects.push([task.project,'Missing project · '+task.project]);
  const project=select(form,'Linked project note',projects,task.project||'');
  const targets=data.tasks.filter(t=>t.id&&t.id!==task.id&&!t.scheduleError&&data.tasks.filter(x=>x.id===t.id).length===1);
  const parents=[['','No parent'],...targets.map(t=>[t.id,t.text])];if(task.parent&&!targets.some(t=>t.id===task.parent))parents.push([task.parent,'Missing parent · '+task.parent]);
  const parent=select(form,'Parent task',parents,task.parent||'');
  const deps=n('fieldset');deps.append(n('legend','Prerequisites'),n('p','Choose tasks that must be marked complete before this task is suggested. Planned time alone does not make a prerequisite complete.'));
  const dependencies=[];
  for(const t of targets){const c=field(deps,(t.done?'Complete · ':'Open · ')+t.text,'checkbox');c.dataset.dependencyId=t.id;c.checked=(task.dependsOn||[]).includes(t.id);dependencies.push(c);}
  for(const id of task.dependsOn||[])if(!targets.some(t=>t.id===id)){const c=field(deps,'Missing prerequisite · '+id,'checkbox');c.dataset.dependencyId=id;c.checked=true;dependencies.push(c);}
  if(!dependencies.length)deps.append(n('p','Add or save another task before choosing a prerequisite.'));form.append(deps);
  submit(form,'Save task links',async()=>{await api('/api/task-schedule',{path:task.path,line:task.line,revision:task.revision,project:project.value||null,parent:parent.value||null,dependsOn:dependencies.filter(c=>c.checked).map(c=>c.dataset.dependencyId)});await saved();});body.append(form);
  body.append(n('h3','Subtasks · '+task.links.completedChildren+' / '+task.links.children.length+' complete'));
  for(const child of task.links.children)body.append(button((child.done?'Complete · ':'Open · ')+child.text,()=>{if(!discard())return;filter='all';selected=child.id||child.path+'\n'+child.line;dirty=false;render();}));
  body.append(n('p','Subtasks are independent tasks. Completing or reopening a parent does not change its children. A new subtask copies this task’s project link and has no deadline or reserved time.'));
  if(!task.id){body.append(n('p','Save task links once before adding subtasks to this older task.'));return;}
  const sub=n('form'),text=field(sub,'New subtask','text'),duration=field(sub,'Subtask estimate (minutes)','number','30');text.required=true;text.maxLength=600;duration.min='5';duration.max='720';duration.required=true;sub.oninput=()=>dirty=true;
  submit(sub,'Add subtask',async()=>{await api('/api/subtask',{task,text:text.value,duration:Number(duration.value)});await saved();});body.append(sub);
 }
 async function open(task){if(busy)return;filter='all';selected=task?identity(task):null;body.replaceChildren(n('p','Loading project tasks…'));dialog.showModal();await run(load)();}
 dialog.append(title,n('p','Link personal tasks to project notes. Save links and subtask forms separately; each successful save refreshes this view.'),button('Close project tasks',()=>{if(discard())dialog.close();}),button('Refresh project tasks',async()=>{if(discard())await load();}),message,body);dialog.addEventListener('cancel',e=>{if(busy||!discard())e.preventDefault();});document.body.append(dialog);
 const launch=button('Project tasks',()=>open());launch.onclick=()=>open();launch.id='day-project-tasks';root.append(launch);return {open};
}
