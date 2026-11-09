export function createOutcomePicker({api,escape,toast}){
  let active;
  return async function open({kind,source,context,onSelect}){
    active?.();
    const view=document.querySelector('#workflows-view'),parentDialog=source.closest('dialog'),before=context();
    const dialog=document.createElement('dialog');dialog.id='outcome-picker-dialog';dialog.className='outcome-picker-dialog';dialog.setAttribute('aria-labelledby','outcome-picker-title');
    dialog.innerHTML=`<h3 id="outcome-picker-title">${kind==='browser'?'Use the current browser page':'Choose an app or document window'}</h3><p>Review the observed values. Copying adds them to this form; it does not save the task or approve an action. You can edit the fields before preparing the plan.</p><section data-picker-targets></section><p data-picker-status role="status" aria-live="polite"></p><div class="action-buttons"><button type="button" data-picker-refresh>Refresh preview</button><button type="button" data-picker-use disabled>Copy to form</button><button type="button" data-picker-cancel>Cancel</button></div>`;
    document.body.append(dialog);let closed=false,serial=0,preview;
    const find=s=>dialog.querySelector(s),status=find('[data-picker-status]'),use=find('[data-picker-use]'),refresh=find('[data-picker-refresh]');
    const valid=()=>!closed&&source.isConnected&&!view.hidden&&(!parentDialog||parentDialog.open)&&context()===before;
    const close=()=>{if(closed)return;closed=true;serial++;observer.disconnect();document.removeEventListener('input',outsideChange,true);document.removeEventListener('change',outsideChange,true);dialog.close();dialog.remove();if(active===close)active=null;};
    const changed=()=>{if(!closed&&!valid()){close();toast('The task form changed. Open a new preview.');}};
    const outsideChange=e=>{if(!dialog.contains(e.target))changed();};
    const observer=new MutationObserver(changed);observer.observe(view,{attributes:true,childList:true,subtree:true});if(parentDialog)observer.observe(parentDialog,{attributes:true});
    document.addEventListener('input',outsideChange,true);document.addEventListener('change',outsideChange,true);active=close;
    const controls=busy=>{refresh.disabled=busy;use.disabled=busy||!preview?.targets.length;for(const input of dialog.querySelectorAll('input'))input.disabled=busy;};
    const selection=()=>({target:find('input[name=outcome-target]:checked')?.value,includeTitle:!!find('[data-picker-title]')?.checked,includeApp:!!find('[data-picker-app]')?.checked});
    const load=async()=>{
      const ticket=++serial;preview=null;controls(true);status.textContent='Reading current desktop labels…';find('[data-picker-targets]').replaceChildren();
      try{
        const next=await api('/api/workflow-outcome-preview',{kind});if(ticket!==serial||!valid()){changed();return;}preview=next;
        find('[data-picker-targets]').innerHTML=kind==='browser'?next.targets.map(t=>`<label class="check-row"><input type="radio" name="outcome-target" value="${escape(t.key)}" checked>Current page</label><p>Exact URL: <code>${escape(t.url)}</code></p><p>Observed title: <code>${escape(t.title||'(empty title)')}</code></p>${t.title?'<label class="check-row"><input type="checkbox" data-picker-title checked>Also require this exact title</label><p class="panel-help">Leave this unchecked if the page title changes regularly.</p>':''}`).join(''):
          `${next.targets.map(t=>`<label class="picker-window"><input type="radio" name="outcome-target" value="${escape(t.key)}"><span><strong>${escape(t.title)}</strong><br>${escape(t.app||'(no app identifier)')} · <code>${escape(t.key)}</code></span></label>`).join('')}${next.targets.length?'<label class="check-row"><input type="checkbox" data-picker-app checked>Also require the same app identifier</label><p class="panel-help">Window labels do not prove document contents. Add a file requirement for the saved document.</p>':'<p>No eligible app windows are visible. Open the intended document, then refresh.</p>'}${next.omitted?'<p class="panel-help">Some windows cannot provide a complete, supported title and identity within the current list. Choose another window or use file requirements.</p>':''}`;
        status.textContent='Preview expires after two minutes. The selected target will be checked again when you copy it.';
      }catch(e){if(ticket===serial&&valid()){status.textContent=e.message;preview=null;}}
      finally{if(ticket===serial&&!closed){controls(false);use.disabled=!selection().target;}}
    };
    refresh.onclick=load;find('[data-picker-cancel]').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('close',close);
    dialog.addEventListener('change',()=>{use.disabled=!preview||!selection().target;});
    use.onclick=async()=>{
      if(!preview||!valid()){changed();return;}const chosen=selection();if(!chosen.target)return;
      const ticket=++serial,id=preview.id;controls(true);status.textContent='Checking that your selection is still current…';
      try{
        const result=await api('/api/workflow-outcome-select',{id,...chosen});
        if(ticket!==serial||!valid()){changed();return;}
        if(JSON.stringify(chosen)!==JSON.stringify(selection()))throw new Error('Your selection changed. Refresh and review it again.');
        close();onSelect(result.requirement);toast('Copied to the requirements form. Review it before saving the task.');
      }catch(e){if(ticket===serial&&valid()){preview=null;status.textContent=e.message;}}
      finally{if(ticket===serial&&!closed)controls(false);}
    };
    dialog.showModal();await load();
  };
}
