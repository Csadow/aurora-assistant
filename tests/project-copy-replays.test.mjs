import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {projectProgress} from '../src/workflow-project-progress.mjs';
import {needsHelp} from '../src/workflow-help.mjs';
import {Workflows} from '../src/workflows.mjs';
import {focusedRequest,focusedProjectPrompt} from '../src/workflow-project-context.mjs';
import {characterIdentity,caringCharacter,Character} from '../src/character.mjs';
import {copyResultForModel} from '../src/workflow-test-copy.mjs';
const cases=JSON.parse(await readFile(new URL('fixtures/project-copy-failures.json',import.meta.url)));

test('retained skipped-copy attempts no longer receive a direct apply instruction',async()=>{
  const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
  const style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
  for(const {record:w} of cases.filter(c=>['labels','layout'].includes(c.id))){
    const original=JSON.stringify(w),p=projectProgress(w);assert.equal(p.phase,'repair');assert.equal(p.next.tool,undefined);assert.match(p.next.message,/THIS repair first/);assert.equal(p.readyToFinish,false);
    const packet=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)});
    assert(packet.inputBytes<=24000);const c=JSON.parse(packet.messages.at(-1).content);assert.equal(c.goal,w.goal);assert.deepEqual(c.outputRequirements,w.requirements);assert(c.projectProgress.next.message.includes('propose_test_copy'));assert.equal(JSON.stringify(w),original);
    assert.equal(projectProgress({...w,version:11}).next.tool,'propose_repair','old task guidance is unchanged');
    assert.equal(projectProgress({...w,project:{...w.project,checks:[]}}).next.tool,'propose_repair','unavailable copy testing is not suggested');
  }
});

test('retained copy-output budget failure fits without dropping the contract or executed failure',async()=>{
  const w=structuredClone(cases.find(c=>c.id==='layout-budget').record),before=JSON.stringify(w),wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
  const history=wf.executionHistory(w),copies=history.filter(m=>m.tool_name==='propose_test_copy');assert.equal(copies.length,1);assert.equal(JSON.parse(copies[0].content).result.kind,'test_copy');assert(JSON.parse(copies[0].content).result.runs.some(r=>!r.passed));
  const style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
  const packet=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt,history,context:wf.context(w),tools:wf.toolsFor(w)}),context=JSON.parse(packet.messages.at(-1).content);
  assert(packet.inputBytes<=24000);assert.equal(context.goal,w.goal);assert.equal(context.scope,w.scope);assert.deepEqual(context.outputRequirements,w.requirements);assert.equal(JSON.stringify(w),before);
  const failed=w.operations.find(o=>o.name==='propose_test_copy'&&o.status==='failed');
  for(const change of [o=>o.arguments.check='C2',o=>o.arguments.repair='R99.1',o=>o.action='executed-failure']){
    const copy=structuredClone(w);change(copy.operations.find(o=>o.id===failed.id));assert.equal(wf.executionHistory(copy).filter(m=>m.tool_name==='propose_test_copy').length,2);
  }
});

test('copy model summaries preserve verdicts and mark display excerpts without inventing command truncation',()=>{
  const result={kind:'test_copy',sourceRoot:'/tmp/fixture',sandboxRoot:'/project',notice:'Original checks still required',content:'Repeated summary',stopped:false,cleanedUp:true,originalSourcesCurrent:false,sourceWarning:'Source changed',runs:[{variant:'candidate',code:1,passed:false,marker:false,truncated:false,content:'assertion failed\n'+'x'.repeat(2000)}]};
  const before=JSON.stringify(result),view=copyResultForModel(result);assert.equal(view.content,undefined);assert(view.cleanedUp);assert.equal(view.originalSourcesCurrent,false);assert.equal(view.sourceWarning,result.sourceWarning);assert.equal(view.runs[0].code,1);assert.equal(view.runs[0].passed,false);assert.equal(view.runs[0].truncated,false);assert(view.runs[0].outputExcerpted);assert.equal(view.runs[0].content.length,1400);assert.equal(JSON.stringify(result),before);
  assert.equal(view.sourceRoot,result.sourceRoot);assert.equal(view.sandboxRoot,'/project');
});

test('two real copy failures fit together with explicit excerpt flags and all original verdicts',async()=>{
  const w=structuredClone(cases.find(c=>c.id==='layout-two-copies').record),before=JSON.stringify(w),wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
  const style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
  const packet=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)});
  const copies=packet.messages.filter(m=>m.tool_name==='propose_test_copy').map(m=>JSON.parse(m.content).result);
  assert.equal(copies.length,2);assert(copies.every(r=>r.runs.every(x=>x.code===1&&!x.passed&&!x.truncated)));assert(copies.some(r=>r.runs.some(x=>x.outputExcerpted&&x.content.includes('middle omitted'))));
  const context=JSON.parse(packet.messages.at(-1).content);assert.equal(context.goal,w.goal);assert.deepEqual(context.outputRequirements,w.requirements);assert(packet.inputBytes<=24000);assert.equal(JSON.stringify(w),before);
});

test('missing-source help retains actual failed paths and keeps the rejected diagnosis unexecuted',()=>{
  const w=structuredClone(cases.find(c=>c.id==='missing').record),before=JSON.stringify(w.operations);needsHelp(w,'Repeated failures');
  assert.match(w.help.question,/src\/text\.mjs/);const failures=JSON.parse(w.help.context).failures;
  assert.equal(failures[0].path,w.operations[2].arguments.path);assert.equal(failures[0].error,'Path not found.');assert.equal(failures[1].path,undefined);
  assert.equal(w.status,'needs_help');assert.equal(JSON.stringify(w.operations),before);assert(!w.operations.some(o=>o.expected||o.action));assert(!w.result);
});

test('help excerpts remain bounded and redacted without changing an explicit question',()=>{
  const dummyKey=['sk','abcdefghijklmnopABCDEFGHIJKLMNOP'].join('-');
  const w={goal:'g'.repeat(6000),steps:[],current:0,operations:Array.from({length:8},()=>({name:'read_system_file',status:'failed',arguments:{path:'/tmp/fixture/'+ 'x'.repeat(5000)},result:{error:'api_key='+dummyKey+'\n'+ 'e'.repeat(3000)}}))};
  needsHelp(w,'failure');assert(w.help.question.length<=12000);assert.equal(JSON.parse(w.help.context).failures.length,3);assert(!w.help.question.includes('sk-'));assert(!w.help.context.includes('sk-'));assert(JSON.parse(w.help.context).failures.every(f=>f.path.length===1000));
  needsHelp(w,'failure','My exact reviewed question');assert.equal(w.help.question,'My exact reviewed question');
});
