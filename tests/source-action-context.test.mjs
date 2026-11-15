import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceActionContextHTML} from '../public/source-claims.js';

const escape=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

test('sourced action review shows the fixed goal and arithmetic without executing source text',()=>{
  const html=sourceActionContextHTML({goal:'Keep offline editing under 115 credits <script>window.XSS=true</script>',comparisons:['155 > 115','<img src=x onerror=window.XSS=true>']},escape);
  assert.match(html,/Keep offline editing under 115 credits/);
  assert.match(html,/155 &gt; 115/);
  assert.match(html,/Literal quotes, links and a separate model critique can miss/);
  assert.doesNotMatch(html,/<script|<img/);
  assert.equal(sourceActionContextHTML(null,escape),'');
});
