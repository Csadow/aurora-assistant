import {renderMarkdown} from './markdown.js';
export function agentsWorkspace({api,escape,toast,setView}){
 const $=s=>document.querySelector(s);let selected=null,skill=null,loaded=false,loading=false,renderedVersion=null;
 const safe=fn=>async event=>{try{await fn(event);}catch(e){toast(e.message);}};
 async function loadSkills(){
  const skills=await api('/api/skills');
  for(const id of ['chat-skill','agent-skill','workflow-skill','skill-picker']){const select=$('#'+id),value=select.value;select.innerHTML='<option value="">'+(id==='skill-picker'?'Choose a skill to edit':'No skill')+'</option>'+skills.filter(s=>!['chat-skill','agent-skill'].includes(id)||!s.task).map(s=>`<option value="${escape(s.id)}">${escape(s.title)}</option>`).join('');if(skills.some(s=>s.id===value))select.value=value;if(id==='workflow-skill'&&select.value!==value)select.dispatchEvent(new Event('change'));}
  loaded=true;
 }
 function renderRun(run){selected=run.id;const version=JSON.stringify(run);if(version===renderedVersion)return;renderedVersion=version;$('#agent-detail').innerHTML=`<div class="panel-heading"><h3>${escape(run.task)}</h3><span>${escape(run.status)}</span></div><p class="panel-help">${escape(run.model)}${run.skills.length?' · '+run.skills.map(s=>escape(s.id)).join(', '):''}</p>${run.sources?.length?`<details><summary>Memory provided · ${run.sources.length} notes</summary>${run.sources.map(s=>`<p><button data-note="${escape(s.path)}">${escape(s.path)}</button></p><pre>${escape(s.excerpt)}</pre>`).join('')}</details>`:''}${run.error?`<p class="error">${escape(run.error)}</p>`:''}${run.steps.map(step=>`<details ${step.status==='running'?'open':''}><summary>${escape(step.name)} · ${escape(step.status)} · ${step.tools.length} tool calls</summary><div class="markdown-body">${renderMarkdown(step.output||'Working…')}</div>${step.tools.map(t=>`<details><summary>${escape(t.name)}</summary><pre>${escape(t.result)}</pre></details>`).join('')}</details>`).join('')}${run.result?`<h3>Result</h3><div id="agent-result" class="markdown-body">${renderMarkdown(run.result)}</div><button id="agent-use-result">Discuss this with Aurora ↗</button>`:''}`;
  if(run.result)$('#agent-use-result').onclick=safe(async()=>{await setView('chat');$('#message').value=`Use this local agent report to help me with my request. Check its claims; any actions still require the usual review.\n\nTask: ${run.task}\n\nReport:\n${run.result}`.slice(0,16000);$('#message').dispatchEvent(new Event('input'));$('#message').focus();});
 }
 async function load(){
  if(loading)return;loading=true;try{
   if(!loaded)await loadSkills();const data=await api('/api/agents');
   if(!$('#agent-role').options.length)$('#agent-role').innerHTML=Object.entries(data.roles).map(([id,r])=>`<option value="${id}">${escape(r.name)}</option>`).join('');
   const active=data.runs.find(r=>['queued','running'].includes(r.status));$('#agent-start').disabled=!!active;$('#agent-live-status').textContent=active?`${active.steps.at(-1)?.name||'Preparing'} · ${active.model} · working locally`:'Ready · one local job at a time';
   $('#agent-runs').innerHTML=data.runs.length?data.runs.map(r=>`<article class="action-card"><span class="panel-help">${escape(r.role)} · ${escape(r.status)}</span><h3>${escape(r.task)}</h3><div class="action-buttons"><button data-agent-open="${r.id}">View progress & result</button>${['queued','running'].includes(r.status)?`<button data-agent-stop="${r.id}" class="danger">Stop</button>`:''}</div></article>`).join(''):'<p class="panel-help">Your agent work will appear here and remain available after restart.</p>';
   if(!selected&&active)selected=active.id;if(selected)renderRun(await api('/api/agent-run?id='+selected));
  }finally{loading=false;}
 }
 $('#agent-form').onsubmit=safe(async event=>{event.preventDefault();$('#agent-start').disabled=true;try{const run=await api('/api/agent-start',{role:$('#agent-role').value,task:$('#agent-task').value,skills:$('#agent-skill').value?[$('#agent-skill').value]:[]});selected=run.id;await load();}catch(e){$('#agent-start').disabled=false;throw e;}});
 $('#agent-runs').onclick=safe(async event=>{const b=event.target.closest('button');if(b?.dataset.agentOpen)renderRun(await api('/api/agent-run?id='+b.dataset.agentOpen));if(b?.dataset.agentStop){await api('/api/agent-stop',{id:b.dataset.agentStop});await load();}});
 $('#skill-refresh').onclick=safe(async()=>{await loadSkills();toast('Skill list refreshed. Select a skill to load its current Markdown.');});
 $('#skill-picker').onchange=safe(async()=>{if(!$('#skill-picker').value)return;skill=await api('/api/skill?id='+encodeURIComponent($('#skill-picker').value));$('#skill-id').value=skill.id;$('#skill-id').readOnly=true;$('#skill-content').value=skill.content;$('#skill-location').textContent=skill.path;});
 $('#skill-new').onclick=()=>{skill=null;$('#skill-picker').value='';$('#skill-id').readOnly=false;$('#skill-id').value='';$('#skill-content').value='---\ntitle: "My skill"\nkind: "skill"\nstatus: "reference"\n---\n\n# My skill\n\nDescribe when this helps.\n\n## Instructions\n\nDescribe the steps Aurora should follow.\n';$('#skill-location').textContent='Saved under 70 Skills/<id>/SKILL.md in your vault.';$('#skill-id').focus();};
 $('#skill-form').onsubmit=safe(async event=>{event.preventDefault();const id=$('#skill-id').value.trim();const saved=await api('/api/skill',{id,content:$('#skill-content').value,revision:skill?.revision??null});skill={...saved,id};$('#skill-id').readOnly=true;$('#skill-location').textContent=saved.path;await loadSkills();$('#skill-picker').value=id;toast('Skill saved to Markdown. It applies when selected for a new request.');});
 setInterval(()=>{if(!document.hidden&&!$('#agents-view').hidden)load().catch(()=>{});},2000);
 return {load,loadSkills};
}
