export function exampleLedgerHTML(repair,escape){
  const ledger=repair.exampleLedger;if(!ledger)return '';
  return `<details data-example-ledger open><summary>Retained examples · ${ledger.total-ledger.failed}/${ledger.total} match · ${ledger.corrected} reviewed</summary><p class="panel-help">${escape(ledger.notice)}</p>${ledger.cases.map(c=>`<details><summary>${escape(c.id)} · ${c.verdict.matches?'matches':'does not match'}${c.corrected?' · reviewed correction':''}${c.retained?' · absent from latest check, retained':''}</summary><p>Original model example · ${escape(c.origin)} · ${escape(c.sourceEvidence)}</p><pre>${escape(JSON.stringify(c.original.inputs,null,2))}</pre><p>Original expected: ${escape(String(c.original.expected))} · Original proposed result: ${escape(c.original.after.error||String(c.original.after.value))} · ${c.original.matches?'matched':'failed'}</p>${c.corrected?`<p>Effective reviewed example</p><pre>${escape(JSON.stringify(c.effective,null,2))}</pre>${c.reviews.map(r=>`<p>Reviewed ${escape(r.evidence)}: ${escape(r.reason)}</p><blockquote>${escape(r.provenance.quote)}</blockquote><p class="panel-help">Source: ${escape(r.provenance.path||'Task goal')}</p>`).join('')}`:''}<p>Current calculation: ${escape(c.verdict.error||c.verdict.after?.error||String(c.verdict.after?.value))}</p>${!['edit_applied','awaiting_action'].includes(repair.state)?`<button data-review-example="${escape(c.id)}" data-repair="${escape(repair.id)}">Review example</button>`:''}</details>`).join('')}</details>`;
}
export function bindExampleReviews(host,w,{api,escape,toast}){
  host.querySelectorAll('[data-review-example]').forEach(button=>{
    const idle=['paused','needs_help'].includes(w.status),canPause=['running','planned','queued','waiting_approval'].includes(w.status);
    button.disabled=!idle&&!canPause;
    if(canPause)button.textContent='Pause and review example';
    button.onclick=async()=>{
      button.disabled=true;
      try{
        if(!idle)await api('/api/workflow-control',{id:w.id,operation:'pause'});
        const current=await api('/api/workflow?id='+encodeURIComponent(w.id));
        const repair=current.repairPlan?.repairs.find(r=>r.id===button.dataset.repair),entry=repair?.exampleLedger?.cases.find(c=>c.id===button.dataset.reviewExample);
        if(!entry)throw Error('The example changed. Refresh the task.');
        openExampleReview(current,repair,entry,{api,escape,toast});
      }catch(e){toast(e.message);}finally{button.disabled=false;}
    };
  });
}
function openExampleReview(w,repair,entry,{api,escape,toast}){
  document.querySelector('[data-example-review]')?.remove();
  const dialog=document.createElement('dialog');dialog.dataset.exampleReview='';dialog.setAttribute('aria-labelledby','example-review-title');dialog.className='example-review-dialog';
  dialog.innerHTML=`<h2 id="example-review-title">Review ${escape(entry.id)}</h2><p>Correct the example only when the task or observed source supports the change. Saving keeps the task paused; file edits and commands need separate approval.</p><pre>${escape(repair.expressionBinding.before)} → ${escape(repair.expressionBinding.after)}</pre><details><summary>Original model example</summary><pre>${escape(JSON.stringify(entry.original,null,2))}</pre></details>
    <form><label>Inputs (JSON object)<textarea name="inputs" rows="5" required></textarea></label><label>Expected result (number or true/false)<input name="expected" required></label><label>Why is the original example mistaken?<textarea name="reason" maxlength="600" required></textarea></label><label>Quote from<select name="kind"><option value="goal">Task goal</option><option value="source">Observed file</option></select></label><label data-source-field hidden>Observed file<select name="evidence">${w.operations.map((o,i)=>o.name==='read_system_file'&&o.status==='completed'&&!o.result?.truncated&&o.result?.content?`<option value="E${i+1}">E${i+1} · ${escape(o.result.path)}</option>`:'').join('')}</select></label><details data-quote-context><summary>Read source text</summary><pre></pre></details><label>Exact quote supporting the correction<textarea name="quote" maxlength="1200" required></textarea></label><p class="panel-help">A matching quote records where the correction came from. You still need to judge whether it supports these inputs and the expected result.</p><div data-example-error role="alert"></div><section data-example-preview aria-live="polite"></section><div class="example-review-actions"><button type="button" data-example-close>Close</button><button type="submit">Preview correction</button><button type="button" data-example-save class="primary" disabled>Save reviewed correction</button></div></form>`;
  const form=dialog.querySelector('form'),field=name=>form.elements.namedItem(name),save=dialog.querySelector('[data-example-save]'),preview=dialog.querySelector('[data-example-preview]'),error=dialog.querySelector('[data-example-error]');let prepared,busy=false;
  field('inputs').value=JSON.stringify(entry.effective.inputs,null,2);field('expected').value=JSON.stringify(entry.effective.expected);
  const context=()=>{const source=field('kind').value==='source';dialog.querySelector('[data-source-field]').hidden=!source;dialog.querySelector('[data-quote-context] pre').textContent=source?w.operations[Number(field('evidence').value.slice(1))-1]?.result?.content||'No complete source observation.':w.goal;};context();
  const invalidate=()=>{prepared=null;save.disabled=true;preview.replaceChildren();error.textContent='';context();};form.oninput=invalidate;form.onchange=invalidate;
  const lock=value=>{busy=value;for(const node of form.querySelectorAll('input,textarea,select,button'))node.disabled=value;save.disabled=value||!prepared;};
  dialog.oncancel=e=>{if(busy)e.preventDefault();};dialog.onclose=()=>dialog.remove();dialog.querySelector('[data-example-close]').onclick=()=>dialog.close();
  form.onsubmit=async e=>{e.preventDefault();if(busy)return;prepared=null;error.textContent='';preview.replaceChildren();lock(true);
    try{
      const kind=field('kind').value,input={id:w.id,revision:w.revision,repair:repair.id,caseId:entry.id,inputs:JSON.parse(field('inputs').value),expected:JSON.parse(field('expected').value),reason:field('reason').value,provenance:{kind,quote:field('quote').value,...kind==='source'?{evidence:field('evidence').value}:{}}};
      const result=await api('/api/workflow-example-review',{...input,operation:'preview'});prepared={input,token:result.token};
      preview.innerHTML=`<h3>Review before saving</h3><p>Previous effective example</p><pre>${escape(JSON.stringify(result.before,null,2))}</pre><p>Proposed example</p><pre>${escape(JSON.stringify(result.after,null,2))}</pre><p>Computed result: ${escape(result.verdict.after.error||String(result.verdict.after.value))} · ${result.verdict.matches?'matches':'still fails'}</p><p>Reason: ${escape(result.reason)}</p><blockquote>${escape(result.provenance.quote)}</blockquote><p>${escape(result.notice)}</p>`;
    }catch(e){error.textContent=e.message;}finally{lock(false);}
  };
  save.onclick=async()=>{if(!prepared||busy)return;lock(true);error.textContent='';try{await api('/api/workflow-example-review',{...prepared.input,token:prepared.token,operation:'apply'});prepared=null;preview.textContent='Reviewed correction saved. Original example retained. Close this review, then use Resume when ready.';toast('Example correction saved. Task remains paused.');}catch(e){prepared=null;error.textContent=e.message;}finally{lock(false);}};
  // The main task view polls independently. Keep this form outside it so task
  // refreshes cannot discard a draft or replace a preview under the cursor.
  document.body.append(dialog);dialog.showModal();field('inputs').focus();
}
