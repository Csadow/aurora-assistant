export function memoryReview({api,escape,toast,state}){
  const $=s=>document.querySelector(s);let report,controller,selection=null;
  const labels={duplicate:'Duplicate notes',similar:'Similar notes',aging:'Worth revisiting','possible-conflict':'Possible contradiction'};
  async function load(){
    report=await api('/api/memory-review');$('#review-summary').textContent=`${report.scanned} of ${report.total} memory notes checked · ${report.findings.length} findings · ${report.reviewed} kept as is${report.limited?' · scan limited to 500 notes':''}`;
    const chosen=selection||new Set(report.notes.slice(0,6).map(n=>n.path));
    $('#review-note-options').innerHTML=report.notes.map(n=>`<label class="review-choice"><input type="checkbox" value="${escape(n.path)}" ${chosen.has(n.path)?'checked':''}><span>${escape(n.title)}<small>${escape(n.path)}</small></span></label>`).join('')||'<p class="panel-help">Save at least two memory notes to compare them.</p>';
    $('#review-findings').innerHTML=report.findings.map(f=>`<article class="review-finding"><span class="review-kind">${escape(labels[f.kind]||f.kind)}</span><h3>${escape(f.reason)}</h3>${f.notes.map(n=>`<div class="review-evidence"><button data-note="${escape(n.path)}">${escape(n.title)} ↗</button><blockquote>${escape(n.quote)}</blockquote><button data-correct-note="${escape(n.path)}">Correct this note</button></div>`).join('')}<p class="panel-help">Open a note to edit it or move it to trash. Original versions remain recoverable.</p><button data-review-keep="${f.id}">Keep as is · reviewed</button></article>`).join('')||'<div class="empty">No open findings from these checks.<br>Use the local AI check to compare the meaning of selected notes.</div>';
    const last=report.lastAnalysis;$('#review-ai-status').textContent=last?`Last local check: ${new Date(last.at).toLocaleString()} · ${last.paths.length} notes${last.limited?' · excerpts only':''}${last.stale?' · notes changed; check again':''}${last.discarded?' · '+last.discarded+' unsupported suggestion(s) discarded':''}`:'The local AI check runs only when you request it. Select 2–8 notes; up to 3,000 characters per note are checked.';
  }
  $('#review-note-options').onchange=()=>selection=new Set([...$('#review-note-options').querySelectorAll('input:checked')].map(i=>i.value));
  $('#review-refresh').onclick=async()=>{try{await load();}catch(e){toast(e.message);}};
  $('#review-findings').onclick=async e=>{const button=e.target.closest('[data-review-keep]');if(!button)return;button.disabled=true;try{await api('/api/memory-review/keep',{id:button.dataset.reviewKeep});await load();}catch(e){toast(e.message);button.disabled=false;}};
  $('#review-ai-stop').onclick=()=>controller?.abort();
  $('#review-ai').onclick=async()=>{
    if(controller)return;const paths=[...$('#review-note-options').querySelectorAll('input:checked')].map(i=>i.value);if(paths.length<2||paths.length>8){toast('Select 2–8 notes for the local comparison.');return;}
    controller=new AbortController();$('#review-ai').disabled=true;$('#review-ai-stop').hidden=false;$('#review-ai-status').textContent='Aurora is comparing the selected notes locally…';
    try{const r=await fetch('/api/memory-review/analyze',{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':state.bootstrap.token},body:JSON.stringify({paths}),signal:controller.signal});const value=await r.json();if(!r.ok)throw new Error(value.error);await load();toast(value.findings.length?`${value.findings.length} possible contradiction(s) ready to review.`:value.discarded?'Suggestions lacked verifiable evidence; no findings were kept.':'No clear contradiction found in the selected excerpts.');}
    catch(e){$('#review-ai-status').textContent=e.name==='AbortError'?'Review stopped. Your notes are unchanged.':e.message;}
    finally{controller=null;$('#review-ai').disabled=false;$('#review-ai-stop').hidden=true;}
  };
  const dialog=document.createElement('dialog');dialog.id='memory-correction-dialog';dialog.setAttribute('aria-label','Memory correction');document.body.append(dialog);
  let correctionNote,busy=false;
  const close=()=>{if(!busy)dialog.close();};
  async function correct(path){
    if(busy)return;
    dialog.innerHTML='<h2>Correct a memory</h2><p>Loading…</p>';if(!dialog.open)dialog.showModal();
    try{
      const notes=(await api('/api/memory-review')).notes;
      dialog.innerHTML=`<h2>Correct a memory</h2><p>Replace one exact passage. Unrelated text stays unchanged. Review the before and after in Review inbox before saving.</p><label>Memory note<select id="correction-note">${notes.map(n=>`<option value="${escape(n.path)}">${escape(n.title)}</option>`).join('')}</select></label><pre id="correction-current"></pre><label>Exact original passage<textarea id="correction-before" maxlength="8000"></textarea></label><label>Replacement (empty deletes the passage)<textarea id="correction-after" maxlength="8000"></textarea></label><label>Reason / source<input id="correction-reason" maxlength="1200" placeholder="For example: my updated class details"></label><p role="status"></p><button id="correction-draft" class="primary">Prepare correction review</button><button id="correction-close">Close</button>`;
      const select=$('#correction-note');if(path&&notes.some(n=>n.path===path))select.value=path;
      async function read(){correctionNote=null;$('#correction-draft').disabled=true;const chosen=select.value;if(!chosen)return;const note=await api('/api/note?path='+encodeURIComponent(chosen));if(select.value!==chosen)return;correctionNote=note;$('#correction-current').textContent=note.body;$('#correction-before').value='';$('#correction-after').value='';$('#correction-draft').disabled=false;}
      select.onchange=()=>read().catch(e=>{dialog.querySelector('[role=status]').textContent=e.message;});
      $('#correction-close').onclick=close;
      $('#correction-draft').onclick=async()=>{if(busy||!correctionNote)return;busy=true;$('#correction-draft').disabled=true;try{await api('/api/memory-corrections',{path:correctionNote.path,revision:correctionNote.revision,before:$('#correction-before').value,after:$('#correction-after').value,reason:$('#correction-reason').value});busy=false;dialog.close();document.querySelector('[data-view=inbox]').click();toast('Correction ready in Review inbox. The note is unchanged until accepted.');}catch(e){dialog.querySelector('[role=status]').textContent=e.message;}finally{busy=false;$('#correction-draft').disabled=false;}};
      await read();
    }catch(e){dialog.innerHTML=`<h2>Correct a memory</h2><p>${escape(e.message)}</p><button id="correction-close">Close</button>`;$('#correction-close').onclick=close;}
  }
  dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  $('#memory-correct').onclick=()=>correct();
  $('#review-findings').addEventListener('click',e=>{const b=e.target.closest('[data-correct-note]');if(b)correct(b.dataset.correctNote);});
  $('#memory-correction-history').onclick=async()=>{try{const records=await api('/api/memory-corrections');dialog.innerHTML=`<h2>Memory correction history</h2><button id="correction-close">Close</button>${records.map(p=>`<article><h3>${escape(p.title)}</h3><p>${escape(p.status)} · ${escape(p.appliedAt||p.created)}</p><p>${escape(p.reason)} · ${escape(p.source)}</p><details><summary>Before and after</summary><h4>Before (historical)</h4><pre>${escape(p.before)}</pre><h4>After</h4><pre>${escape(p.after||'(Deleted)')}</pre></details>${p.historyPath?`<button data-note="${escape(p.historyPath)}">Open Markdown receipt</button>`:''}</article>`).join('')||'<p>No corrections yet.</p>'}`;$('#correction-close').onclick=close;dialog.querySelectorAll('[data-note]').forEach(b=>b.addEventListener('click',close));dialog.showModal();}catch(e){toast(e.message);}};
  window.addEventListener('beforeunload' ,()=>controller?.abort());
  return {load,isBusy:()=>!!controller};
}
