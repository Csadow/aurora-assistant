import {taskCapture} from './task-capture.js';
import {dayPlanning} from './day-planning.js';
import {taskProposalReview} from './task-proposal-review.js';
import {projectsWorkspace} from './project-workspaces.js';
import {readAloudButton,speechControls,stopSpeech} from './speech.js';
import { renderMarkdown } from './markdown.js';
import { planning } from './planning.js';
import { memoryReview } from './memory-review.js';
import { workflowsWorkspace } from './workflows.js';
import { agentsWorkspace } from './agents.js';
import { integrations } from './integrations.js';
const $=s=>document.querySelector(s);
const state={bootstrap:null,notes:[],tasks:[],proposals:[],conversations:[],conversation:null,view:'chat',generating:false,controller:null,note:null,dirty:false,searchPaths:null};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let toastTimer;
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6000);}
async function api(path,data){
  const res=await fetch(path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-Aster-Token':state.bootstrap.token},body:data===undefined?undefined:JSON.stringify(data)});
  const value=await res.json();if(!res.ok)throw new Error(value.error||'Request failed.');return value;
}
function safe(fn){return async event=>{try{await fn(event);}catch(e){toast(e.message);}};}
function sourceAttrs(s){return s.project?`data-project="${escape(s.project)}" data-file="${escape(s.path)}"`:`data-note="${escape(s.path)}"`;}
function sourceButtons(sources){return sources.map(s=>`<button ${sourceAttrs(s)} title="${escape(s.excerpt)}">[${s.id}] ${escape(s.title)}</button>`).join('');}
const format=renderMarkdown;
async function refresh(){
  state.bootstrap=await api('/api/bootstrap');
  try{[state.notes,state.tasks,state.proposals,state.conversations]=await Promise.all([api('/api/notes'),api('/api/tasks'),api('/api/proposals'),api('/api/conversations')]);}catch(e){planner.unavailable(e);throw e;}
  $('#note-count').textContent=state.notes.filter(n=>n.status!=='journal').length;
  $('#task-count').textContent=state.tasks.filter(t=>!t.done).length||'';
  $('#inbox-count').textContent=state.proposals.length||'';
  $('#conversations').innerHTML=state.conversations.slice(0,25).map(c=>`<button data-conversation="${c.id}" class="${c.id===state.conversation?.id?'selected':''}" title="${escape(c.title)}">${escape(c.title)}</button>`).join('');
  renderWorkspace();if(state.view==='memory')renderNotes();if(state.view==='tasks')renderTasks();if(state.view==='inbox')renderProposals();if(state.view==='graph')await renderGraph();await planner.load();if(state.view==='review'&&!reviewer.isBusy())await reviewer.load();if(state.view==='agents')await agentUI.load();if(state.view==='workflows')await workflowUI.load();if(state.view==='projects')await projectUI.load();
}
async function setView(view){
  state.view=view;document.body.dataset.workspaceView=view;document.body.classList.remove('menu-open');$('#menu').setAttribute('aria-expanded','false');
  document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==`${view}-view`);
  document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  $('#section-tab').hidden=view==='chat';$('#section-tab').textContent=({projects:'Projects',workflows:'Workflows',agents:'Agents & skills',overview:'Your day',review:'Memory review',memory:'Memory',tasks:'Tasks',graph:'Connections',inbox:'Review inbox',actions:'Actions'})[view]||'';$('#section-tab').dataset.view=view;document.querySelectorAll('.workspace-tab').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  await refresh();if(view==='chat')$('#message').focus();
}
function toolEvidence(tools){
  if(!Array.isArray(tools)||!tools.length)return '';
  const labels={completed:'Completed',failed:'Could not run',review:'Needs review',queued:'Saved as task'};
  return `<details class="tool-evidence"><summary>Tools used · ${tools.length}</summary><ul>${tools.map(tool=>`<li><span>${escape(String(tool.name||'tool').replaceAll('_',' '))}</span><span>${escape(labels[tool.status]||'Unknown')}</span></li>`).join('')}</ul></details>`;
}
function messageElement(message){
  const el=document.createElement('article');el.className=`message ${message.role}`;
  el.innerHTML=`<div class="message-label">${message.role==='user'?'You':'✳ Aurora'}</div><div class="message-body">${format(message.content,message.sources)}</div><div class="sources" aria-label="Reference notes included in this response">${sourceButtons(message.sources||[])}</div>${toolEvidence(message.tools)}${message.workflow?`<button data-open-workflow="${escape(message.workflow)}">Task progress & approvals ↗</button>`:''}${message.interrupted?'<div class="message-meta">Interrupted · partial answer</div>':''}${message.metrics?`<div class="message-meta">${message.engine==='chatgpt'?escape(message.metrics.model||'ChatGPT')+' · ChatGPT':(message.metrics.seconds??'')+' s · local generation'}</div>`:''}`;
  if(message.role==='assistant'&&!message.interrupted){const read=readAloudButton(message.content,toast);if(read)el.append(read);}
  return el;
}
function renderConversation(){
  $('#chat-title').textContent=state.conversation?.title||'New conversation';const messages=state.conversation?.messages||[];$('#welcome').hidden=!!messages.length;
  $('#messages').replaceChildren(...messages.map(messageElement));scrollChat();
}
function scrollChat(){const el=$('#messages');el.scrollTop=el.scrollHeight;}
async function newConversation(){
  if(state.generating){toast('Stop the current answer before starting a new conversation.');return;}
  state.conversation=await api('/api/conversations',{});localStorage.setItem('aster-conversation',state.conversation.id);renderConversation();await setView('chat');
}
async function loadConversation(id){
  if(state.generating){toast('Stop the current answer before switching conversations.');return;}
  state.conversation=await api(`/api/conversation?id=${encodeURIComponent(id)}`);localStorage.setItem('aster-conversation',id);renderConversation();await setView('chat');
}
$('#mode').onchange=()=>{$('#task-mode-help').hidden=$('#mode').value!=='steer';};
const cloudPrivacyNote='ChatGPT receives this chat, relevant memory and tasks, and tool results. Laptop tasks from this chat use ChatGPT; actions still need review.';
const cloudUnavailableNote=account=>account.reconnectRequired?'ChatGPT is unavailable. Choose Local above to continue. Your cloud model stays saved.':'ChatGPT is unavailable. Choose Local above, or connect a model in Settings.';
$('#chat-engine').onchange=()=>{localStorage.setItem('aster-chat-engine',$('#chat-engine').value);$('#chat-engine-note').textContent=$('#chat-engine').value==='chatgpt'?cloudPrivacyNote:'Local answers stay on this laptop.';status().catch(e=>toast(e.message));};
function busy(value){state.generating=value;$('#status-mode').textContent=value?'Generating…':'Ready';$('#send').hidden=value;$('#stop').hidden=!value;$('#message').disabled=value;$('#new-chat').disabled=value;$('#mode').disabled=value;$('#chat-engine').disabled=value;}
let checkingCloudRoute=false;
async function send(text,actionId){
  if(state.generating||checkingCloudRoute||!text.trim())return;
  if($('#chat-engine').value==='chatgpt'){
    checkingCloudRoute=true;
    try{
      const account=await api('/api/chatgpt');
      if($('#chat-engine').value!=='chatgpt')return;
      if(!account.connected||!account.account?.model){const note=cloudUnavailableNote(account);$('#chat-engine-note').textContent=note;toast(note);$('#chat-engine').focus();return;}
    }finally{checkingCloudRoute=false;}
  }
  stopSpeech();
  if(!state.conversation)state.conversation=await api('/api/conversations',{});
  localStorage.setItem('aster-conversation',state.conversation.id);
  state.conversation.messages.push({role:'user',content:text});renderConversation();$('#message').value='';localStorage.removeItem('aster-composer');busy(true);
  const assistantMessage={role:'assistant',content:'',sources:[]};const el=messageElement(assistantMessage);$('#messages').append(el);
  state.controller=new AbortController();$('#activity').textContent=$('#chat-engine').value==='chatgpt'?'Gathering relevant context for ChatGPT…':'Gathering your memory and waking the local model…';
  let receivedDone=false,receivedError=false,buffer='',responseStarted=false;
  const process=event=>{
    responseStarted=true;
    if(event.type==='sources'){assistantMessage.sources=event.sources;$('#recall-status').textContent=`${event.sources.length} references in context.`;el.querySelector('.sources').innerHTML=sourceButtons(event.sources);}
    if(event.type==='chunk'){assistantMessage.content+=event.text;el.querySelector('.message-body').innerHTML=format(assistantMessage.content,assistantMessage.sources);$('#activity').textContent='Aurora is writing…';scrollChat();}
    if(event.type==='thinking')$('#activity').textContent=$('#chat-engine').value==='chatgpt'?'ChatGPT is reasoning…':'Aurora is reasoning locally… larger models can take several minutes.';
    if(event.type==='tool')$('#activity').textContent=`${event.status==='running'?'Working':'Finished'}: ${event.name.replaceAll('_',' ')}…`;
    if(event.type==='workflow'){assistantMessage.workflow=event.workflow.id;toast(event.workflow.control?'Task updated. Open its progress for the current state.':'Laptop task saved. Open its progress for reviews and Stop/Resume.');}
    if(event.type==='action'){toast('Aurora requested an action. Open Actions to review it.');features.refresh().catch(()=>{});}
    if(event.type==='proposal')toast('A new suggestion is ready in your review inbox.');
    if(event.type==='done'){receivedDone=true;state.conversation=event.conversation;renderConversation();}
    if(event.type==='error'){receivedError=true;throw new Error(event.error);}
  };
  try{
    const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':state.bootstrap.token},body:JSON.stringify({id:state.conversation.id,message:text,mode:$('#mode').value,skills:$('#chat-skill').value?[$('#chat-skill').value]:[],engine:$('#chat-engine').value,actionId}),signal:state.controller.signal});
    if(!res.ok)throw new Error((await res.json()).error);
    const reader=res.body.getReader(),decoder=new TextDecoder();
    while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line)process(JSON.parse(line));}}
    buffer+=decoder.decode();if(buffer.trim())process(JSON.parse(buffer));
    if(!receivedDone&&!receivedError)throw new Error('Connection ended before the answer completed.');
  }catch(e){
    const stopped=e.name==='AbortError';toast(stopped?'Stopped. Your partial conversation is kept.':e.message);
    const note=document.createElement('div');note.className='error';note.textContent=stopped?'Generation stopped.':e.message;el.append(note);
    const retry=document.createElement('button');retry.className='retry';retry.textContent='Put message back in composer';retry.onclick=()=>{$('#message').value=text;$('#message').focus();};el.append(retry);
    if(!responseStarted)state.conversation.messages.pop();
    else state.conversation.messages.push({...assistantMessage,interrupted:true});
  }finally{busy(false);$('#activity').textContent='';state.controller=null;await refresh();$('#message').focus();}
}
function renderNotes(){
  const query=$('#note-search').value.toLowerCase();const folder=$('#note-filter').value;
  const notes=state.notes.filter(n=>(!folder?!n.path.startsWith('90 Journal/'):n.path.startsWith(folder+'/'))&&(!query||state.searchPaths?.has(n.path)));
  $('#note-grid').innerHTML=notes.length?notes.map(n=>`<button class="note-card" data-note="${escape(n.path)}"><small>${escape(n.path.split('/')[0].replace(/^\d+ /,''))}${n.pinned?' · PINNED':''}</small><h3>${escape(n.title)}</h3><p>${escape(n.preview.replace(/[#*\[\]]/g,''))}</p><footer>${escape(n.tags.map(t=>'#'+t).join(' '))||`${n.links.length} connection${n.links.length===1?'':'s'}`}</footer></button>`).join(''):'<div class="empty">No notes here yet. Add a note or try another search.</div>';
}
function confirmDiscard(){return !state.dirty||confirm('Discard the unsaved changes in this note?');}
function showContext(){document.body.classList.remove('context-closed');document.body.classList.add('context-open');localStorage.setItem('aster-context','open');}
function noteMode(edit){$('#note-content').hidden=!edit;$('#note-preview').hidden=edit;$('#edit-note').classList.toggle('active',edit);$('#preview-note').classList.toggle('active',!edit);if(!edit)$('#note-preview').innerHTML=format($('#note-content').value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/,'').replace(/^\s*# .+\n/,''));}
function markDirty(){state.dirty=true;$('#save-state').textContent='Unsaved';localStorage.setItem('aster-note-draft',JSON.stringify({path:$('#note-path').value,content:$('#note-content').value,revision:state.note?.revision??null}));}
function clearDraft(){state.dirty=false;localStorage.removeItem('aster-note-draft');$('#save-state').textContent='Saved';}
function closeNote(){if(!confirmDiscard())return;clearDraft();$('#note-dialog').hidden=true;$('#context-overview').hidden=false;state.note=null;renderWorkspace();}
async function openNote(path){
  if(!$('#note-dialog').hidden&&!confirmDiscard())return;
  const note=await api(`/api/note?path=${encodeURIComponent(path)}`);state.note=note;clearDraft();
  $('#note-heading').textContent=note.title;$('#note-location').textContent=note.path;$('#note-path').value=note.path;$('#note-path').readOnly=true;$('#note-path-label').hidden=true;$('#note-content').value=note.content;$('#note-error').textContent='';$('#trash-note').hidden=false;$('#reload-note').hidden=false;$('#history-details').hidden=false;
  $('#obsidian-link').hidden=false;$('#obsidian-link').href=`obsidian://open?path=${encodeURIComponent(state.bootstrap.vault+'/'+note.path)}`;
  const backlinks=state.notes.filter(n=>n.links.some(l=>l===note.title||l===note.path.slice(0,-3)||l===note.path.split('/').at(-1).slice(0,-3)||note.aliases?.includes(l)));
  $('#backlinks').innerHTML=backlinks.length?`Linked from ${backlinks.map(n=>`<button type="button" data-note="${escape(n.path)}">${escape(n.title)}</button>`).join('')}`:'No linked notes yet.';
  const history=await api(`/api/history?path=${encodeURIComponent(path)}`);
  $('#history-list').innerHTML=history.length?history.slice(0,15).map(id=>`<button type="button" data-version="${id}">${new Date(Number(id.split('-')[0])).toLocaleString()} · Preview version</button>`).join(''):'No previous versions.';
  $('#context-overview').hidden=true;$('#note-dialog').hidden=false;showContext();noteMode(false);renderWorkspace();
}
function createNote(){if(!confirmDiscard())return;state.note=null;clearDraft();$('#note-heading').textContent='New note';$('#note-location').textContent='New memory';$('#note-path').value='30 Knowledge/Untitled.md';$('#note-path').readOnly=false;$('#note-path-label').hidden=false;$('#note-content').value='---\ntitle: "Untitled"\nstatus: "confirmed"\n---\n\n# Untitled\n\n';$('#note-error').textContent='';$('#backlinks').textContent='';$('#history-details').hidden=true;$('#trash-note').hidden=true;$('#reload-note').hidden=true;$('#obsidian-link').hidden=true;$('#context-overview').hidden=true;$('#note-dialog').hidden=false;showContext();noteMode(true);$('#note-path').focus();}
function renderTasks(){
  const tasks=[...state.tasks].sort((a,b)=>Number(a.done)-Number(b.done));
  $('#task-list').innerHTML=tasks.length?tasks.map(t=>`<div class="task-row ${t.done?'done':''}"><input type="checkbox" aria-label="${escape(t.text)}" ${t.done?'checked':''} data-task="${escape(t.path)}" data-line="${t.line}" data-revision="${t.revision}"><div><span class="task-text">${escape(t.text)}</span><small>${escape(t.path)}${planner.label(t)?' · '+escape(planner.label(t)):''}</small></div><button data-task-schedule="${escape(t.path)}" data-line="${t.line}">Schedule</button><button data-note="${escape(t.path)}">Open note ↗</button></div>`).join(''):'<div class="empty">A little breathing room.<br>Add your next step above, or ask Aurora to help make a plan.</div>';
}
function renderProposals(){
  $('#proposal-list').innerHTML=state.proposals.length?state.proposals.map(p=>p.kind==='memory_correction'?`<article class="proposal"><small>MEMORY CORRECTION · ${p.appliedAt?'SAVED; HISTORY RECEIPT PENDING':'REVIEW BEFORE SAVING'}</small><h3>${escape(p.title)}</h3><p>${escape(p.path)}</p><p>${escape(p.reason)} · ${escape(p.source)}</p><h4>Before</h4><pre>${escape(p.before)}</pre><h4>After</h4><pre>${escape(p.after||'(Delete this text)')}</pre><button class="primary" data-proposal="${p.id}" data-action="accept">${p.applying?'Finish correction':'Accept correction'}</button><button data-proposal="${p.id}" data-action="dismiss" ${p.applying?'disabled':''}>Dismiss</button></article>`:['day_replan','evening_review','weekly_review','focus_schedule','future_schedule'].includes(p.kind)?`<article class="proposal"><h3>${escape(p.title)}</h3><p>${p.changes.length} task changes · ${p.saved.length} task notes saved</p><button data-day-review="${p.id}">${p.kind==='future_schedule'?'Review day plan':p.kind==='focus_schedule'?'Review focused task times':p.kind==='weekly_review'?'Review weekly decisions':p.kind==='evening_review'?'Review evening decisions':'Review day plan'}</button></article>`:taskProposalReview(p,escape)||`<article class="proposal"><small>${p.kind==='task'?'SUGGESTED TASK':'SUGGESTED MEMORY'} · NOT YET SAVED</small><h3>${escape(p.title)}</h3><pre>${escape(p.content||p.text)}</pre>${p.kind==='task'&&p.due?`<p>Due: ${escape(p.due)}</p>`:''}${p.kind==='task'&&p.remindAt?`<p>Reminder: ${escape(new Date(p.remindAt).toLocaleString())} · scheduled only after acceptance</p>`:''}<button class="primary" data-proposal="${p.id}" data-action="accept">${p.kind==='task'?'Add task':'Keep memory'}</button><button data-proposal="${p.id}" data-action="dismiss">Dismiss</button></article>`).join(''):'<div class="empty">All caught up.<br>When Aurora suggests a memory or task, you can review it here.</div>';
}
async function renderGraph(){
  const graph=await api('/api/graph');const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 960 530');svg.setAttribute('role','img');svg.setAttribute('aria-label','Linked memory notes');
  const folders=[...new Set(graph.nodes.map(n=>n.folder))],colors=['#adc3a0','#dedaa6','#b9cdbf','#c6c2d6','#e0c7b5','#c6d3a9','#b3d3cd'];const positions=new Map();
  folders.forEach((folder,fi)=>{
    const angle=2*Math.PI*fi/folders.length-Math.PI/2,cx=480+Math.cos(angle)*260,cy=270+Math.sin(angle)*165;
    const nodes=graph.nodes.filter(n=>n.folder===folder);
    nodes.forEach((n,i)=>{const a=i*2*Math.PI/nodes.length;positions.set(n.id,{x:cx+(nodes.length>1?Math.cos(a)*Math.min(85,nodes.length*20):0),y:cy+(nodes.length>1?Math.sin(a)*Math.min(65,nodes.length*15):0),color:colors[fi%colors.length]});});
  });
  for(const e of graph.edges){const a=positions.get(e.source),b=positions.get(e.target);if(!a||!b)continue;const line=document.createElementNS(svg.namespaceURI,'line');for(const [k,v] of Object.entries({x1:a.x,y1:a.y,x2:b.x,y2:b.y,class:'edge'}))line.setAttribute(k,v);svg.append(line);}
  for(const n of graph.nodes){const p=positions.get(n.id);const g=document.createElementNS(svg.namespaceURI,'g');g.setAttribute('class','node');g.setAttribute('tabindex','0');g.setAttribute('role','button');g.setAttribute('aria-label',n.title);g.dataset.note=n.id;const c=document.createElementNS(svg.namespaceURI,'circle');for(const [k,v] of Object.entries({cx:p.x,cy:p.y,r:n.pinned?11:8,fill:p.color}))c.setAttribute(k,v);const t=document.createElementNS(svg.namespaceURI,'text');t.setAttribute('x',p.x);t.setAttribute('y',p.y+27);t.setAttribute('text-anchor','middle');t.textContent=n.title.length>26?n.title.slice(0,24)+'…':n.title;g.append(c,t);svg.append(g);}
  $('#graph').replaceChildren(svg);$('#graph-legend').textContent=`${graph.nodes.length} notes · ${graph.edges.length} links · Folders group related notes. Journals are hidden.`;
}
async function status(){const engine=$('#chat-engine').value,s=await api('/api/status');if($('#chat-engine').value!==engine)return;$('#status-vault').textContent=s.recall==='hybrid'?'Semantic memory active':'Markdown memory';if(engine==='chatgpt'){const c=await api('/api/chatgpt');if($('#chat-engine').value!==engine)return;const ready=!!c.connected&&!!c.account?.model;$('#model-label').textContent=ready?`${c.account.model} · ChatGPT`:c.reconnectRequired?'ChatGPT unavailable · choose Local':'Connect ChatGPT in Settings';$('#model-dot').classList.toggle('offline',!ready);$('#model-label').title='Selected messages and relevant Aurora context are sent to ChatGPT.';$('#chat-engine-note').textContent=ready?cloudPrivacyNote:cloudUnavailableNote(c);return;}const ready=s.online&&s.models.some(m=>m.name===s.model);$('#model-label').textContent=ready?`${s.model} · local`:s.online?'Model not installed':'Model offline';$('#model-dot').classList.toggle('offline',!ready);$('#model-label').title=s.error||'Responses run on this laptop.';}

document.addEventListener('click',safe(async event=>{
  const el=event.target.closest('[data-view],[data-conversation],[data-note],[data-prompt],[data-wiki],[data-proposal],[data-version],[data-project],[data-open-workflow],[data-planner-attention]');if(!el)return;
  if(el.tagName==='A')event.preventDefault();
  if(el.dataset.project){const ref=await api(`/api/project-file?project=${encodeURIComponent(el.dataset.project)}&path=${encodeURIComponent(el.dataset.file)}`);$('#reference-title').textContent=`${ref.project} / ${ref.path}`;$('#reference-content').textContent=ref.content;$('#reference-dialog').showModal();}
  if(el.dataset.view)await setView(el.dataset.view);
  if(el.dataset.plannerAttention){el.disabled=true;try{await setView('overview');await planner.openAttention(el.dataset.plannerAttention);}finally{el.disabled=false;}}
  if(el.dataset.openWorkflow){await setView('workflows');await workflowUI.open(el.dataset.openWorkflow);}
  if(el.dataset.conversation)await loadConversation(el.dataset.conversation);
  if(el.dataset.note){const fromSidebar=!!el.closest('#sidebar');await openNote(el.dataset.note);if(fromSidebar){document.body.classList.remove('menu-open');$('#menu').setAttribute('aria-expanded','false');}}
  if(el.dataset.prompt){$('#message').value=el.dataset.prompt;$('#message').focus();}
  if(el.dataset.wiki){event.preventDefault();const link=el.dataset.wiki.replace(/\.md$/,'');const matches=state.notes.filter(n=>n.path.slice(0,-3)===link||n.title===link||n.path.split('/').at(-1).slice(0,-3)===link||n.aliases?.includes(link));if(matches.length===1)await openNote(matches[0].path);else toast(matches.length?'More than one note matches that link. Use its folder path.':'That linked note does not exist yet.');}
  if(el.dataset.proposal){el.disabled=true;try{const allowConflicts=!!document.querySelector('[data-task-overlaps="'+el.dataset.proposal+'"]')?.checked;const result=await api('/api/proposal',{id:el.dataset.proposal,action:el.dataset.action,allowConflicts});toast(result.status==='accepted'?'Saved to your vault.':'Suggestion dismissed.');await refresh();}finally{el.disabled=false;}}
  if(el.dataset.version){const v=await api(`/api/version?path=${encodeURIComponent(state.note.path)}&id=${encodeURIComponent(el.dataset.version)}`);if(!confirmDiscard())return;$('#note-content').value=v.content;markDirty();noteMode(true);$('#note-error').textContent='Previewing a previous version. Choose Save note to restore it, or Reload from disk to cancel.';}
}));
document.addEventListener('keydown',event=>{if(event.target.matches('.node')&&['Enter',' '].includes(event.key)){event.preventDefault();event.target.dispatchEvent(new MouseEvent('click',{bubbles:true}));}if(event.key==='Escape'){document.body.classList.remove('menu-open');$('#menu').setAttribute('aria-expanded','false');}if(event.key==='n'&&!event.ctrlKey&&!event.metaKey&&!event.target.closest('input,textarea,select,dialog'))safe(newConversation)();});
$('#new-chat').onclick=safe(newConversation);
$('#close-reference').onclick=()=>$('#reference-dialog').close();
$('#composer').onsubmit=safe(async e=>{e.preventDefault();await send($('#message').value);});
$('#message').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#composer').requestSubmit();}};
$('#stop').onclick=()=>{state.controller?.abort();stopSpeech();};
$('#remember').onclick=()=>{$('#capture-dialog').showModal();$('#capture-text').focus();};$('#close-capture').onclick=()=>$('#capture-dialog').close();
$('#capture-form').onsubmit=safe(async e=>{e.preventDefault();await api('/api/remember',{title:$('#capture-title').value,text:$('#capture-text').value});$('#capture-dialog').close();$('#capture-form').reset();toast('Remembered. It will be available in future conversations.');await refresh();});
let searchSequence=0,searchTimer;
$('#note-search').oninput=()=>{const seq=++searchSequence;clearTimeout(searchTimer);const query=$('#note-search').value;if(!query){state.searchPaths=null;renderNotes();return;}searchTimer=setTimeout(async()=>{try{const matches=await api(`/api/notes?q=${encodeURIComponent(query)}`);if(seq!==searchSequence)return;state.searchPaths=new Set(matches.map(n=>n.path));renderNotes();}catch(e){toast(e.message);}},180);};$('#note-filter').onchange=renderNotes;$('#new-note').onclick=createNote;
$('#note-content').oninput=markDirty;$('#note-path').oninput=markDirty;
$('#close-note').onclick=closeNote;
$('#preview-note').onclick=()=>noteMode(false);$('#edit-note').onclick=()=>{noteMode(true);$('#note-content').focus();};
$('#note-form').onsubmit=async e=>{e.preventDefault();$('#save-note').disabled=true;try{const n=await api('/api/note',{path:$('#note-path').value,content:$('#note-content').value,revision:state.note?.revision??null});state.note=n;clearDraft();$('#note-heading').textContent=n.title;$('#note-location').textContent=n.path;$('#note-path').readOnly=true;$('#note-path-label').hidden=true;$('#trash-note').hidden=false;$('#reload-note').hidden=false;$('#note-error').textContent='';toast('Note saved. Memory is up to date.');await refresh();}catch(error){$('#note-error').textContent=error.message;}finally{$('#save-note').disabled=false;}};
$('#reload-note').onclick=safe(()=>openNote(state.note.path));
$('#trash-note').onclick=safe(async()=>{if(!confirm(`Move “${state.note.title}” to local trash? It will no longer be used as memory.`))return;await api('/api/trash',{path:state.note.path,revision:state.note.revision});clearDraft();closeNote();toast('Moved to local trash.');await refresh();});
$('#today').onclick=safe(async()=>{const note=await api('/api/daily',{});await refresh();await openNote(note.path);});
$('#task-form').onsubmit=safe(async e=>{e.preventDefault();await api('/api/tasks',{text:$('#task-input').value,...planner.newSchedule()});$('#task-input').value='';planner.clearNew();await refresh();});
$('#task-list').onchange=safe(async e=>{const el=e.target;if(!el.dataset.task)return;el.disabled=true;try{await api('/api/task-toggle',{path:el.dataset.task,line:Number(el.dataset.line),revision:el.dataset.revision,done:el.checked});}finally{await refresh();}});
$('#close-settings').onclick=()=>$('#settings-dialog').close();
window.addEventListener('beforeunload',e=>{if(state.dirty||state.generating){e.preventDefault();e.returnValue='';}});
window.addEventListener('focus',()=>{if(!state.generating)refresh().catch(()=>{});});

setInterval(()=>{if(!document.hidden){syncTheme().catch(()=>{});status().catch(()=>{});if(!state.generating)refresh().catch(()=>{});}},15000);

function icon(name){return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;}
function renderWorkspace(){
  const open=new Set(JSON.parse(localStorage.getItem('aster-folders')||'["10 Profile","20 Projects"]'));
  const folders=[...new Set(['00 Home','10 Profile','20 Projects','30 Knowledge','40 Tasks','50 Daily','60 Inbox','90 Journal',...state.notes.map(n=>n.path.split('/')[0])])].sort();
  $('#file-tree').innerHTML=folders.map(folder=>{const notes=state.notes.filter(n=>n.path.startsWith(folder+'/'));return `<details class="tree-folder" data-folder="${escape(folder)}" ${open.has(folder)?'open':''}><summary>${icon('folder')}<span>${escape(folder.replace(/^\d+ /,''))}</span><small>${notes.length||''}</small></summary>${notes.map(n=>`<button class="tree-file ${state.note?.path===n.path?'selected':''}" data-note="${escape(n.path)}" title="${escape(n.path)}">${icon('file')}<span>${escape(n.title)}</span></button>`).join('')}</details>`;}).join('');
  const item=(n,pinned=false)=>`<button class="context-note ${pinned?'pinned':''}" data-note="${escape(n.path)}">${icon(pinned?'spark':'file')}<span><strong>${escape(n.title)}</strong><small>${escape(pinned?n.preview.replace(/[#*\[\]]/g,'').slice(0,90):n.path.split('/')[0].replace(/^\d+ /,''))}</small></span></button>`;
  $('#pinned-notes').innerHTML=state.notes.filter(n=>n.pinned&&n.status!=='journal').map(n=>item(n,true)).join('')||'<p class="context-empty">Pin a profile note to keep it close.</p>';
  $('#recent-notes').innerHTML=state.notes.filter(n=>!n.pinned&&!['journal','archived'].includes(n.status)&&!n.path.startsWith('00 Home/')).slice(0,5).map(n=>item(n)).join('')||'<p class="context-empty">Your saved notes will appear here.</p>';
  const tasks=state.tasks.filter(t=>!t.done);$('#context-tasks').innerHTML=tasks.slice(0,4).map(t=>`<div class="context-task">${escape(t.text)}</div>`).join('')||'<p class="context-empty">Nothing pending. A little breathing room.</p>';
  $('#conversation-count').textContent=state.conversations.filter(c=>c.count).length||'';
  if(!state.conversations.length)$('#conversations').innerHTML='<div class="empty-conversations">Your conversations will be here when you need them.</div>';
}
function toggleContext(){const visible=window.innerWidth<=860?document.body.classList.contains('context-open')&&!document.body.classList.contains('context-closed'):!document.body.classList.contains('context-closed');if(visible){document.body.classList.add('context-closed');document.body.classList.remove('context-open');localStorage.setItem('aster-context','closed');}else showContext();}
function toggleSidebar(){if(window.innerWidth<=640||(window.innerWidth<=1100&&state.view!=='chat')){const open=document.body.classList.toggle('menu-open');$('#menu').setAttribute('aria-expanded',String(open));}else{document.body.classList.toggle('sidebar-closed');localStorage.setItem('aster-sidebar',document.body.classList.contains('sidebar-closed')?'closed':'open');$('#menu').setAttribute('aria-expanded',String(!document.body.classList.contains('sidebar-closed')));}}
$('#menu').onclick=toggleSidebar;$('#collapse-sidebar').onclick=toggleSidebar;$('#toggle-context').onclick=toggleContext;$('#close-context').onclick=toggleContext;
$('#tree-new-note').onclick=createNote;$('#context-new-note').onclick=createNote;
$('#quick-search').onclick=safe(async()=>{await setView('memory');$('#note-search').focus();});
$('#file-tree').addEventListener('toggle',event=>{if(event.target.matches('.tree-folder'))localStorage.setItem('aster-folders',JSON.stringify([...$('#file-tree').querySelectorAll('details[open]')].map(d=>d.dataset.folder)));},true);
$('#open-vault').onclick=safe(async()=>{if(window.asterDesktop)await window.asterDesktop.openVault();else{$('#settings').click();}});
$('#message').addEventListener('input',()=>localStorage.setItem('aster-composer',$('#message').value));
async function syncTheme(){const theme=await api('/api/theme');$('#theme-label').textContent=theme.name;if($('#linux-theme').dataset.revision!==theme.revision){$('#linux-theme').href=`/theme.css?v=${theme.revision}`;$('#linux-theme').dataset.revision=theme.revision;}}
async function restoreWorkspace(){
  if(localStorage.getItem('aster-context')==='closed')document.body.classList.add('context-closed');
  if(localStorage.getItem('aster-sidebar')==='closed')document.body.classList.add('sidebar-closed');
  for(const [key,min,max] of [['sidebar',170,380],['context',265,600]]){const value=Number(localStorage.getItem('aster-'+key+'-width'));if(value>=min&&value<=max)document.documentElement.style.setProperty('--'+key+'-width',value+'px');}
  $('#message').value=localStorage.getItem('aster-composer')||'';const engine=localStorage.getItem('aster-chat-engine');if(['local','chatgpt'].includes(engine))$('#chat-engine').value=engine;$('#chat-engine').onchange();
  try{const draft=JSON.parse(localStorage.getItem('aster-note-draft')||'null');if(draft&&typeof draft.path==='string'&&typeof draft.content==='string'){
    if(draft.revision!==null){await openNote(draft.path);state.note.revision=draft.revision;}else createNote();
    $('#note-path').value=draft.path;$('#note-content').value=draft.content;markDirty();noteMode(true);toast('Recovered your unsaved note draft.');
  }}catch{}
}
for(const [key,min,max] of [['sidebar',170,380],['context',265,600]]){
  const handle=$('#'+key+'-resizer');
  const width=()=>$('#'+(key==='sidebar'?'sidebar':'context-panel')).getBoundingClientRect().width;
  const update=value=>{const next=Math.min(max,Math.max(min,value));document.documentElement.style.setProperty('--'+key+'-width',next+'px');localStorage.setItem('aster-'+key+'-width',next);handle.setAttribute('aria-valuenow',next);};
  handle.setAttribute('aria-valuemin',min);handle.setAttribute('aria-valuemax',max);
  handle.onpointerdown=event=>{const start=event.clientX,initial=width();handle.setPointerCapture(event.pointerId);document.body.classList.add('resizing');handle.onpointermove=e=>update(initial+(e.clientX-start)*(key==='sidebar'?1:-1));handle.onpointerup=()=>{handle.onpointermove=null;document.body.classList.remove('resizing');};};
  handle.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();update(width()+(event.key==='ArrowRight'?16:-16)*(key==='sidebar'?1:-1));}};
}
function desktopCommand(command){if(command?.type==='workspace'){if(command.taskId){safe(async()=>{let restore;try{restore=await captureTask.prepareNavigation();const ok=await dayPlanner.openCaptured({taskId:command.taskId,type:command.taskView},()=>setView('overview'));if(!ok)restore();await window.asterDesktop.workspaceResult(command.navigationId,{ok});}catch(e){restore?.();await window.asterDesktop.workspaceResult(command.navigationId,{ok:false,error:e.message});}})();return;}safe(async()=>{if(command.conversation)await loadConversation(command.conversation);await setView(command.view||'chat');if(command.workflow)await workflowUI.open(command.workflow);})();return;}if(command==='new-chat')safe(newConversation)();if(command==='save-note'&&!$('#note-dialog').hidden)$('#note-form').requestSubmit();if(command==='search')$('#quick-search').click();if(command==='toggle-context')toggleContext();}
if(window.asterDesktop){document.body.classList.add('desktop');$('#window-controls').hidden=false;window.asterDesktop.onCommand(desktopCommand);document.querySelectorAll('[data-window]').forEach(el=>el.onclick=()=>window.asterDesktop.window(el.dataset.window));}
document.addEventListener('keydown',event=>{if(window.asterDesktop||!(event.ctrlKey||event.metaKey))return;const key=event.key.toLowerCase();if(key==='n'||key==='s'||key==='k'||(key==='m'&&event.shiftKey)){event.preventDefault();desktopCommand(key==='n'?'new-chat':key==='s'?'save-note':key==='k'?'search':'toggle-context');}});

