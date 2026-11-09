import {renderMarkdown} from './markdown.js';

export function taskSkillsUI({api,escape,toast,reload,refreshSkills,planRequired=()=>false,newInputs=()=>{}}){
  const $=s=>document.querySelector(s),drafts=new Map();let selected=null,request=0,loading=false;
  const safe=fn=>async e=>{try{await fn(e);}catch(error){toast(error.message);}};
  async function loadSelection({preserve=false}={}){
    const version=++request,id=$('#workflow-skill').value;
    const previous=preserve?Object.fromEntries([...document.querySelectorAll('[data-skill-input]')].map(x=>[x.dataset.skillInput,x.value])):{};
    selected=null;loading=!!id;$('#workflow-skill-inputs').textContent=id?'Loading skill…':'';
    $('#workflow-start').textContent=planRequired()?'Prepare plan':'Start workflow';
    if(!id)return;
    try{
      const skill=await api('/api/skill?id='+encodeURIComponent(id));if(version!==request)return;
      selected=skill;
      if(!skill.task){$('#workflow-skill-inputs').textContent='';return;}
      $('#workflow-start').textContent='Prepare plan';
      $('#workflow-skill-inputs').innerHTML=skill.task.error?`<p class="permission-notice">${escape(skill.task.error)} Edit this skill in Agents & skills.</p><button type="button" id="workflow-skill-refresh">Reload skill</button>`:`<p class="panel-help">Supply fresh inputs. Prepare plan does not perform actions; you review the plan before starting.</p>${skill.task.inputs.map(x=>`<label>${escape(x.label)}<textarea data-skill-input="${escape(x.name)}" rows="2" maxlength="1500" required>${escape(previous[x.name]||'')}</textarea></label>`).join('')}<details><summary>Review skill instructions</summary><div class="markdown-body">${renderMarkdown(skill.body)}</div></details><button type="button" id="workflow-skill-refresh">Reload skill</button>`;
      $('#workflow-skill-refresh').onclick=safe(()=>loadSelection({preserve:true}));
    }catch(e){if(version===request){$('#workflow-skill-inputs').textContent=e.message;throw e;}}
    finally{if(version===request)loading=false;}
  }
  $('#workflow-skill').onchange=safe(()=>loadSelection());
  function parameters(){
    if(loading)throw new Error('Wait for the selected skill to load.');
    const id=$('#workflow-skill').value;
    if(!id)return {};
    if(selected?.id!==id)throw new Error('Select the skill again to review its current inputs.');
    if(selected.task?.error)throw new Error('Fix this skill in Agents & skills before using it.');
    if(!selected.task)return {};
    return {skillRevision:selected.revision,skillInputs:Object.fromEntries([...document.querySelectorAll('[data-skill-input]')].map(x=>[x.dataset.skillInput,x.value]))};
  }
  function clearInputs(){for(const input of document.querySelectorAll('[data-skill-input]'))input.value='';}
  function render(w){
    const tasks=w.skills.filter(s=>s.task);
    if(tasks.length){const info=document.createElement('details');info.id='workflow-bound-skill';info.innerHTML=`<summary>Skill and inputs for this run</summary>${tasks.map(s=>`<h3>${escape(s.title||s.id)}</h3><p class="panel-help">This task keeps the reviewed skill version and its inputs. Later vault edits do not change this run.</p><dl>${Object.entries(s.inputs).map(([key,value])=>`<dt>${escape(key.replaceAll('_',' '))}</dt><dd>${escape(value)}</dd>`).join('')}</dl><div class="markdown-body">${renderMarkdown(s.content)}</div>`).join('')}`;$('#workflow-detail .workflow-steps').before(info);}
    if(w.status!=='completed')return;
    const section=document.createElement('section'),draft=drafts.get(w.id);section.className='workflow-skill-draft';
    section.innerHTML=`<button type="button" id="workflow-skill-draft">Draft reusable task skill</button>${draft?`<form id="workflow-skill-save"><h3>Review the reusable procedure</h3><p class="panel-help">Only verified operation types were reused. No old goals, paths, file contents, commands or approvals were copied. Check the inputs, procedure and verification before saving.</p><fieldset ${draft.saving?'disabled':''}><label>Skill ID<input id="workflow-skill-id" pattern="[a-z0-9][a-z0-9-]{0,59}" maxlength="60" required value="${escape(draft.id)}"></label><label>Editable Markdown<textarea id="workflow-skill-content" rows="14" maxlength="12000" required>${escape(draft.content)}</textarea></label><button class="primary">Save reviewed skill</button></fieldset></form>${draft.saved?`<p class="panel-help">Saved to ${escape(draft.saved.path)}.</p><button id="workflow-skill-use" type="button">Use saved skill with new inputs</button>`:''}`:''}`;
    $('#workflow-aftercare').append(section);
    $('#workflow-skill-draft').onclick=safe(async()=>{if(!drafts.has(w.id))drafts.set(w.id,await api('/api/workflow-skill',{id:w.id}));await reload();$('#workflow-skill-content')?.scrollIntoView({block:'center'});});
    if(!draft)return;
    section.addEventListener('input',e=>{if(e.target.id==='workflow-skill-id')draft.id=e.target.value;if(e.target.id==='workflow-skill-content')draft.content=e.target.value;});
    $('#workflow-skill-save').onsubmit=safe(async e=>{
      e.preventDefault();if(draft.saving)return;draft.saving=true;section.querySelector('fieldset').disabled=true;
      try{const saved=await api('/api/workflow-skill',{id:w.id,skillId:draft.id,content:draft.content,revision:draft.saved?.id===draft.id?draft.saved.revision:null});draft.saved={...saved,id:draft.id};await refreshSkills();toast('Skill saved. A new run needs fresh inputs and plan review.');}
      finally{draft.saving=false;await reload();}
    });
    if($('#workflow-skill-use'))$('#workflow-skill-use').onclick=safe(async()=>{
      await refreshSkills();newInputs();$('#workflow-skill').value=draft.saved.id;$('#workflow-goal').value='';$('#workflow-scope').value='';await loadSelection();$('#workflow-form').scrollIntoView({block:'start'});$('#workflow-goal').focus();toast('Supply a new goal, workspace and inputs, then prepare the plan.');
    });
  }
  return {parameters,clearInputs,render,loadSelection,isTask:()=>!!selected?.task};
}
