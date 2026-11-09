export function repairExpressionsHTML(check,escape,feedback,binding){
  const bound=binding?`<details data-expression-binding open><summary>${binding.status==='bound'?'Calculation linked to saved repair':'Automatic calculation unavailable'}</summary>
    ${binding.status==='bound'?`<pre>${escape(binding.before)} → ${escape(binding.after)}</pre><p>Required scalar inputs: ${escape(binding.requiredInputs.join(', ')||'(none)')}</p><p class="panel-help">Aurora supplies examples for this exact change. Linking it does not prove the repair or its expected results are correct.</p>`:`<p>${escape(binding.message)}</p>`}
    <p class="panel-help">${binding.currentSource?'Current observed source.':'Historical source; a fresh matching read is needed before calculation.'}</p></details>`:'';
  const error=feedback?`<details data-expression-feedback open><summary>Expression example needs correction</summary>
    <p><strong>${escape(feedback.field)}</strong> · ${escape(feedback.message)}</p>
    <p class="panel-help">${escape(feedback.notice)}</p>
    ${feedback.requiredInputs?`<p>Required scalar inputs: ${escape(feedback.requiredInputs.join(', ')||'(none)')}</p>`:''}
    ${feedback.observation?`<p>${feedback.currentSource?'Current':'Historical'} observed line ${escape(feedback.observation.line)}${feedback.observation.truncated?' (excerpt)':''}</p><pre>${escape(feedback.observation.text)}</pre>`:''}
    ${feedback.savedCorrection?`<p>Saved correction${feedback.savedCorrection.truncated?' (excerpt)':''}${binding?'.':'; select only its expression for the calculator.'}</p><pre>${escape(feedback.savedCorrection.before)} → ${escape(feedback.savedCorrection.after)}</pre>`:''}
    </details>`:'';
  if(!check)return bound+error;
  const value=r=>escape(r.error||String(r.value));
  return bound+error+`<details data-expression-check open><summary>Expression examples · ${escape(check.matched)}/${escape(check.caseCount)} match</summary>
    <p class="panel-help">${escape(check.notice)}</p>
    <p>${check.currentSource?'Bound to the current observed source.':'Historical calculation: source needs a fresh matching observation.'}</p>
    ${check.hasFailedExamples?'<p class="permission-notice">This saved repair has failed examples. Revise the diagnosis before staging it; later matching examples do not erase failures.</p>':''}
    <pre>${escape(check.before)} → ${escape(check.after)}</pre>
    ${check.introducedInputs?.length?`<p>New expression inputs: ${escape(check.introducedInputs.join(', '))}. Check their initialization in the source; this is not a scope verdict.</p>`:''}
    <p><small>Source revision: ${escape(check.sourceRevision)} · ${escape(check.sourceEvidence)}</small></p>
    ${check.cases.map((c,i)=>`<details><summary>Example ${i+1} · ${c.matches?'matches':'does not match'}</summary><pre>${escape(JSON.stringify(c.inputs,null,2))}</pre><p>Expected: ${escape(String(c.expected))} · Before: ${value(c.before)} · Proposed: ${value(c.after)}</p></details>`).join('')}
  </details>`;
}
