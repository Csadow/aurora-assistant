import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {repairReviewCases,applyCandidate,reviewAspects} from '../scripts/repair-review-corpus.mjs';
import {repairReviewPacket,repairReviewRequest,repairReviewReceipt} from '../scripts/repair-review-protocol.mjs';
import {reviewOracle} from '../scripts/repair-review-oracle.mjs';
import {scoreRepairReviews} from '../scripts/repair-review-score.mjs';
import {sha} from '../src/vault.mjs';
const answer=(input,status={behavior:'supported',scope:'supported',examples:'not_supplied'})=>Object.fromEntries(reviewAspects.map(a=>[a,{status:status[a],reason:'Fixture assessment grounded in the supplied text.',evidence:a==='examples'&&status[a]==='not_supplied'?[]:['G:1']}]));
const reply=body=>({content:JSON.stringify(body)});
test('16 independently labelled reviews contain five correct, nine wrong, and two uncertain cases',async()=>{
 const corpus=await repairReviewCases();assert.equal(corpus.length,16);assert.equal(corpus.filter(c=>c.expectedVerdict==='supported').length,5);assert.equal(corpus.filter(c=>c.expectedVerdict==='revise').length,9);assert.equal(corpus.filter(c=>c.expectedVerdict==='uncertain').length,2);assert.equal(corpus.filter(c=>c.partition==='development').length,4);
 for(const c of corpus){const before=JSON.stringify(c.input),p=repairReviewPacket(c.input),r=repairReviewRequest(c.input),serialized=JSON.stringify(r);assert(!serialized.includes(c.rubric));assert(!serialized.includes(c.name));assert(!Object.hasOwn(p,'expected'));assert(!Object.hasOwn(p,'name'));assert(!Object.hasOwn(p,'partition'));assert.equal(p.goal,c.input.goal);assert.equal(p.scope,c.input.scope);assert(r.inputBytes<24000);assert(r.format.properties.behavior.properties.evidence.items.enum.includes('G:1'));assert(!r.format.properties.behavior.properties.evidence.items.enum.includes('G:6'));assert.equal(JSON.stringify(c.input),before);assert(p.sources.some(s=>s.id==='P'&&s.kind==='unexecuted candidate preview'));}
});
test('preview is an exact one-fragment transformation and never alters observed source',async()=>{
 const c=(await repairReviewCases())[0],before=structuredClone(c.input),p=applyCandidate(c.input);assert.deepEqual(c.input,before);assert.equal(p.content,before.files[0].content.replace(before.candidate.before,before.candidate.after));assert.equal(p.revision,sha(p.content));
 for(const edit of [{line:0},{line:99},{before:'not observed'},{after:'x\ny'}])assert.throws(()=>applyCandidate({...c.input,candidate:{...c.input.candidate,...edit}}));
 const wrong=structuredClone(c.input);wrong.files[0].content+='changed';assert.throws(()=>applyCandidate(wrong),/changed/);
});
test('independent geometry matrix confirms the behavioral labels including scope-only and example-only failures',async()=>{
 for(const c of await repairReviewCases()){
  const r=await reviewOracle(c.name,c.input);
  if(c.expected.behavior==='unknown'){assert.equal(r.status,'not_executed');continue;}
  assert.equal(r.status,'executed');assert.equal(r.passed,c.expected.behavior==='supported',c.name);assert(r.cases.length>=5);
  if(c.name==='early_margin_initialization')assert(r.cases.every(c=>c.error?.includes('before initialization')));
  if(c.name==='correct_repair_wrong_example'||c.name==='neighbor_reordering'){assert(r.passed);assert.equal(c.expectedVerdict,'revise');if(c.name==='correct_repair_wrong_example'){assert.equal(r.examples[0].after.value,1260);assert.equal(r.examples[0].matches,false);}}
 }
});
test('oracle refuses modified or unknown code and cannot consume model repairs',async()=>{
 const c=(await repairReviewCases())[0];await assert.rejects(reviewOracle('unknown',c.input));const changed=structuredClone(c.input);changed.candidate.after='process.exit(0)';await assert.rejects(reviewOracle(c.name,changed),/unchanged built-in/);
});
test('separate axes derive verdicts without contradictory supported-with-concerns output',async()=>{
 const input=(await repairReviewCases())[0].input;
 for(const [scope,verdict] of [['supported','supported'],['problem','revise'],['unknown','uncertain']]){const r=repairReviewReceipt(input,reply(answer(input,{behavior:'supported',scope,examples:'not_supplied'})));assert.equal(r.verdict,verdict);assert.equal(r.assessment.scope.evidence[0].text,input.goal);assert.equal(r.inputRevision,sha(JSON.stringify(input)));assert.match(r.notice,/No action/);}
 const c=(await repairReviewCases()).find(c=>c.name==='correct_repair_wrong_example'),r=repairReviewReceipt(c.input,reply(answer(c.input,c.expected)));assert.equal(r.verdict,'revise');assert.equal(r.assessment.behavior.status,'supported');
});
test('invalid axes, fabricated references, absent/supplied example mismatches and tool requests fail closed',async()=>{
 const input=(await repairReviewCases())[0].input,base=answer(input);
 for(const body of [null,[],{...base,approved:true},{...base,scope:{...base.scope,status:'not_supplied'}},{...base,scope:{...base.scope,reason:''}},{...base,scope:{...base.scope,evidence:[]}},{...base,scope:{...base.scope,evidence:['P:999']}},{...base,scope:{...base.scope,evidence:['missing:1']}},{...base,scope:{...base.scope,evidence:[{source:'G',line:1,quote:'invented'}]}},{...base,examples:{...base.examples,status:'supported'}}])assert.throws(()=>repairReviewReceipt(input,reply(body)));
 assert.throws(()=>repairReviewReceipt(input,{...reply(base),tool_calls:[{function:{name:'propose_repair'}}]}));assert.throws(()=>repairReviewReceipt(input,{content:'not json'}));
 const withExamples=(await repairReviewCases()).find(c=>c.input.examples.length).input;assert.throws(()=>repairReviewReceipt(withExamples,reply(base)),/examples needs/);
});
test('missing helper remains an import rather than an invented implementation, and conflicting test is preserved',async()=>{
 const cases=await repairReviewCases(),missing=cases.find(c=>c.name==='missing_width_helper'),conflict=cases.find(c=>c.name==='conflicting_margin_test');
 assert(missing.input.files[1].content.includes("import {execFile} from 'node:child_process'"));assert(missing.input.files[1].content.includes("import {logicalWidth} from './monitor-math.mjs'"));assert(!missing.input.files.some(f=>f.path.endsWith('monitor-math.mjs')));assert(applyCandidate(missing.input).content.includes('width:width-left-right'));
 assert(conflict.input.goal.includes('gives 700'));assert(conflict.input.files[2].content.includes('width:740,height:1230'));
});
test('budget rejection retains full contract and original eight-case baseline stays separate',async()=>{
 const c=(await repairReviewCases())[0];assert.throws(()=>repairReviewRequest({...c.input,goal:'x'.repeat(24001)}),/nothing was truncated/);
 const legacy=await readFile(new URL('../scripts/repair-diagnosis-replay.mjs',import.meta.url),'utf8');assert(!legacy.includes('repair-review-protocol'));
 const runtime=await readFile(new URL('../src/workflows.mjs',import.meta.url),'utf8');assert(!runtime.includes('repair-review-protocol'));assert(!runtime.includes('repair-review-eval'));
});
test('score keeps output failures, false objections, misses and unattempted cases in their own denominators',async()=>{
 const cases=await repairReviewCases(),correct=cases.find(c=>c.expectedVerdict==='supported'),wrong=cases.find(c=>c.expectedVerdict==='revise');
 const results=[{name:correct.name,receipt:repairReviewReceipt(correct.input,reply(answer(correct.input,{behavior:'problem',scope:'supported',examples:'not_supplied'}))),seconds:12},{name:wrong.name,receipt:repairReviewReceipt(wrong.input,reply(answer(wrong.input))),seconds:20},{name:cases[1].name,error:'output limit',failureKind:'output_limit',seconds:90}];
 const s=scoreRepairReviews(cases,results);assert.equal(s.planned,16);assert.equal(s.attempted,3);assert.deepEqual(s.validOutput,{passed:2,total:16});assert.deepEqual(s.falseObjections,[correct.name]);assert.deepEqual(s.missedProblems,[wrong.name]);assert.equal(s.wrongCandidates.total,8);assert.equal(s.exampleProblems.total,1);assert.equal(s.notAttempted.length,13);assert.equal(s.failures.length,1);assert.equal(s.latency.maxSeconds,90);assert.equal(scoreRepairReviews(cases,results.slice(0,2)).latency.medianSeconds,16);assert.throws(()=>scoreRepairReviews(cases,[results[0],results[0]]));
});

