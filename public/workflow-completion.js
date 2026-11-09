export function completionReviewPanel(w,escape){
  const review=w.completionReview;if(!review)return document.createDocumentFragment();
  const panel=document.createElement('details');panel.className='completion-review';panel.id='workflow-completion-review';panel.dataset.completionReview=review.mode;panel.open=review.mode==='progress'||!w.id;
  const evidence=references=>(references||[]).map(r=>`<button type="button" data-completion-evidence="${escape(r.id)}">${escape(r.role)} · ${escape(r.label)}</button>`).join('');
  const title=c=>c.kind==='file'?c.path:c.kind==='command'?c.program+' '+c.args.join(' '):c.kind==='browser'?c.rule.url:c.rule.title;
  const ruleHTML=c=>{
    const r=c.rule;if(!r)return '<p class="panel-help">File written during this task; no explicit output requirement was saved for it.</p>';
    if(c.kind==='file')return `<p class="panel-help">Required output · final newline: ${escape(r.finalNewline)} · line endings: ${escape(r.lineEndings)}</p>${r.requiredText?.length?`<p>Required literal text: ${r.requiredText.map(t=>`<code>${escape(t)}</code>`).join(' · ')}</p>`:''}${Object.hasOwn(r,'exactText')?`<details><summary>Required exact text · whitespace shown</summary><pre>${escape(JSON.stringify(r.exactText))}</pre></details>`:''}`;
    if(c.kind==='command')return `<p>Working directory: <code>${escape(r.cwd)}</code></p><p>Required output marker: <code>${escape(r.outputIncludes)}</code></p>`;
    return c.kind==='browser'?`${r.title?`<p>Required exact title: ${escape(r.title)}</p>`:''}`:`${r.app?`<p>Required app identifier: ${escape(r.app)}</p>`:''}`;
  };
  const observedHTML=c=>{
    const v=c.observed;if(!v)return '';
    if(c.kind==='file')return `<p class="panel-help">Observed complete file · ${escape(v.bytes)} bytes</p><details><summary>Recorded content fingerprint</summary><code>${escape(v.revision)}</code></details>`;
    if(c.kind==='command')return `<p class="panel-help">Observed exit code ${escape(v.code)} · ${v.truncated?'truncated':'intact'} output${v.stopped?' · stopped':''}</p>`;
    if(c.kind==='browser')return `<p>Observed page: <code>${escape(v.url)}</code></p><p>Observed title: ${escape(v.title||'(empty)')}</p>`;
    return `<p>Observed window: ${escape(v.title)} · ${escape(v.app||'(no app identifier)')}</p>`;
  };
  const groups=[['file','Files'],['command','Required checks'],['browser','Final browser page'],['window','App or document window']];
  const checked=review.checks.filter(c=>c.passed).length;
  panel.innerHTML=`<summary>${review.mode==='progress'?'Results so far':'Completion evidence'}${review.checks.length?` · ${checked}/${review.checks.length} verified`:''}</summary><p>${escape(review.notice)}</p><p class="panel-help">${review.mode==='recorded'?'Recorded at completion':review.mode==='legacy'?'Older journal completion time':'Journal updated'}: ${escape(review.at?new Date(review.at).toLocaleString():'Unknown')} · task revision ${escape(review.revision)}</p>${review.checks.length?`<p data-completion-count><strong>${checked}/${review.checks.length}</strong> saved requirements or file readbacks verified in this review.</p>`:'<p>No explicit output requirements or saved file writes were recorded. Inspect the observed checks and Aurora’s conclusions below.</p>'}${groups.map(([kind,label])=>{const items=review.checks.filter(c=>c.kind===kind);return items.length?`<h4>${label}</h4>${items.map(c=>`<article data-completion-kind="${kind}" class="action-card"><p><strong>${c.passed?'Verified condition':'Needs verification'}</strong> · <code>${escape(title(c))}</code></p>${ruleHTML(c)}<p>${escape(c.detail)}</p>${observedHTML(c)}<div class="action-buttons">${evidence(c.references)}</div></article>`).join('')}`:'';}).join('')}
    ${review.error||review.question||review.missingOutcomes.length||review.pending.length?`<section data-completion-unresolved><h4>Still unresolved</h4>${review.error?`<p>${escape(review.error)}</p>`:''}${review.question?`<p>Aurora’s question: ${escape(review.question)}</p>`:''}${review.missingOutcomes.map(m=>`<p>${escape(m.group)}: ${escape(m.required)}</p>`).join('')}${review.pending.map(p=>`<p>${escape(p.name)} · ${escape(p.status.replaceAll('_',' '))}</p>${evidence(p.references)}`).join('')}</section>`:''}
    <p class="panel-help">${escape(review.limits)}</p>
    ${review.outcomes.length?`<details data-completion-outcomes><summary>Checks chosen by Aurora · ${review.outcomes.length}</summary><p class="panel-help">These literal expectations were chosen during execution. They do not replace your saved requirements.</p>${review.outcomes.map(c=>`<p><strong>${c.passed?'Verified against this journal':'Earlier check needs fresh verification'}</strong>: ${escape(c.kind)} · <code>${escape(c.expected)}</code></p><p>${escape(c.detail)}</p>${evidence(c.references)}`).join('')}</details>`:''}
    ${review.assessments.length?`<details data-completion-assessments><summary>Source assessments and limitations</summary><p class="panel-help">Aurora’s assessments attached to the latest saved writes. Classifications and limits are model judgments, not independently verified facts.</p>${review.assessments.map(a=>`<h4>${escape(a.path)}</h4>${a.claims.map(c=>`<p>${escape(c.kind)}: ${escape(c.text)}</p><p>Limits: ${escape(c.limits)}</p>`).join('')}${evidence(a.references)}`).join('')}</details>`:''}
    ${review.userObservations.length?`<details data-completion-user><summary>User observations · ${review.userObservations.length}</summary><p class="panel-help">Context supplied during recovery; these statements do not satisfy automatic checks.</p>${review.userObservations.map(o=>`<blockquote>${escape(o.text)}</blockquote>${evidence(o.references)}`).join('')}</details>`:''}
    ${review.failures.length?`<details data-completion-failures><summary>Earlier failed or interrupted attempts · ${review.failures.length}</summary><p class="panel-help">Historical failures remain recorded even when later checks pass. This list does not imply every earlier problem was resolved.</p>${review.failures.map(f=>`<p><strong>${escape(f.name)}</strong> · ${escape(f.status)}</p><p>${escape(f.detail)}</p>${evidence(f.references)}`).join('')}</details>`:''}
    <details data-completion-conclusions><summary>Aurora’s conclusions and unfinished steps</summary><p class="panel-help">These are Aurora’s assessments, not additional verification. Evidence buttons open the observations she cited.</p>${review.steps.map(s=>`<h4>${escape(s.title)} · ${escape(s.status)}</h4><p>${escape(s.summary||'No conclusion recorded.')}</p>${evidence(s.references)}`).join('')||'<p>No plan steps recorded.</p>'}</details>`;
  panel.onclick=e=>{
    const button=e.target.closest('[data-completion-evidence]');if(!button||!panel.isConnected)return;
    const host=panel.closest('#workflow-detail');if(!host)return;
    const target=[...host.querySelectorAll('details[data-evidence]')].find(d=>d.dataset.evidence===button.dataset.completionEvidence);
    if(target){const journal=target.closest('#workflow-journal-details');if(journal)journal.open=true;target.open=true;target.scrollIntoView({block:'center'});target.querySelector('summary')?.focus({preventScroll:true});}
  };
  return panel;
}
