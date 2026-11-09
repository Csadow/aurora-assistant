import {renderMarkdown} from './markdown.js';

export function handoffsUI({api,escape,toast,reload,changed,newInputs}){
  const $=s=>document.querySelector(s),drafts=new Map();let selected=null,request=0,loading=false;
  const safe=fn=>async e=>{try{await fn(e);}catch(error){toast(error.message);}};
  async function refresh(){
    const list=await api('/api/workflow-handoffs'),previous=$('#workflow-handoff').value;
    $('#workflow-handoff').innerHTML='<option value="">No handoff · new task</option>'+list.map(h=>`<option value="${escape(h.id)}">${escape(h.title)}</option>`).join('');
    if(list.some(h=>h.id===previous))$('#workflow-handoff').value=previous;
    else if(previous)clear();
  }
  async function choose(){
    const token=++request,id=$('#workflow-handoff').value;selected=null;loading=!!id;changed();$('#workflow-handoff-preview').textContent=id?'Loading handoff…':'';
    if(!id)return;
    try{
      const h=await api('/api/workflow-handoff?id='+encodeURIComponent(id));if(token!==request)return;selected=h;
      $('#workflow-handoff-preview').innerHTML=`<p class="panel-help">Previous context only. Enter a new goal, workspace and requirements. Review the new plan before starting.</p><button type="button" data-note="${escape(h.path)}">Open handoff note</button><details><summary>Review selected handoff</summary><div class="markdown-body">${renderMarkdown(h.content)}</div></details>`;
    }finally{if(token===request){loading=false;changed();}}
  }
  function clear(){++request;selected=null;loading=false;$('#workflow-handoff').value='';$('#workflow-handoff-preview').textContent='';changed();}
  function parameters(){if(loading||$('#workflow-handoff').value&&!selected)throw Error('Wait for the selected handoff to load.');return selected?{handoffId:selected.id,handoffRevision:selected.revision}:{};}
  function render(w){
    const section=document.createElement('section');section.className='workflow-handoffs';section.id='workflow-handoff-detail';
    section.innerHTML=`${w.handoff?`<h3>Continued from a handoff</h3><p class="panel-help">This task keeps the exact reviewed note revision. Old evidence and approvals do not transfer.</p><button type="button" data-open-workflow="${escape(w.handoff.sourceId)}">Open source task</button><button type="button" data-note="${escape(w.handoff.path)}">Open handoff note</button><details><summary>Handoff used for this task</summary><div class="markdown-body">${renderMarkdown(w.handoff.content)}</div></details>`:''}${['completed','cancelled','paused','needs_help'].includes(w.status)?'<button type="button" id="handoff-prepare">Prepare project handoff</button>':''}`;
    $('#workflow-detail').append(section);
    section.querySelector('#handoff-prepare')?.addEventListener('click',safe(async()=>{drafts.set(w.id,await api('/api/workflow-handoff',{sourceId:w.id}));await reload();}));
    const d=drafts.get(w.id);if(!d)return;
    if(d.saved){const box=document.createElement('p');box.innerHTML=`Saved Markdown handoff: <button type="button" data-note="${escape(d.saved.path)}">Open note</button> <button type="button" id="handoff-use">Use for a new task</button>`;section.append(box);box.querySelector('#handoff-use').onclick=safe(async()=>{newInputs();await refresh();$('#workflow-handoff').value=d.saved.id;await choose();$('#workflow-goal').value='';$('#workflow-scope').value='';$('#workflow-form').scrollIntoView({block:'start'});$('#workflow-goal').focus();toast('Enter the next goal and current workspace, then review a fresh plan.');});return;}
    const form=document.createElement('form');form.id='workflow-handoff-save';form.innerHTML=`<h3>Review project handoff</h3><p class="panel-help">Saving creates a Markdown reference note. It starts no work. Review what was observed and what remains; previous results can become stale.</p><label>Title<input data-handoff="title" value="${escape(d.title)}" maxlength="100" required></label><label>Related project note · optional<input data-handoff="project" value="${escape(d.project)}" placeholder="20 Projects/My project.md"></label><label>Handoff Markdown<textarea data-handoff="body" rows="12" maxlength="12000" required>${escape(d.body)}</textarea></label><button class="primary" ${d.saving?'disabled':''}>Save reviewed handoff</button>`;
    section.append(form);form.oninput=e=>{if(e.target.dataset.handoff)d[e.target.dataset.handoff]=e.target.value;};
    form.onsubmit=safe(async e=>{e.preventDefault();if(d.saving)return;d.saving=true;form.querySelector('button').disabled=true;try{d.saved=await api('/api/workflow-handoff',{sourceId:w.id,handoffId:d.id,draftRevision:d.draftRevision,title:d.title,body:d.body,project:d.project});await refresh();toast('Reviewed handoff saved in project memory.');}finally{d.saving=false;await reload();}});
  }
  $('#workflow-handoff').onchange=safe(choose);$('#workflow-handoff-refresh').onclick=safe(async()=>{await refresh();if($('#workflow-handoff').value)await choose();});
  return {render,refresh,parameters,clear,select:async id=>{await refresh();$('#workflow-handoff').value=id;await choose();},has:()=>!!$('#workflow-handoff').value};
}
