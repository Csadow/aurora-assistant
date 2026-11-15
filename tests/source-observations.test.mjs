import test from 'node:test';
import assert from 'node:assert/strict';
import {sha} from '../src/vault.mjs';
import {reviewedSourceObservations} from '../src/workflow-source-observations.mjs';
import {sourceObservationShell,sourceObservationResultsHTML} from '../public/source-observations.js';

const escape=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fixture=()=>{
  const content='The owner needs offline editing <fixed>.\nThe budget is 115 credits.\n',draft='Decision note\n',revision=sha(content);
  const review={path:'/work/decision.md',draftRevision:sha(draft),taskRevision:2,sources:[{path:'/work/requirements.md',evidence:'read-1',revision}],claims:[]};
  const action={id:'action-1',kind:'write',workflow:{id:'task-1',operation:'write-1'},payload:{path:review.path,content:draft,requirementsCheck:{sourceReview:review}}};
  const workflow={id:'task-1',operations:[{id:'read-1',name:'read_system_file',status:'completed',revision:2,result:{path:'/work/requirements.md',content,revision}},{id:'write-1',action:'action-1',sourceReview:review}]};
  return {action,workflow,content};
};

test('recorded source viewer returns complete reads attached to the exact proposal',()=>{
  const {action,workflow,content}=fixture(),receipt=reviewedSourceObservations(action,workflow);
  assert.equal(receipt.actionId,action.id);
  assert.deepEqual(receipt.sources,[{path:'/work/requirements.md',revision:sha(content),content}]);
  assert.match(receipt.notice,/approval checks the current files again/i);
});

test('source viewer refuses missing, altered or unrelated saved reads',()=>{
  for(const change of [({workflow})=>{workflow.operations[0].result.content='A changed condition.';},({workflow})=>{workflow.operations[0].result.truncated=true;},({action})=>{action.workflow.operation='read-1';},({action})=>{action.payload.content='A different draft';},({action})=>{action.payload.requirementsCheck.sourceReview.sources[0].evidence='other-read';}]){
    const state=fixture();change(state);assert.throws(()=>reviewedSourceObservations(state.action,state.workflow),/recorded source|matching recorded source review/i);
  }
});

test('source search shows exact matching lines and keeps full escaped text available',()=>{
  const {action,workflow}=fixture(),sources=reviewedSourceObservations(action,workflow).sources;
  assert.match(sourceObservationShell(action.payload.requirementsCheck.sourceReview),/Search recorded sources · 1 file/);
  const html=sourceObservationResultsHTML(sources,'offline',escape);
  assert.match(html,/Line 1/);
  assert.match(html,/offline editing &lt;fixed&gt;/);
  assert.match(html,/Complete recorded read/);
  assert.doesNotMatch(html,/<fixed>/);
  assert.match(sourceObservationResultsHTML(sources,'missing',escape),/No recorded source line contains/);
});