test('CLI defaults to deterministic preflight and rejects ambiguous live flags before inference',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),exec=promisify(execFile),script=new URL('../scripts/repair-review-eval.mjs',import.meta.url).pathname;
 const r=await exec(process.execPath,[script],{timeout:10000});const report=JSON.parse(r.stdout);assert.equal(report.mode,'preflight');assert.equal(report.cases.length,16);assert(report.cases.every(c=>c.inputBytes<24000));
 await assert.rejects(exec(process.execPath,[script,'--live','--preflight'],{timeout:10000}),/Use --preflight/);
 await assert.rejects(exec(process.execPath,[script,'--review-thinking=on','--review-thinking=off'],{timeout:10000}),/Use --preflight/);
 await assert.rejects(exec(process.execPath,[script,'--partition=unknown'],{timeout:10000}),/Use --preflight/);
});

test('retained real reviews demonstrate that valid citations do not certify a correct repair judgment',async()=>{
 const retained=JSON.parse(await readFile(new URL('fixtures/repair-review-failures.json',import.meta.url)));
 assert.equal(retained.length,5);
 for(const c of retained){
  if(c.audit.category==='invalid_output'){assert.throws(()=>repairReviewReceipt(c.input,c.rawReply),/examples needs/);continue;}
  const receipt=repairReviewReceipt(c.input,c.rawReply);assert(receipt.assessment.behavior.evidence.every(e=>e.text));
  if(['false_objection','missed_bug'].includes(c.audit.category))assert.notEqual(receipt.verdict,c.expectedVerdict,c.name);
  if(c.audit.category==='right_verdict_wrong_reason'){
   assert.equal(receipt.verdict,c.expectedVerdict);const oracle=await reviewOracle(c.name,c.input);
   assert.equal(oracle.cases[0].actual.width,700);assert.equal(oracle.cases[0].expected.width,700);
   const edge=oracle.cases.find(x=>x.input[0].width===200);assert.equal(edge.expected.width,200);assert.equal(edge.actual.width,340);
  }
 }
});
