import {guardPlanningDraft} from './planning-draft-guard.js';
const validDate=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T12:00:00Z'))&&new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s;
export function readSelection(storage,key){
 const value=storage.getItem(key);if(value===null)return null;
 let d;try{d=JSON.parse(value);}catch{}
 if(!d||d.version!==1||!validDate(d.date)||typeof d.timezone!=='string'||!Array.isArray(d.rows)||d.rows.some(r=>!r||typeof r.taskId!=='string'||typeof r.contextRevision!=='string'||typeof r.text!=='string'||typeof r.selected!=='boolean')||new Set(d.rows.map(r=>r.taskId)).size!==d.rows.length||typeof d.start!=='string'||typeof d.end!=='string'||!Number.isFinite(d.gap))throw Error('The saved planning selection cannot be read. Reset it explicitly to start a new draft.');
 return d;
}
export function selectionRows(draft,rows,defaultSelected=false){
 const result=rows.map(row=>{
  const saved=draft?.rows.find(r=>r.taskId===row.taskId)||{taskId:row.taskId,text:row.text,contextRevision:row.contextRevision,task:row.task,selected:!draft&&defaultSelected&&!row.issue,...(row.source?{source:row.source}:{})};
  return {saved:{...saved},current:row,stale:saved.selected&&saved.contextRevision!==row.contextRevision};
 });
 for(const saved of draft?.rows||[])if(saved.selected&&!rows.some(r=>r.taskId===saved.taskId))result.push({saved:{...saved},current:null,stale:true});
 return result;
}
const info=(task,escape)=>task?escape(task.planDate||'Unscheduled')+' · '+escape(task.startTime||'No time')+' · '+escape(String(task.duration??'?'))+' min estimate'+(task.done?' · Marked complete':''):'Task unavailable';

