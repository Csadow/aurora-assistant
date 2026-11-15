import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceActionContextHTML} from '../public/source-claims.js';

const escape=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

test('sourced action review shows goal, scope, later instructions and arithmetic without executing source text',()=>{
  const html=sourceActionContextHTML({goal:'Compare the offers <script>window.XSS=true</script>',scope:'Keep offline editing under 115 credits <svg onload=window.XSS=true>',updates:['Do not relax the offline rule <img src=x onerror=window.XSS=true>'],comparisons:['155 > 115','<img src=x onerror=window.XSS=true>']},escape);
  assert.match(html,/Compare the offers/);
  assert.match(html,/Keep offline editing under 115 credits/);
  assert.match(html,/Later task instructions/);
  assert.match(html,/Do not relax the offline rule/);
  assert.match(html,/155 &gt; 115/);
  assert.match(html,/Literal quotes, links and a separate model critique can miss/);
  assert.doesNotMatch(html,/<script|<img|<svg/);
  assert.equal(sourceActionContextHTML(null,escape),'');
});

test('older source review context remains readable',()=>{
  const html=sourceActionContextHTML({goal:'Old pending task',comparisons:[]},escape);
  assert.match(html,/Old pending task/);
  assert.doesNotMatch(html,/Later task instructions|<strong>Scope<\/strong>/);
});

test('a recorded limit straddle and exact decision wording stay visible with escaped text',()=>{
 const html=sourceActionContextHTML({goal:'Choose a vendor',comparisons:['85 > 70','65 < 70'],numberAlerts:[{limit:{value:'70'},below:[{expression:'65 < 70',source:'/work/catalog<img src=x>.md'}],above:[{expression:'85 > 70',source:'/work/quote.md'}]}],decisionWording:[{number:11,text:'Decision: Cedar at 65 <strong>meets</strong> the budget.',limits:'If the catalog price is current <img src=x>.'}]},escape);
 assert.match(html,/data-number-alert/);assert.match(html,/Numbers on both sides of 70/);assert.match(html,/65 &lt; 70/);assert.match(html,/85 &gt; 70/);
 assert.match(html,/whether these values describe the same option/);assert.match(html,/data-decision-wording/);assert.match(html,/claim 11/);
 assert.match(html,/Decision: Cedar at 65 &lt;strong&gt;meets&lt;\/strong&gt;/);assert.match(html,/Claim review limits:/);assert.match(html,/If the catalog price is current &lt;img/);assert.doesNotMatch(html,/<img|<strong>meets/);
});
