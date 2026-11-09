export function workflowProjectsUI({api,escape,toast,changed}){
  const $=s=>document.querySelector(s);let selected=null,request=0,listRequest=0,loading=false;
  const safe=fn=>async()=>{try{await fn();}catch(e){toast(e.message);}};
  async function refresh(){
    const current=++listRequest,list=await api('/api/project-workspaces');if(current!==listRequest)return;
    const value=$('#workflow-project').value;
    $('#workflow-project').innerHTML='<option value="">No project settings</option>'+list.map(p=>`<option value="${p.id}">${escape(p.name)}</option>`).join('');
    $('#workflow-project').value=value;
    if(value&&!$('#workflow-project').value)clear();
  }
  function clear(){request++;loading=false;selected=null;$('#workflow-project').value='';$('#workflow-project-preview').replaceChildren();changed();}
  async function choose(id=$('#workflow-project').value){
    const sequence=++request;selected=null;loading=!!id;$('#workflow-project-preview').textContent=id?'Loading project settings…':'';changed();if(!id)return;
    try{const {project:p}=await api('/api/project-workspace?id='+encodeURIComponent(id));if(sequence!==request)return;selected=p;
      $('#workflow-project-preview').innerHTML=`<p>Settings revision ${p.revision} · <button type="button" data-note="${escape(p.notePath)}">Open project note</button></p><ul>${p.folders.map(f=>`<li><code>${escape(f)}</code></li>`).join('')}</ul><p class="panel-help">Select required checks for this task. Saving a check does not approve it. File tools and command working directories use these folders; commands and apps can still affect other locations, so review their actual effects.</p>${p.checks.map((c,i)=>`<label class="check-row"><input type="checkbox" data-project-check="${i}">${escape(c.name)}</label><pre>${escape(JSON.stringify({program:c.program,args:c.args,cwd:c.cwd,outputIncludes:c.outputIncludes},null,2))}</pre>`).join('')}`;
      const policy=document.createElement('label');policy.textContent='Test before editing';
      const select=document.createElement('select');select.id='workflow-copy-before-edit';select.setAttribute('aria-label','Test before editing');
      select.add(new Option('Optional copy tests',''));
      for(const c of p.checks.filter(c=>c.program==='/usr/bin/node'&&c.args?.[0]==='--test'))select.add(new Option('Require '+c.name+' in copies',c.name));
      policy.append(select);$('#workflow-project-preview').append(policy);
      const help=document.createElement('p');help.className='panel-help';help.textContent='Requires explicit output files and a selected saved Node check with test paths. Every candidate must run in copies before its edit review. Failed assertions need your review; missing dependencies block edits. This choice is fixed for the task.';policy.append(help);
      const routine=document.createElement('label');routine.className='check-row';
      routine.innerHTML='<input type="checkbox" id="workflow-routine-continuation">Continue routine project steps';
      const routineHelp=document.createElement('p');routineHelp.className='panel-help';routineHelp.textContent='Collect required file reads, prepare saved repair/test reviews, and verify declared results between model decisions. Edits and commands still need exact approval. Requires explicit output files and selected checks. Leave off for discussion first. Fixed for this task.';
      $('#workflow-project-preview').append(routine,routineHelp);routine.querySelector('input').onchange=changed;
      select.onchange=()=>{for(const box of document.querySelectorAll('[data-project-check]'))if(p.checks[Number(box.dataset.projectCheck)].name===select.value)box.checked=true;changed();};
    }finally{if(sequence===request){loading=false;changed();}}
  }
  $('#workflow-project').onchange=safe(()=>choose());$('#workflow-project-refresh').onclick=safe(async()=>{await refresh();await choose();});
  return {refresh,clear,has:()=>!!selected||loading,choose:async id=>{const current=++request;await refresh();if(current!==request)return;$('#workflow-project').value=id;await choose(id);},parameters:()=>{
    if(loading)throw Error('Wait for the selected project settings to load.');
    if($('#workflow-project').value&&!selected)throw Error('Reload and review this project before planning.');
    return selected?{projectId:selected.id,projectRevision:selected.revision,routineContinuation:!!$('#workflow-routine-continuation')?.checked,...$('#workflow-copy-before-edit')?.value?{copyBeforeEditCheck:$('#workflow-copy-before-edit').value}:{},projectCheckNames:[...document.querySelectorAll('[data-project-check]:checked')].map(el=>selected.checks[Number(el.dataset.projectCheck)].name)}:{};
  }};
}