export function mountSelection({root,report,storage,key,escape,prefix,attribute,defaultSelected=false,showCompleted=false,loadedDraft,loadError,rowDetails=()=>'',changeMessage='The task or current attempt changed. Compare it before keeping this selection.'}){
 let draft=loadedDraft,failed=loadError||null;
 if(draft===undefined&&!failed)try{draft=readSelection(storage,key);}catch(e){failed=e.message;}
 const entries=selectionRows(draft,report.rows,defaultSelected);let date=draft?.date||report.date,timezone=draft?.timezone||report.timezone;
 root.innerHTML=`<p data-selection-status role="status">${escape(failed|| (draft?'Restored your planning choices. No task changes have been made.':'Choose tasks and hours. Changes to this draft stay on this desktop.'))}</p><p data-selection-date-warning class="planner-warning" hidden></p><button data-selection-date-confirm hidden>Use this date and timezone</button><button data-selection-reset>Reset saved planning choices</button><div data-selection-rows>${entries.filter(e=>showCompleted||!e.current?.task?.done||e.saved.selected).map(e=>{
  const row=e.current,s=e.saved,issue=row?.issue||(!row?'Task no longer available in this view.':null);
  return `<article data-selection-row="${escape(s.taskId)}"><label class="check-row"><input type="checkbox" ${attribute}="${escape(s.taskId)}" ${s.selected?'checked':''} ${issue&&!s.selected?'disabled':''}>${escape(row?.text||s.text)}</label><p>${info(row?.task,escape)}${issue?' · '+escape(issue):''}</p><div data-selection-comparison class="planner-warning" ${e.stale?'':'hidden'}><p>${escape(changeMessage)}</p><p>Saved choice: ${escape(s.text)} · ${info(s.task,escape)}</p></div>${row?.execution?.map(x=>'<p>'+escape(x.detail||x.status||'Linked attempt')+(x.attention?' <button data-planner-attention="'+escape(x.id)+'">Review current decision</button>':'')+'</p>').join('')||''}${rowDetails(row,s,escape)}<button data-selection-confirm ${!e.stale||issue?'hidden':''}>Keep this selection with current details</button></article>`;
 }).join('')||'<p>No tasks available here.</p>'}</div><div class="focus-actions"><label>Start after <input id="${prefix}-start" type="time" value="${escape(draft?.start??'09:00')}"></label><label>Finish by <input id="${prefix}-end" type="time" value="${escape(draft?.end??'18:00')}"></label><label>Break minutes <input id="${prefix}-gap" type="number" min="0" max="120" value="${draft?.gap??10}"></label></div>`;
 const $=s=>root.querySelector(s),status=$('[data-selection-status]');
 const read=()=>({version:1,date,timezone,start:$('#'+prefix+'-start').value,end:$('#'+prefix+'-end').value,gap:Number($('#'+prefix+'-gap').value),rows:entries.map(e=>e.saved),expanded:root.closest('details')?.open??true,...(draft?.pending?{pending:draft.pending}:{})});
 const save=()=>{if(failed)throw Error(failed);const d=read();storage.setItem(key,JSON.stringify(d));draft=d;status.textContent='Planning choices saved on this desktop. No task changes yet.';return d;};
 const host=root.closest('#day-planning-body');if(host&&!failed)guardPlanningDraft(host,root,save);
 const capture=()=>{try{save();}catch(e){status.textContent='Choices could not be saved: '+e.message;}};
 const update=()=>{
  const changed=date!==report.date||timezone!==report.timezone,warning=$('[data-selection-date-warning]');warning.hidden=!changed;warning.textContent='Saved for '+date+' · '+timezone+'. The open view is '+report.date+' · '+report.timezone+'. Review the selections before using the new date.';$('[data-selection-date-confirm]').hidden=!changed;
  for(const e of entries){const row=[...root.querySelectorAll('[data-selection-row]')].find(el=>el.dataset.selectionRow===e.saved.taskId);if(!row)continue;
   e.stale=e.saved.selected&&(!e.current||e.saved.contextRevision!==e.current.contextRevision);row.querySelector('[data-selection-comparison]').hidden=!e.stale;row.querySelector('[data-selection-confirm]').hidden=!e.stale||!e.current||!!e.current.issue;
   const sources=row.querySelector('[data-selection-source-comparison]');if(sources)sources.hidden=!e.stale;
   row.querySelector('input').disabled=!!failed||!!(!e.current||e.current.issue)&&!e.saved.selected;
  }
 };
 for(const el of root.querySelectorAll('[data-selection-row]')){
  const entry=entries.find(e=>e.saved.taskId===el.dataset.selectionRow),box=el.querySelector('input');
  box.onchange=()=>{entry.saved.selected=box.checked;update();capture();};
  el.querySelector('[data-selection-confirm]').onclick=()=>{entry.saved={...entry.saved,text:entry.current.text,task:entry.current.task,contextRevision:entry.current.contextRevision,...(entry.current.source?{source:entry.current.source}:{})};update();capture();};
 }
 for(const suffix of ['start','end','gap'])for(const event of ['input','change'])$('#'+prefix+'-'+suffix).addEventListener(event,capture);
 $('[data-selection-date-confirm]').onclick=()=>{date=report.date;timezone=report.timezone;update();capture();};
 $('[data-selection-reset]').onclick=()=>{if(confirm('Reset these saved planning choices? Tasks and saved previews are kept.')){storage.removeItem(key);root.dispatchEvent(new Event('selection-reset',{bubbles:true}));}};
 if(draft?.expanded&&root.closest('details'))root.closest('details').open=true;
 const details=root.closest('details');if(details)details.addEventListener('toggle',()=>{if(root.isConnected&&root.closest('dialog')?.open)capture();});
 update();
 return {read,save,capture,setPending:input=>{draft={...read(),pending:input};storage.setItem(key,JSON.stringify(draft));},selected:({allowEmpty=false,persist=true}={})=>{
  // Read checkboxes as well as change events (keyboard, automation, restored forms).
  for(const e of entries){const el=[...root.querySelectorAll('[data-selection-row]')].find(el=>el.dataset.selectionRow===e.saved.taskId);if(el)e.saved.selected=el.querySelector('input').checked;}
  update();if(persist)save();
  if(date!==report.date||timezone!==report.timezone)throw Error('Review the saved date and timezone before previewing.');
  const chosen=entries.filter(e=>e.saved.selected);if(!chosen.length&&!allowEmpty)throw Error('Select at least one task to preview.');if(chosen.some(e=>e.stale||!e.current||e.current.issue))throw Error('Compare changed selections or uncheck unavailable tasks before previewing.');
  return chosen.map(e=>({taskId:e.saved.taskId,contextRevision:e.saved.contextRevision}));
 }};
}
