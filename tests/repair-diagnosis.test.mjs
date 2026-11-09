import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosisCases,diagnosisMessages,diagnosisReceipt} from '../scripts/repair-diagnosis-cases.mjs';
import {sha} from '../src/vault.mjs';
test('diagnosis corpus binds eight candidates to full source and withholds independent labels and rubrics',async()=>{
 const cases=await diagnosisCases();assert.equal(cases.length,8);assert.equal(cases.filter(c=>c.expected==='supported').length,2);
 for(const c of cases){const source=c.input.files.find(f=>f.path===c.input.candidate.path);assert.equal(source.revision,sha(source.content));assert(source.content.split('\n')[c.input.candidate.line-1].includes(c.input.candidate.before));const messages=diagnosisMessages(c.input);assert(!JSON.stringify(messages).includes(c.rubric));assert.equal(JSON.parse(messages[1].content).goal,c.input.goal);assert.equal(c.input.files.length,3);}
});
test('diagnosis advice requires a valid verdict and literal supplied evidence but cannot authorize an action',async()=>{
 const input=(await diagnosisCases())[4].input,body={verdict:'revise',reason:'The right margin is still added.',concerns:[{kind:'behavior',reason:'Subtract both margins.',path:input.candidate.path,quote:input.candidate.before}]};
 const receipt=diagnosisReceipt(input,{content:JSON.stringify(body)});assert.equal(receipt.inputRevision,sha(JSON.stringify(input)));assert.match(receipt.notice,/No action/);
 for(const modified of [{...body,approved:true},{...body,concerns:[]},{...body,verdict:'supported'},{...body,concerns:[{...body.concerns[0],quote:'fabricated evidence'}]},{...body,concerns:[{...body.concerns[0],path:'/other'}]}])assert.throws(()=>diagnosisReceipt(input,{content:JSON.stringify(modified)}));
 assert.throws(()=>diagnosisReceipt(input,{content:JSON.stringify(body),tool_calls:[{function:{name:'propose_repair'}}]}));
 assert.throws(()=>diagnosisMessages({...input,goal:'x'.repeat(24001)}),/nothing was truncated/);
});
