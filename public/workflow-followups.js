export function followupsUI({api,escape,toast,requirements,openWorkflow}){
 const dialog=document.createElement('dialog');dialog.id='workflow-followup-dialog';dialog.className='workflow-followup-dialog';dialog.setAttribute('aria-label','Review follow-up task');document.body.append(dialog);
 let sourceId=null,generation=0,busy=false,dirty=false;
 const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const message=node('p');message.setAttribute('role','status');const body=node('div'),close=node('button','Close');close.type='button';
 dialog.append(node('h2','Follow up on selected results'),message,body,close);
 const dismiss=()=>{if(dirty&&!confirm('Discard unsaved follow-up edits? The saved draft remains available.'))return;generation++;dirty=false;dialog.close();};close.onclick=dismiss;dialog.oncancel=e=>{e.preventDefault();dismiss();};
 const valid=ticket=>ticket===generation&&dialog.open&&!document.querySelector('#workflows-view').hidden;
 const run=fn=>async()=>{if(busy)return;busy=true;dialog.setAttribute('aria-busy','true');const ticket=generation;body.querySelectorAll('fieldset').forEach(n=>n.disabled=true);try{await fn(ticket);}catch(e){if(valid(ticket))message.textContent=e.message;}finally{busy=false;dialog.removeAttribute('aria-busy');body.querySelectorAll('fieldset').forEach(n=>n.disabled=false);}};
 const button=(text,fn)=>{const b=node('button',text);b.type='button';b.onclick=run(fn);return b;};
 new MutationObserver(records=>{if(records.some(r=>r.oldValue===null)){generation++;dirty=false;dialog.close();}}).observe(document.querySelector('#workflows-view'),{attributes:true,attributeFilter:['hidden'],attributeOldValue:true});
 function editor(d){
  dirty=false;body.replaceChildren();message.textContent=d.status==='creating'?'A previous attempt may have created the task. Retry with the same inputs to locate it.':'';
  if(d.status==='created'){
   body.append(node('p','This draft already created a follow-up task.'),button('Open follow-up task',async()=>{dismiss();await openWorkflow(d.childId);}));return;
  }
  const initial=d.status==='creating'&&d.request?d.request:d,fields=node('fieldset'),goal=node('textarea'),scope=node('textarea'),value=structuredClone(initial.requirements),rules=node('div');
  goal.value=initial.goal;goal.rows=5;goal.maxLength=6000;goal.setAttribute('aria-label','Follow-up goal');scope.value=initial.scope;scope.rows=2;scope.maxLength=2000;scope.setAttribute('aria-label','Follow-up workspace');
  const label=(text,input)=>{const l=node('label',text);l.append(input);return l;};
  fields.append(label('New goal · include answers to selected questions',goal),label('Current workspace or app context',scope));
  const history=node('details');history.open=true;history.append(node('summary','Historical context carried forward'),node('p',d.context.notice));
  for(const item of d.context.selected)history.append(node('p',item.kind+': '+item.label+' — '+item.detail));
  history.append(node('h4','Completed work to preserve'));
  for(const s of d.context.completed)history.append(node('p',s.title+' · '+s.assessment));
  if(!d.context.completed.length)history.append(node('p','No completed steps recorded.'));
  for(const e of d.context.effects)history.append(node('p','Recorded effect: '+e.name+' · '+e.status+(e.path?' · '+e.path:'')+(e.url?' · '+e.url:'')+' · inspect before changing it.'));
  if(d.context.omittedCompleted||d.context.omittedEffects)history.append(node('p','Some older history is omitted here. Open the source task for its full journal.'));
  fields.append(history,node('h4','Checks for the new task · review and edit'),rules);
  const acknowledged=node('input');acknowledged.type='checkbox';acknowledged.setAttribute('aria-label','Review historical follow-up context');
  requirements.editor(rules,value,()=>{dirty=true;acknowledged.checked=false;},true,false);
  fields.append(label('I reviewed these inputs. Current state must be inspected; previous approvals and results do not carry over.',acknowledged));
  fields.addEventListener('input',e=>{dirty=true;if(e.target!==acknowledged)acknowledged.checked=false;});
  const input=()=>({id:d.id,revision:d.revision,goal:goal.value,scope:scope.value,requirements:requirements.serialize(value)});
  fields.append(button('Save follow-up draft',async ticket=>{const saved=await api('/api/workflow-followup-save',input());if(valid(ticket)){editor(saved);message.textContent='Draft saved. No task started.';}}),
   button('Prepare follow-up plan',async ticket=>{if(!acknowledged.checked)throw Error('Review the context and check the acknowledgement first.');const w=await api('/api/workflow-followup-start',{...input(),acknowledge:true});if(valid(ticket)){dirty=false;generation++;dialog.close();await openWorkflow(w.id);toast('Follow-up created. Review its new plan before execution.');}}),
   button('Discard saved draft',async ticket=>{await api('/api/workflow-followup-discard',{id:d.id,revision:d.revision});if(valid(ticket)){dirty=false;await choices(ticket);}}));
  body.append(fields,node('p','Save edits before closing. Preparing a plan creates a separate task; no old actions are replayed.'));
 }
 async function choices(ticket){
  const results=await Promise.allSettled([api('/api/workflow-followup-options?id='+encodeURIComponent(sourceId)),api('/api/workflow-followups?sourceId='+encodeURIComponent(sourceId))]);
  if(!valid(ticket))return;body.replaceChildren();dirty=false;message.textContent='';
  const [options,saved]=results;
  if(options.status==='fulfilled'){
   const data=options.value,fields=node('fieldset'),selected=new Set();fields.append(node('p',data.notice),node('p','Select only the unfinished outcomes for the next task. Copied checks will be shown for review.'));
   for(const item of data.items){const label=node('label'),box=node('input');box.type='checkbox';box.dataset.followupItem=item.id;box.onchange=()=>box.checked?selected.add(item.id):selected.delete(item.id);label.append(box,node('span',item.kind+' · '+item.label+' — '+item.detail));fields.append(label);}
   if(!data.items.length)fields.append(node('p','No unfinished items were found. Use the new task form for a different goal.'));
   fields.append(button('Preview selected follow-up',async t=>{if(!selected.size)throw Error('Select at least one unfinished item.');const d=await api('/api/workflow-followup-preview',{sourceId,sourceFingerprint:data.fingerprint,selected:[...selected]});if(valid(t))editor(d);}));body.append(fields);
  }else message.textContent=options.reason.message;
  if(saved.status==='fulfilled'&&saved.value.length){body.append(node('h3','Saved follow-ups'));for(const d of saved.value){const row=node('article');row.append(node('p',d.goal),button(d.status==='created'?'Open follow-up task':'Reopen saved draft',async t=>{if(d.status==='created'){generation++;dialog.close();await openWorkflow(d.childId);}else{const current=await api('/api/workflow-followup?id='+encodeURIComponent(d.id));if(valid(t))editor(current);}}));body.append(row);}}
  else if(saved.status==='rejected')message.textContent=saved.reason.message;
 }
 const open=id=>run(async ticket=>{sourceId=id;dirty=false;body.replaceChildren();message.textContent='Loading saved results…';dialog.showModal();await choices(ticket);})();
 function render(w,panel){
  const b=button('Prepare follow-up from results',()=>open(w.id));
  // open() owns its request guard, so do not nest it inside another guarded call.
  b.onclick=()=>open(w.id);b.dataset.followupOpen=w.id;panel.append(b);
  if(w.followUp){const origin=node('p');origin.className='panel-help';origin.append(node('span','Follow-up task · historical context from '),button('Open source task',()=>openWorkflow(w.followUp.sourceId)));panel.prepend(origin);}
 }
 return {open,render,selection:id=>{if(dialog.open&&sourceId!==id){generation++;dirty=false;dialog.close();}}};
}