export function projectsWorkspace({api,escape,toast,state,newTask}){
  const $=s=>document.querySelector(s),drafts=new Map();let selected=localStorage.getItem('aurora-project')||'',sequence=0,saving=false,pendingReset=null;
  const safe=fn=>async e=>{try{await fn(e);}catch(error){toast(error.message);}};
  const blank=()=>({name:'',notePath:'',folders:[],checks:[]});
  let draft=blank();
  function editor(value){
    draft=structuredClone(value);
    $('#project-settings-fields').innerHTML=`<label>Project name<input id="project-name" maxlength="100" required value="${escape(draft.name)}"></label><label>Project note · existing vault path<input id="project-note" list="project-notes" required value="${escape(draft.notePath)}" placeholder="20 Projects/My project.md"></label><datalist id="project-notes">${state.notes.filter(n=>!['draft','journal','archived'].includes(n.status)&&n.kind!=='handoff').map(n=>`<option value="${escape(n.path)}">${escape(n.title)}</option>`).join('')}</datalist><label>Folders · one absolute path per line<textarea id="project-folders" rows="3" required placeholder="/home/…/project">${escape(draft.folders.join('\n'))}</textarea></label><div id="project-checks">${draft.checks.map((c,i)=>`<fieldset data-project-check-editor="${i}"><legend>Saved check ${i+1}</legend><label>Name<input data-check-field="name" maxlength="80" required value="${escape(c.name)}"></label><label>Executable<input data-check-field="program" required value="${escape(c.program)}" placeholder="node"></label><label>Arguments · one per line<textarea data-check-field="args" rows="3">${escape(c.args.join('\n'))}</textarea></label><label>Working directory<input data-check-field="cwd" required value="${escape(c.cwd)}"></label><label>Required text in successful output<textarea data-check-field="outputIncludes" rows="2" maxlength="500" required>${escape(c.outputIncludes)}</textarea></label><button type="button" data-remove-check="${i}">Remove check</button></fieldset>`).join('')}</div><button type="button" id="project-add-check" ${draft.checks.length>=2?'disabled':''}>Add saved check</button>`;
    $('#project-editor-status').textContent=draft.id?`Editing settings revision ${draft.revision}. Changes apply to future tasks.`:'Create a workspace linked to an existing Markdown note.';
  }
  function capture(){
    pendingReset=null; // A newer user edit or selection supersedes a pending reload.
    draft.name=$('#project-name').value;draft.notePath=$('#project-note').value;draft.folders=$('#project-folders').value.split('\n').map(x=>x.trim()).filter(Boolean);
    draft.checks=[...document.querySelectorAll('[data-project-check-editor]')].map(el=>Object.fromEntries([...el.querySelectorAll('[data-check-field]')].map(field=>[field.dataset.checkField,field.dataset.checkField==='args'?(field.value?field.value.split('\n'):[]):field.value])));
    drafts.set(selected,structuredClone(draft));
  }
  function render(data){
    const {project:p,tasks,handoffs}=data;
    if(draft.id===p.id&&draft.revision!==p.revision)$('#project-editor-status').textContent=`Saved settings are now revision ${p.revision}. Your revision ${draft.revision} draft is kept; discard and reload to edit the latest settings.`;
    $('#project-history').innerHTML=`<div class="panel-heading"><h3>${escape(p.name)}</h3><button data-note="${escape(p.notePath)}">Open project note</button></div><button id="project-new-task" class="primary">New task for this project</button><p class="panel-help">${tasks.length} linked tasks · ${handoffs.length} saved handoffs. Results below are Aurora’s assessments; open a task for its observations and approvals.</p><h3>Tasks & results</h3>${tasks.map(w=>`<article class="action-card"><span class="panel-help">${escape(w.status.replaceAll('_',' '))} · ${w.current}/${w.steps} steps · settings revision ${w.projectRevision}</span><h3>${escape(w.goal)}</h3>${w.result?`<p class="project-result">${escape(w.result)}</p>`:''}${w.error?`<p class="permission-notice">${escape(w.error)}</p>`:''}<button data-open-workflow="${w.id}">Open task</button>${w.sourceId?`<button data-open-workflow="${w.sourceId}">Previous task</button>`:''}${w.children.map(c=>`<button data-open-workflow="${c.id}">Follow-up: ${escape(c.goal.slice(0,100))}</button>`).join('')}</article>`).join('')||'<p class="empty">No tasks yet. Start one with these project settings.</p>'}<h3>Reviewed handoffs</h3>${handoffs.map(h=>`<article class="action-card"><h4>${escape(h.title)}</h4><button data-note="${escape(h.path)}">Open handoff note</button><button data-open-workflow="${h.sourceId}">Source task</button><button data-project-handoff="${h.id}">Use for a new task</button></article>`).join('')||'<p class="panel-help">Prepare and save a handoff from a finished or safely paused task to see it here.</p>'}`;
    $('#project-new-task').onclick=safe(()=>newTask(p.id));
    $('#project-history').querySelectorAll('[data-project-handoff]').forEach(b=>b.onclick=safe(()=>newTask(p.id,b.dataset.projectHandoff)));
  }
  async function load({reset=false}={}){
    if(reset)pendingReset=selected;
    const request=++sequence,id=selected,list=await api('/api/project-workspaces');if(request!==sequence)return;
    $('#project-list').innerHTML=list.map(p=>`<button data-project-open="${p.id}" class="${p.id===id?'selected':''}">${escape(p.name)}</button>`).join('')||'<p class="panel-help">Add your first project below.</p>';
    if(!id){if(pendingReset===id||!$('#project-name'))editor(drafts.get('')||blank());if(pendingReset===id)pendingReset=null;$('#project-history').innerHTML='<p class="empty">Choose a project to see its tasks and handoffs.</p>';return;}
    const data=await api('/api/project-workspace?id='+encodeURIComponent(id));if(request!==sequence)return;
    render(data);if(pendingReset===id||!$('#project-name')||draft.id!==id){editor(drafts.get(id)||data.project);if(pendingReset===id)pendingReset=null;}
  }
  $('#project-settings-form').oninput=()=>{if(!saving)capture();};
  $('#project-settings-fields').onclick=e=>{if(saving)return;const b=e.target.closest('button');if(!b)return;capture();if(b.id==='project-add-check')draft.checks.push({name:'',program:'node',args:[],cwd:draft.folders[0]||'',outputIncludes:''});else if(b.dataset.removeCheck!==undefined)draft.checks.splice(Number(b.dataset.removeCheck),1);else return;drafts.set(selected,structuredClone(draft));editor(draft);};
  $('#project-settings-form').onsubmit=safe(async e=>{
    e.preventDefault();if(saving)return;
    if((draft.id||'')!==selected)throw Error('Wait for the chosen project settings to load.');
    capture();saving=true;sequence++;$('#project-settings-form').inert=true;$('#project-list').inert=true;$('#project-create').disabled=true;
    try{const saved=await api('/api/project-workspace',draft);drafts.delete(selected);selected=saved.id;localStorage.setItem('aurora-project',selected);editor(saved);await load();toast('Project settings saved. No commands ran; existing tasks keep their reviewed settings.');}
    finally{saving=false;$('#project-settings-form').inert=false;$('#project-list').inert=false;$('#project-create').disabled=false;}
  });
  $('#project-list').onclick=safe(async e=>{if(saving)return;const id=e.target.closest('button')?.dataset.projectOpen;if(!id)return;if($('#project-name'))capture();selected=id;localStorage.setItem('aurora-project',id);await load({reset:true});});
  $('#project-create').onclick=safe(async()=>{if(saving)return;if($('#project-name'))capture();selected='';localStorage.removeItem('aurora-project');editor(drafts.get('')||blank());await load();$('#project-name').focus();});
  $('#project-refresh').onclick=safe(()=>load());
  $('#project-reload-settings').onclick=safe(async()=>{if(saving)return;drafts.delete(selected);await load({reset:true});});
  return {load};
}
