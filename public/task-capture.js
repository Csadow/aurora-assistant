import {projectNotes} from './task-links.js';
import {taskProposalReview} from './task-proposal-review.js';

export function taskCapture({api,escape,surface='main',onSaved=async()=>{},onOpenTask}){
  const dialog=document.createElement('dialog');dialog.id='task-capture-dialog';dialog.setAttribute('aria-labelledby','task-capture-title');
  dialog.innerHTML=`<header><div><small>YOUR DAY · TASK CAPTURE</small><h2 id="task-capture-title">Make room for what matters</h2></div><button id="task-capture-return" type="button" hidden>Back to Continue my day</button><button id="task-capture-close" type="button">Close</button></header><p class="panel-help">One shared draft in Your day and Quick ask. A deadline is when it’s due; a planned date is when you intend to work on it.</p><p id="task-capture-status" role="status"></p><p id="task-capture-error" class="error" role="alert"></p><section id="task-capture-recovery" hidden><details><summary>View the shared draft before choosing</summary><pre id="task-capture-shared"></pre></details><button id="task-capture-use-shared">Load shared draft and discard local edits</button><button id="task-capture-replace">Replace shared draft with my local edits</button></section><form id="task-capture-form"><div class="task-capture-fields"><label class="task-capture-wide">Task<input id="task-capture-text" name="text" maxlength="600" required placeholder="What do you want to get done?"></label><label class="task-capture-wide">Project<select id="task-capture-project" name="project"><option value="">No project</option></select></label><label>Estimate (minutes)<input id="task-capture-duration" name="duration" type="number" min="5" max="720" step="1" required></label><label>Deadline<input id="task-capture-due" name="due" type="date" min="2000-01-01" max="2199-12-31"></label><label>Planned date<input id="task-capture-planDate" name="planDate" type="date" min="2000-01-01" max="2199-12-31"></label><label>Start time (optional)<input id="task-capture-startTime" name="startTime" type="time"></label></div><p class="panel-help">A date without a start time keeps the day flexible. Timed tasks are checked against classes, other tasks and connected calendars.</p><div class="task-capture-actions"><button id="task-capture-preview" class="primary">Preview task</button><button type="button" id="task-capture-clear">Discard draft</button></div></form><section id="task-capture-review" hidden></section><div id="task-capture-review-actions" class="task-capture-actions" hidden><button id="task-capture-accept" class="primary">Add task</button><button id="task-capture-edit">Edit draft / refresh preview</button><button id="task-capture-new" hidden>Capture another task</button></div>`;
  document.body.append(dialog);const $=s=>dialog.querySelector(s),form=$('#task-capture-form'),status=$('#task-capture-status'),error=$('#task-capture-error');
  let returnTo=null,draft=null,key=null,dirty=false,busy=false,blocked=false,storageBroken=false,timer,saving,notes=[];form.hidden=true;
  const taskLinks=document.createElement('div');taskLinks.className='task-capture-actions';taskLinks.id='task-capture-links';taskLinks.hidden=true;
  taskLinks.innerHTML='<button data-capture-target="task-detail">Open task details</button><button data-capture-target="first-step">Write / reopen first step</button>';
  $('#task-capture-review-actions').after(taskLinks);
  for(const button of taskLinks.querySelectorAll('button'))button.onclick=()=>run(async()=>{
    if(draft?.proposal?.status!=='accepted'||!onOpenTask)throw Error('Open the saved task from Your day.');
    const taskId=draft.proposal.review.after.id;dialog.close();
    try{if(await onOpenTask({taskId,type:button.dataset.captureTarget})!==true)throw Error('The workspace could not open this task. Finish or recover the current editor, then retry.');}
    catch(e){if(!dialog.open)dialog.showModal();throw e;}
  });
  const read=()=>Object.fromEntries(['text','project','duration','due','planDate','startTime'].map(k=>[k,form.elements[k].value]));
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function remember(){try{localStorage.setItem(key,JSON.stringify({version:1,revision:draft.revision,fields:read()}));storageBroken=false;}catch{storageBroken=true;throw Error('Local recovery storage is unavailable. Keep this window open until the shared draft saves.');}}
  function forget(){localStorage.removeItem(key);storageBroken=false;}
  function fill(value){const select=form.elements.project;select.replaceChildren(new Option('No project',''),...projectNotes(notes).map(n=>new Option(n.title||n.path,n.path)));if(value.project&&![...select.options].some(o=>o.value===value.project))select.add(new Option(value.project+' · unavailable',value.project));for(const [k,v]of Object.entries(value))if(form.elements[k])form.elements[k].value=v;}
  function controls(){dialog.setAttribute('aria-busy',String(busy));form.inert=busy||blocked&&storageBroken;$('#task-capture-close').disabled=busy;$('#task-capture-return').disabled=busy;$('#task-capture-preview').disabled=blocked||busy;$('#task-capture-clear').disabled=blocked||busy;$('#task-capture-review-actions').inert=busy;$('#task-capture-recovery').inert=busy;taskLinks.inert=busy;}
  function render(){
    const p=draft.proposal,review=!!draft.proposalId;form.hidden=review;$('#task-capture-review').hidden=!review;$('#task-capture-review-actions').hidden=!review;$('#task-capture-recovery').hidden=!blocked;
    $('#task-capture-accept').hidden=!p||p.status!=='pending';$('#task-capture-edit').hidden=p?.status==='accepted';$('#task-capture-new').hidden=p?.status!=='accepted';
    taskLinks.hidden=p?.status!=='accepted'||!onOpenTask;
    if(review){
      $('#task-capture-review').innerHTML=p?.status==='accepted'?`<h3>Task added</h3><p>${escape(p.title)}</p><p class="panel-help">Saved in ${escape(p.review.path)}. You can find it in Your day → Find a task.</p>`:p?.status==='pending'?taskProposalReview(p,escape,{controls:false,saveStarted:draft.saveStarted}):'<p>This preview is unfinished or was dismissed. Edit the draft to prepare a fresh preview.</p>';
      status.textContent=p?.status==='accepted'?'Saved once. This receipt stays here until you capture another task.':draft.saveStarted?'A save was interrupted. Retry Add task to check the existing task before writing anything again.':'Draft and preview kept on this laptop.';
    }else status.textContent=blocked?'Your local edits are kept. The shared draft has a different version.':dirty?'Saving draft…':'Draft saved on this laptop. Nothing added to your task list yet.';
    controls();
  }
  async function flush(){
    clearTimeout(timer);if(saving)await saving;if(!dirty)return;if(blocked)throw Error('Choose which draft to keep before previewing or closing.');
    saving=(async()=>{
      while(dirty){
        const value=read();let result;
        try{result=await api('/api/task-capture',{action:'save',revision:draft.revision,fields:value});}
        catch(e){
          // Recover an acknowledged-on-disk save whose network reply was lost.
          const current=await api('/api/task-capture').catch(()=>null);
          if(current&&!current.proposalId&&equal(current.fields,value))result=current;
          else{if(current&&(current.revision!==draft.revision||current.proposalId))conflict(current);throw e;}
        }
        draft=result;dirty=!equal(read(),value);if(dirty)remember();else forget();
      }
      status.textContent='Draft saved on this laptop. Nothing added to your task list yet.';error.textContent='';
    })();try{await saving;}finally{saving=null;}
  }
  function conflict(current){blocked=true;$('#task-capture-recovery').hidden=false;$('#task-capture-shared').textContent=['Task: '+current.fields.text,'Project: '+(current.fields.project||'None'),'Estimate: '+current.fields.duration+' minutes','Deadline: '+(current.fields.due||'None'),'Planned: '+(current.fields.planDate||'None')+' '+current.fields.startTime,current.proposalId?'A preview or receipt is open. Finish it before replacing this draft.':''].filter(Boolean).join('\n');$('#task-capture-replace').hidden=!!current.proposalId;status.textContent='Your local edits are kept. The shared draft has a different version.';controls();}
  async function run(fn){if(busy)return;busy=true;error.textContent='';controls();try{await fn();}catch(e){error.textContent=e.message;status.textContent=dirty?'Draft not saved to the shared copy. Your text remains here.':status.textContent;}finally{busy=false;controls();}}
  async function action(action,extra={}){
    try{draft=await api('/api/task-capture',{action,revision:draft.revision,...extra});dirty=false;forget();fill(draft.fields);render();}
    catch(e){const current=await api('/api/task-capture').catch(()=>null);if(current&&equal(current.fields,draft.fields)){draft=current;render();if(action==='accept'&&current.proposal?.status==='accepted')return;}else if(current){conflict(current);if(draft.proposal?.status==='accepted')$('#task-capture-replace').hidden=true;}throw e;}
  }
  form.oninput=()=>{if(blocked&&storageBroken)return;dirty=true;error.textContent='';try{remember();}catch(e){error.textContent=e.message;}status.textContent='Saving draft…';clearTimeout(timer);timer=setTimeout(()=>flush().catch(e=>{error.textContent=e.message;status.textContent='Draft not saved to the shared copy. Your text remains here.';}),250);};
  form.onsubmit=e=>{e.preventDefault();return run(async()=>{await flush();await action('preview');});};
  $('#task-capture-close').onclick=()=>run(async()=>{await flush();if(storageBroken)throw Error('Keep this window open until draft recovery is available.');dialog.close();});
  $('#task-capture-return').onclick=()=>run(async()=>{await flush();if(storageBroken)throw Error('Keep this window open until draft recovery is available.');if(!returnTo)return;dialog.close();try{await returnTo();}catch(e){if(!dialog.open)dialog.showModal();throw e;}});
  dialog.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();$('#task-capture-close').click();}});
  dialog.oncancel=e=>{e.preventDefault();$('#task-capture-close').click();};
  $('#task-capture-clear').onclick=()=>run(async()=>{await flush();if(confirm('Discard this saved task draft?'))await action('clear');});
  $('#task-capture-edit').onclick=()=>run(()=>action('edit'));
  $('#task-capture-new').onclick=()=>run(()=>action('clear'));
  $('#task-capture-accept').onclick=()=>run(async()=>{await action('accept',{allowConflicts:!!$('#task-capture-review [data-task-overlaps]')?.checked});await onSaved();});
  $('#task-capture-use-shared').onclick=()=>run(async()=>{const current=await api('/api/task-capture');forget();draft=current;dirty=false;blocked=false;fill(draft.fields);render();});
  $('#task-capture-replace').onclick=()=>run(async()=>{const current=await api('/api/task-capture');if(current.proposalId){conflict(current);throw Error('The shared draft now has a preview. Review it before replacing its fields.');}draft=current;blocked=false;dirty=true;remember();await flush();render();});
  return {async prepareNavigation(){if(busy)throw Error('Finish the current capture operation before opening another task.');await flush();if(storageBroken)throw Error('Recover the current capture draft before navigating.');const wasOpen=dialog.open;dialog.close();return ()=>{if(wasOpen&&!dialog.open)dialog.showModal();};},async open({onReturn}={}){
    if(dialog.open)return;returnTo=typeof onReturn==='function'?onReturn:null;$('#task-capture-return').hidden=!returnTo;dialog.showModal();await run(async()=>{
      const boot=await api('/api/bootstrap');key='aurora-task-capture:'+boot.vault+':'+surface;
      // An existing dirty editor is retained after a hidden Quick ask window returns.
      if(dirty){await flush();render();return;}
      const current=await api('/api/task-capture');notes=await api('/api/notes');draft=current;blocked=false;fill(draft.fields);
      const raw=localStorage.getItem(key);if(raw){
        let local;try{local=JSON.parse(raw);if(local.version!==1||typeof local.revision!=='string'||!local.fields||Object.keys(local.fields).length!==6||Object.keys(current.fields).some(k=>typeof local.fields[k]!=='string'))throw Error();}
        catch{blocked=true;storageBroken=true;$('#task-capture-recovery').hidden=false;$('#task-capture-replace').hidden=true;$('#task-capture-shared').textContent='The local recovery copy is unreadable and has been preserved. Loading the shared draft discards that damaged local copy.';render();throw Error('Local recovery could not be read. Choose Load shared draft to discard it.');}
        if(equal(local.fields,current.fields)){forget();}
        else{draft={...current,revision:local.revision,proposalId:null,proposal:null};fill(local.fields);dirty=true;if(local.revision!==current.revision||current.proposalId)conflict(current);else await flush();}
      }
      render();if(!form.hidden)form.elements.text.focus();
    });}};
}