const dayPlanner=dayPlanning({api,escape,toast,refresh,beforeNavigate:()=>planner.flushEditor(),openTaskList:()=>planner.openTaskList(),openTaskSchedule:id=>planner.openTaskSchedule(id),openContinueDay:async()=>{await setView('overview');if(!planner.restoreContinue()){$('#continue-day-title').focus({preventScroll:true});$('#continue-day-workspace').scrollIntoView({block:'start'});}},openAttention:async id=>{await setView('overview');await planner.openAttention(id);},openExecution:async id=>{await setView('overview');await planner.openExecution(id);}});
const captureTask=taskCapture({api,escape,onSaved:refresh,onOpenTask:route=>dayPlanner.openCaptured(route)});
const captureButton=document.createElement('button');captureButton.id='day-task-capture';captureButton.textContent='Add a task';captureButton.onclick=safe(()=>captureTask.open());$('#day-primary-actions').append(captureButton);
const planner=planning({api,escape,toast,state,refresh,setView,send,openCapture:options=>captureTask.open(options),navigateDay:route=>dayPlanner.navigate(route),openWorkflow:async(id,focus)=>{await setView('workflows');await workflowUI.open(id,focus);},prepareFollowup:async id=>{await setView('workflows');await workflowUI.prepareFollowup(id);},editRequirements:(...args)=>workflowUI.editRequirements(...args),serializeRequirements:value=>workflowUI.serializeRequirements(value)});
const reviewer=memoryReview({api,escape,toast,state});
const agentUI=agentsWorkspace({api,escape,toast,setView});
const workflowUI=workflowsWorkspace({api,escape,toast,state,reviewAction:id=>features.openReview(id),refreshSkills:()=>agentUI.loadSkills()});
const projectUI=projectsWorkspace({api,escape,toast,state,newTask:async(id,handoff)=>{await setView('workflows');await workflowUI.prepareProject(id,handoff);}});
const features=integrations({api,escape,toast,state,setView,loadConversation,send});
try{state.bootstrap=await api('/api/bootstrap');await refresh();await status();const previous=localStorage.getItem('aster-conversation');if(previous&&state.conversations.some(c=>c.id===previous))await loadConversation(previous);else renderConversation();await restoreWorkspace();await syncTheme();await features.refresh();await agentUI.loadSkills();document.body.dataset.ready='true';}catch(e){toast(e.message);}

speechControls($('#chat-speech'),toast);
