const valid=d=>d&&d.version===1&&typeof d.date==='string'&&typeof d.body==='string'&&typeof d.sourceRevision==='string'&&typeof d.sourceText==='string'&&(d.targetRevision===null||typeof d.targetRevision==='string')&&(d.targetContent===null||typeof d.targetContent==='string')&&(!d.pending||typeof d.pending.requestId==='string'&&d.pending.date===d.date&&d.pending.body===d.body&&d.pending.sourceRevision===d.sourceRevision&&d.pending.targetRevision===d.targetRevision);
export function createSessionSummary({api:rawApi,escape,body,open,run,period}){
 const api=(path,data)=>rawApi(path.replace('/api/session-summary','/api/session-summary/'+period),data),heading=(period==='day'?'Daily':'Weekly')+' session summary';
 let keyPromise;
 const keyFor=async date=>{keyPromise??=api('/api/bootstrap').then(b=>'aurora-session-summary:'+b.vault+':'+period+':').catch(e=>{keyPromise=null;throw e;});return await keyPromise+date;};
 const put=(key,d)=>{try{localStorage.setItem(key,JSON.stringify(d));}catch{throw Error('This summary draft could not be stored on this desktop. Copy your text before closing; no save was requested.');}};
 const read=(key,date)=>{const raw=localStorage.getItem(key);if(raw===null)return null;let d;try{d=JSON.parse(raw);}catch{}if(!valid(d)||d.date!==date)throw Error('This saved summary draft cannot be read. Copy any recoverable text, then explicitly discard it before starting again.');return d;};
 const $=s=>body.querySelector(s),back=date=>'<button data-session-review="'+period+'" data-session-date="'+escape(date)+'">Back to session review</button>';
 const pre=text=>'<pre class="summary-prose">'+escape(text||'No saved note.')+'</pre>';
 const matches=(key,id)=>{try{const d=JSON.parse(localStorage.getItem(key));return valid(d)&&d.pending?.requestId===id;}catch{return false;}};
 async function saved(r,key){
  if(matches(key,r.id))localStorage.removeItem(key);
  body.innerHTML='<h2>'+heading+' saved · '+escape(r.date)+'</h2><p>The reviewed version was saved as a journal note. Any later edits to that note are kept.</p><p>'+escape(r.path)+'</p><button data-briefing-note data-note="'+escape(r.path)+'">Open saved note</button><button data-session-summary-period="'+period+'" data-session-summary="'+escape(r.date)+'">Edit session summary</button>'+back(r.date);open();
 }
 async function pending(d,key,r){
  const independent=localStorage.getItem(key)!==null&&!matches(key,r?.id||d.pending.requestId);
  body.innerHTML='<h2>Review '+heading.toLowerCase()+' · '+escape(d.date)+'</h2><p>'+escape(r?.path||'Recovering the exact saved review')+'</p><p>This saves a journal note. It does not change tasks, check-ins or confirmed personal memory.</p>'+(r?'<details><summary>Previously saved note</summary>'+pre(r.before)+'</details><h3>Reviewed summary</h3>'+pre(r.body)+'<details><summary>Markdown file and metadata</summary>'+pre(r.content)+'</details>':'<p>A preview reply was not confirmed. Retry the exact request or check its status before returning to editing.</p>'+pre(d.pending.body))+'<button id="session-summary-save" class="primary">'+(r?'Save reviewed summary':'Recover preview')+'</button><button id="session-summary-edit">Return to editing</button>'+back(d.date);open();
  if(independent){$('#session-summary-edit').textContent='Open existing draft';$('#session-summary-edit').insertAdjacentHTML('beforebegin','<p class="planner-warning">A separate draft for this date is kept. Saving or dismissing this review will not replace that draft.</p><button id="session-summary-dismiss-separate">Dismiss this review</button>');$('#session-summary-dismiss-separate').onclick=run(async()=>{const result=await api('/api/session-summary/decide',{id:r.id,action:'dismiss'});if(result.status==='saved')return saved(result,key);await show(d.date);});}
  $('#session-summary-save').onclick=run(async()=>{
   if(!r){const next=await api('/api/session-summary/preview',d.pending);return review(next,d,key);}
   const result=await api('/api/session-summary/decide',{id:r.id,action:'save'});await saved(result,key);
  });
  $('#session-summary-edit').onclick=run(async()=>{
   if(independent)return show(d.date);
   let current=r;if(!current)try{current=await api('/api/session-summary/review?id='+encodeURIComponent(d.pending.requestId));}catch(e){if(!e.message.includes('Record not found'))throw e;}
   if(current){const result=await api('/api/session-summary/decide',{id:current.id,action:'dismiss'});if(result.status==='saved')return saved(result,key);}
   delete d.pending;put(key,d);await show(d.date);
  });
 }
 async function review(r,d,key){if(r.status==='saved')return saved(r,key);if(r.status==='dismissed'){if(localStorage.getItem(key)===null||matches(key,r.id)){delete d.pending;put(key,d);}return show(d.date);}return pending(d,key,r);}
 async function recover(id){const r=await api('/api/session-summary/review?id='+encodeURIComponent(id)),key=await keyFor(r.date),d={...r.draft,pending:{requestId:r.id,date:r.date,body:r.body,sourceRevision:r.draft.sourceRevision,targetRevision:r.draft.targetRevision}};return review(r,d,key);}
 async function show(date){
  const key=await keyFor(date);let d;
  try{d=read(key,date);}catch(e){body.innerHTML='<h2>Session summary draft needs attention</h2><p>'+escape(e.message)+'</p><details><summary>Stored draft text</summary>'+pre(localStorage.getItem(key))+'</details><button id="session-summary-reset">Discard unreadable draft</button>'+back(date);open();$('#session-summary-reset').onclick=run(async()=>{if(!confirm('Discard this unreadable summary draft?'))return;localStorage.removeItem(key);await show(date);});return;}
  if(d?.pending){let r;try{r=await api('/api/session-summary/review?id='+encodeURIComponent(d.pending.requestId));}catch(e){if(!e.message.includes('Record not found'))throw e;}return r?review(r,d,key):pending(d,key,null);}
  const c=await api('/api/session-summary?date='+encodeURIComponent(date));
  d??={version:1,date:c.date,body:c.target?.owned?c.target.body:c.suggested,sourceRevision:c.sourceRevision,sourceText:c.suggested,targetRevision:c.target?.revision||null,targetContent:c.target?.content||null};
  let stale=d.sourceRevision!==c.sourceRevision||d.targetRevision!==(c.target?.revision||null);
  body.innerHTML='<h2>'+heading+' · '+escape(c.date)+'</h2><p>Edit the text, compare its sources, then preview the Markdown before saving. It stays a journal entry, separate from confirmed personal facts.</p><p>'+escape(c.path)+'</p>'+(c.target&&!c.target.owned?'<p class="planner-warning">Another note occupies this path. Open it in Notes and resolve the location before saving a summary.</p>':'')+'<p id="session-summary-status" role="status"></p><p id="session-summary-stale" class="planner-warning" '+(stale?'':'hidden')+'>Sources or the saved note changed. Your wording is kept. Compare the earlier and current material before accepting the current sources.</p><details '+(stale?'open':'')+'><summary>Sources and saved note comparison</summary><h3>Sources used by your draft</h3>'+pre(d.sourceText)+'<h3>Current sources</h3>'+pre(c.suggested)+'<h3>Note when you began</h3>'+pre(d.targetContent)+'<h3>Note now</h3>'+pre(c.target?.content)+'</details><button id="session-summary-current" '+(stale?'':'hidden')+'>Use current sources and saved note with my text</button><label>Summary text <textarea id="session-summary-text" rows="18" maxlength="120000">'+escape(d.body)+'</textarea></label><button id="session-summary-preview" class="primary" '+(stale||c.target&&!c.target.owned?'disabled':'')+'>Preview Markdown save</button><button id="session-summary-reload">Reload sources, keep my text</button><button id="session-summary-reset">Start again from current sources</button>'+back(c.date);open();
  const status=$('#session-summary-status'),capture=()=>{d.body=$('#session-summary-text').value;put(key,d);status.textContent='Draft saved on this desktop. Nothing published yet.';};
  $('#session-summary-text').oninput=()=>{try{capture();}catch(e){status.textContent=e.message;}};
  $('#session-summary-current').onclick=run(async()=>{d.sourceRevision=c.sourceRevision;d.sourceText=c.suggested;d.targetRevision=c.target?.revision||null;d.targetContent=c.target?.content||null;capture();await show(c.date);});
  $('#session-summary-reload').onclick=run(async()=>{capture();await show(c.date);});
  $('#session-summary-reset').onclick=run(async()=>{if(!confirm('Replace this draft text with a fresh summary from current sources? The saved note is kept until a new review is saved.'))return;const fresh=await api('/api/session-summary?date='+encodeURIComponent(c.date));put(key,{version:1,date:c.date,body:fresh.suggested,sourceRevision:fresh.sourceRevision,sourceText:fresh.suggested,targetRevision:fresh.target?.revision||null,targetContent:fresh.target?.content||null});await show(c.date);});
  $('#session-summary-preview').onclick=run(async()=>{
   capture();if(!d.body.trim())throw Error('Write a summary before preparing a review.');
   d.pending={requestId:crypto.randomUUID(),date:d.date,sourceRevision:d.sourceRevision,targetRevision:d.targetRevision,body:d.body};put(key,d);await pending(d,key,null);
   const r=await api('/api/session-summary/preview',d.pending);await review(r,d,key);
  });
 }
 body.addEventListener('click',e=>{const b=e.target.closest('[data-session-summary]');if(b?.dataset.sessionSummaryPeriod===period)run(()=>show(b.dataset.sessionSummary))();});
 return {show,recover};
}
