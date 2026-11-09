import test from 'node:test';
import assert from 'node:assert/strict';
import {sha} from '../src/vault.mjs';
import {projectProgress} from '../src/workflow-project-progress.mjs';
import {focusedTools} from '../src/workflow-project-context.mjs';
import {verifyOutcome} from '../src/workflow-evidence.mjs';
import {repeatedObservations} from '../src/workflow-recovery.mjs';
import {readFile} from 'node:fs/promises';
import {Workflows} from '../src/workflows.mjs';
import {focusedRequest,focusedProjectPrompt} from '../src/workflow-project-context.mjs';
import {characterIdentity,caringCharacter,Character} from '../src/character.mjs';
import {recordRepairPlan,proposeRepair} from '../src/workflow-repair-plan.mjs';

const path='/tmp/project/source.mjs',command={program:'/usr/bin/node',args:['--test','test.mjs'],cwd:'/tmp/project',outputIncludes:'pass 2'};
const fixture=()=>({version:7,revision:1,project:{},requirements:{files:[{path,finalNewline:'required',lineEndings:'lf'}],commands:[command]},operations:[]});
const read=(w,content='good\n')=>append(w,{name:'read_system_file',arguments:{path},result:{path,content,revision:sha(content),truncated:false}});
function append(w,op){const o={id:'operation-'+(w.operations.length+1),revision:1,status:'completed',started:'2026-01-01',finished:'2026-01-01',...op};w.operations.push(o);return o;}
function write(w){return append(w,{name:'propose_file_edit',action:'write',expected:{path,revision:sha('good\n')}});}
function check(w,extra={}){return append(w,{name:'propose_command',action:'command',command,result:{code:0,content:'pass 2',truncated:false},...extra});}
function verify(w,op=w.operations.at(-1)){return append(w,{name:'verify_outcome',result:verifyOutcome(w,{evidence:op.id,kind:'command_output',expected:'pass 2'})});}
function done(){const w=fixture();read(w);write(w);check(w);verify(w);read(w);return w;}
const tools=['read_system_file','propose_check','verify_outcome','finish_step'].map(name=>({function:{name,description:'Fixture',parameters:{properties:{}}}}));
const names=w=>focusedTools(w,tools).map(t=>t.function.name);

test('project progress follows real checks, marker verification and final readback without mutating history',()=>{
 const w=fixture();assert.equal(projectProgress(w).next.arguments.path,path);
 read(w);write(w);assert.equal(projectProgress(w).phase,'check');assert.equal(projectProgress(w).next.arguments.check,'C1');
 const c=check(w);assert.equal(projectProgress(w).phase,'verify');assert.deepEqual(projectProgress(w).next.arguments,{evidence:'E3',kind:'command_output',expected:'pass 2'});
 verify(w,c);assert.equal(projectProgress(w).phase,'read');read(w);
 const original=JSON.stringify(w),p=projectProgress(w);assert.equal(p.readyToFinish,true);assert.equal(p.phase,'finish');assert.deepEqual(p.finishEvidence,['E5','E3']);assert.equal(JSON.stringify(w),original);
 assert(!names(w).includes('propose_check'));assert(!names(w).includes('verify_outcome'));assert(!names(w).includes('read_system_file'));assert(names(w).includes('finish_step'));
 w.projectToolGroup='files';assert(names(w).includes('propose_check'));assert(names(w).includes('read_system_file'));assert(names(w).includes('verify_outcome'),'uncovered issues remain investigable');
 assert.equal(projectProgress({...w,version:6}),null);assert.equal(focusedTools({...w,version:6},tools),tools);
});
test('restart invalidates completion and never replays edits; a pending check executed after resume is fresh',()=>{
 let w=done();w=JSON.parse(JSON.stringify(w));w.projectCheckpoint={id:'checkpoint',operationCount:w.operations.length};
 assert.equal(projectProgress(w).readyToFinish,false);assert.equal(projectProgress(w).phase,'read');read(w);assert.equal(projectProgress(w).phase,'check');
 const op=check(w,{status:'waiting_approval'});assert.equal(projectProgress(w).phase,'approval');w.projectCheckpoint={id:'second',operationCount:w.operations.length};op.status='completed';op.executionCheckpoint='second';
 assert.equal(projectProgress(w).phase,'verify');verify(w,op);read(w);assert.equal(projectProgress(w).readyToFinish,true);assert.equal(w.operations.filter(o=>o.expected).length,1);
});
test('pending actions, new effects, malformed reads and failed checks cannot suggest completion',()=>{
 for(const addition of [w=>check(w,{status:'waiting_approval'}),w=>write(w),w=>check(w,{result:{code:1,content:'pass 2'}}),w=>check(w,{result:{code:0,content:'pass 2',truncated:true}}),w=>read(w).result.revision='wrong',w=>read(w).result.truncated=true]){
  const w=done();addition(w);assert.equal(projectProgress(w).readyToFinish,false);
 }
 const w=done();read(w,'changed\n');assert.equal(projectProgress(w).readyToFinish,false);assert.equal(projectProgress(w).phase,'repair');
});
test('fresh formatting mismatches request a correction, not an endless identical reread',()=>{
 const w=done();read(w,'good');const p=projectProgress(w);assert.equal(p.phase,'repair');assert.match(p.files[0].detail,/final newline/);assert.equal(p.next.tool,undefined);
});
test('saved repair and expression examples are guidance, not completion or permission',()=>{
 const w=fixture();read(w);append(w,{name:'record_repair_plan',result:{repairs:[{id:'R2.1',path,line:1,before:'bad',after:'good',reason:'Fix observed source.'}]}});
 append(w,{name:'check_repair_expression',result:{repair:'R2.1',sourceRevision:sha('good\n'),examplesMatch:true,caseCount:1,matched:1}});
 let p=projectProgress(w);assert.equal(p.phase,'repair');assert.equal(p.readyToFinish,false);assert.deepEqual(p.next.arguments,{repair:'R2.1'});assert.equal(p.files[0].source,'E1');
 append(w,{name:'check_repair_expression',status:'failed',result:{error:'Missing input'}});assert.deepEqual(projectProgress(w).next.arguments,p.next.arguments);
 append(w,{name:'propose_file_edit',repair:'R2.1',action:'review',status:'waiting_approval'});assert.equal(projectProgress(w).phase,'approval');
});
test('ordinary focused repair offers exact edit review before optional copy exploration',()=>{
 const w=fixture();w.version=19;w.project.checks=[command];read(w);
 append(w,{name:'record_repair_plan',result:{repairs:[{id:'R2.1',path,line:1,before:'bad',after:'good',reason:'Fix observed source.'}]}});
 const next=projectProgress(w).next;assert.equal(next.tool,'propose_repair');assert.deepEqual(next.arguments,{repair:'R2.1'});assert.match(next.message,/No copy-first check is saved/);
 w.goal='Test each proposed repair in a temporary copy before editing.';assert.equal(projectProgress(w).next.tool,undefined);
 w.goal='Repair the source.';
 w.copyBeforeEdit={check:command};assert.equal(projectProgress(w).next.tool,'propose_test_copy');
});
test('current repair feedback narrows repeated reads until the source changes',()=>{
 const w=fixture();w.version=19;const source=read(w);
 append(w,{name:'record_repair_plan',status:'failed',result:{repairFeedback:{issues:[{item:1,path,sourceRevision:source.result.revision,observation:{line:1,text:'good'}}],matchedItems:[]}}});
 assert(!names(w).includes('read_system_file'));assert(!names(w).includes('propose_check'));assert(names(w).includes('record_repair_plan'));
 w.projectToolGroup='files';assert(names(w).includes('read_system_file'));
 w.projectToolGroup='project';read(w,'changed\n');assert(names(w).includes('read_system_file'));assert(names(w).includes('propose_check'));
});
test('a rejected revision retains the exact copy regression in new local guidance',()=>{
 const w=fixture();w.version=25;w.engine='local';w.copyBeforeEdit={check:command};const source=read(w);
 append(w,{name:'record_repair_plan',result:{repairs:[{id:'R2.1',path,revision:source.result.revision,before:'bad',after:'good',line:1,reason:'Fixture correction.'}]}});
 append(w,{name:'propose_test_copy',action:'copy-review',result:{repair:'R2.1',diagnosis:{status:'compared',change:{path,sourceRevision:source.result.revision},resolved:1,newlyFailing:1,changes:[{name:'old case',baseline:'failed',candidate:'passed'},{name:'new edge case',baseline:'passed',candidate:'failed'}]}}});
 append(w,{name:'record_repair_plan',status:'failed',result:{repairFeedback:{matchedItems:[1],issues:[{item:2,path,sourceRevision:source.result.revision,field:'after',code:'unchanged',observation:{line:1,text:'good'}}]}}});
 const before=JSON.stringify(w),p=projectProgress(w);
 assert.equal(p.next.tool,'record_repair_plan');assert.deepEqual(p.copyDiagnosisReview.newlyFailing,{count:1,tests:['new edge case']});assert.deepEqual(p.copyDiagnosisReview.resolved,{count:1,tests:['old case']});
 assert.match(p.next.message,/request_help.*rather than asking the user/);assert.equal(JSON.stringify(w),before);
 const history=[{role:'assistant',content:'',tool_calls:[{function:{name:'record_repair_plan',arguments:{rejectedItems:[{item:2}]}}}]},{role:'tool',tool_name:'record_repair_plan',content:JSON.stringify({evidenceId:'E4',status:'failed',result:w.operations.at(-1).result})}];
 const request=focusedRequest(w,{system:focusedProjectPrompt,history,context:JSON.stringify({goal:'Fix the observed source',scope:'Fixture only',outputRequirements:w.requirements,evidenceForCompletion:[],requirementChecks:[]}),tools:[]}),shown=JSON.parse(request.messages.at(-1).content);
 assert(request.inputBytes<=24000);assert.deepEqual(shown.projectProgress.copyDiagnosisReview.newlyFailing,{count:1,tests:['new edge case']});
 assert.equal(shown.repairFeedback.issues[0].field,'after');assert(!request.messages.some(m=>m.tool_name==='record_repair_plan'));assert.match(shown.contextNotice,/rejected repair-call display was omitted/);
 const ask={function:{name:'ask_user',description:'Ask a question.',parameters:{properties:{}}}};
 assert.match(focusedTools(w,[ask]).find(t=>t.function.name==='ask_user').function.description,/missing user preference/);
 for(const change of [x=>x.version=24,x=>x.engine='chatgpt',x=>x.operations.at(-1).result.repairFeedback.issues[0].sourceRevision='other']){
  const old=structuredClone(w);change(old);assert.equal(projectProgress(old).copyDiagnosisReview,undefined);
 }
});
test('a second required command does not cause a loop reverifying the stale first result',()=>{
 const w=done(),second={...command,args:['--test','other.mjs'],outputIncludes:'pass other'};w.requirements.commands.push(second);
 assert.equal(projectProgress(w).next.arguments.check,'C2');const op=check(w,{command:second,result:{code:0,content:'pass other'}});
 let p=projectProgress(w);assert.equal(p.next.arguments.expected,'pass other');assert(p.checks.every(c=>c.passed));
 append(w,{name:'verify_outcome',result:verifyOutcome(w,{evidence:op.id,kind:'command_output',expected:'pass other'})});read(w);assert.equal(projectProgress(w).readyToFinish,true);
});
test('duplicate successful verifications no longer defeat repeated-read detection',()=>{
 const w=fixture();const c=check(w);verify(w,c);
 for(let i=0;i<6;i++){read(w);verify(w,c);}
 assert.equal(repeatedObservations(w),true);assert.equal(w.operations.filter(o=>o.name==='verify_outcome').length,7,'all receipts remain in the journal');
 check(w);assert.equal(repeatedObservations(w),false,'a new real action still resets the detector');
});
test('passing check handles remain in the finish schema after many later observations',()=>{
 const w=done();for(let i=0;i<12;i++)read(w);
 const refs=Workflows.prototype.completionRefs(w);assert(refs.items.enum.includes('E3'));assert(refs.items.enum.includes('E17'));assert.equal(projectProgress(w).readyToFinish,true);
});
test('a failed saved check requests a new diagnosis after recovery reads, not an unchanged rerun',()=>{
 const w=fixture();write(w);const c=check(w,{result:{code:1,content:'wrong output'}});w.checkRecoveries=[{operation:c.id,paths:[path],command,output:'wrong output'}];
 assert.equal(projectProgress(w).phase,'read');read(w);assert.equal(projectProgress(w).phase,'repair');assert.match(projectProgress(w).next.message,/corrected repair list/);
 write(w);assert.equal(projectProgress(w).phase,'check');
});
test('new project recovery offers only still-missing full reads after a failed check',()=>{
 const w=fixture();w.version=21;read(w);
 const other=['/tmp/project/test.mjs','/tmp/project/helper.mjs','/tmp/project/config.mjs','/tmp/project/package.json'];
 for(const file of other)append(w,{name:'read_system_file',arguments:{path:file},result:{path:file,content:'export {};\n',revision:sha('export {};\n'),truncated:false}});
 const failed=check(w,{status:'failed',result:{code:1,content:'fail 1'}});
 w.checkRecoveries=[{operation:failed.id,paths:[path,...other],command,output:'fail 1'}];
 const readTool=()=>focusedTools(w,tools).find(t=>t.function.name==='read_system_file');
 assert.deepEqual(readTool().function.parameters.properties.path.enum,[path,...other.slice(0,3)]);
 const cloud=structuredClone(w);cloud.engine='chatgpt';
 assert.equal(focusedTools(cloud,tools).find(t=>t.function.name==='read_system_file').function.parameters.properties.path?.enum,undefined);
 assert(names(cloud).includes('propose_check'));
 assert(!names(w).includes('propose_check'));assert(!names(w).includes('record_repair_plan'));assert(!names(w).includes('inspect_source_lines'));
 assert.match(projectProgress(w).next.message,/5 still-missing/);
 read(w);assert.deepEqual(readTool().function.parameters.properties.path.enum,other);
 read(w);assert.deepEqual(readTool().function.parameters.properties.path.enum,other,'a duplicate source read cannot satisfy a missing helper');
 for(const file of other)append(w,{name:'read_system_file',arguments:{path:file},result:{path:file,content:'export {};\n',revision:sha('export {};\n'),truncated:false}});
 assert.equal(projectProgress(w).phase,'repair');assert(names(w).includes('record_repair_plan'));
 w.projectToolGroup='files';assert.equal(focusedTools(w,tools).find(t=>t.function.name==='read_system_file').function.parameters.properties.path?.enum,undefined);
});
test('local failed-check recovery moves from fresh reads to a diagnosis without looping',()=>{
 const w=fixture();w.version=28;w.engine='local';read(w);write(w);
 const failed=check(w,{status:'failed',result:{code:1,content:'fail 2'}}),testPath='/tmp/project/test.mjs';
 w.checkRecoveries=[{operation:failed.id,paths:[path,testPath],command,output:'fail 2'}];
 assert.equal(projectProgress(w).phase,'read');assert(names(w).includes('read_system_file'));
 read(w);assert.equal(projectProgress(w).phase,'read');
 append(w,{name:'read_system_file',arguments:{path:testPath},result:{path:testPath,content:'test source\n',revision:sha('test source\n'),truncated:false}});
 const before=JSON.stringify(w),progress=projectProgress(w);
 assert.equal(progress.phase,'repair');assert.equal(progress.next.tool,'record_repair_plan');assert.match(progress.next.message,/Repeating the same reads/);assert.match(progress.next.message,/request_help.*ask_user/);
 assert(!names(w).includes('read_system_file'));assert(!names(w).includes('inspect_source_lines'));assert(!names(w).includes('propose_check'));assert(names(w).includes('record_repair_plan'));
 const ask={function:{name:'ask_user',description:'Ask a question.',parameters:{properties:{}}}};
 assert.match(focusedTools(w,[ask]).find(t=>t.function.name==='ask_user').function.description,/Do not ask the user to choose an algorithm/);
 assert.equal(JSON.stringify(w),before,'the review guidance is derived without changing the journal');
 const previous=structuredClone(w);previous.version=25;assert(names(previous).includes('read_system_file'));
 const cloud=structuredClone(w);cloud.engine='chatgpt';assert(names(cloud).includes('read_system_file'));
 w.projectToolGroup='files';assert(names(w).includes('read_system_file'),'unobserved dependencies remain discoverable');
 w.projectToolGroup='project';write(w);assert.equal(projectProgress(w).phase,'check');assert(names(w).includes('propose_check'));
});
test('a second copy with unchanged passing tests withdraws a sole unsupported repair',()=>{
 const w=fixture();w.version=27;w.engine='local';w.copyBeforeEdit={check:command};
 const initial='const value=1;\nreturn value;\n',current='const value=2;\nreturn value;\n';
 const first=read(w,initial);
 append(w,{name:'record_repair_plan',result:{repairs:[
  {id:'R1.1',path,line:1,before:'value=1',after:'value=2',reason:'Observed failing case.',revision:first.result.revision},
  {id:'R1.2',path,line:2,before:'return value',after:'return (value)',reason:'Claimed second defect.',revision:first.result.revision},
 ]}});
 append(w,{name:'propose_file_edit',repair:'R1.1',action:'first-write',expected:{path,revision:sha(current)}});read(w,current);
 const copy=append(w,{name:'propose_test_copy',arguments:{repair:'R1.2',check:'C1'},action:'second-copy',result:{kind:'test_copy',repair:'R1.2',diagnosis:{status:'compared',change:{path,sourceRevision:sha(current),candidateRevision:sha(current.replace('return value','return (value)'))},baseline:{counts:{pass:2,fail:0}},candidate:{counts:{pass:2,fail:0}},resolved:0,newlyFailing:0,stillFailing:0,changes:[{name:'one',baseline:'passed',candidate:'passed'},{name:'two',baseline:'passed',candidate:'passed'}]}}});
 const original=JSON.stringify(w),p=projectProgress(w),menu=focusedTools(w,tools);
 assert.equal(p.copyNoBenefitReview.copy,'E'+w.operations.length);assert.equal(p.copyNoBenefitReview.passed,2);
 assert.equal(p.next.tool,'record_repair_plan');assert.deepEqual(p.next.arguments,{repairs:[]});
 assert(!menu.some(t=>t.function.name==='propose_repair'||t.function.name==='read_system_file'||t.function.name==='propose_check'));
 assert.equal(menu.find(t=>t.function.name==='record_repair_plan').function.parameters.properties.repairs.minItems,0);
 assert.throws(()=>proposeRepair(w,{repair:'R1.2'}),/changed no passing saved test outcome/);
 const renamed=structuredClone(w);renamed.operations.find(o=>o.name==='record_repair_plan').result.repairs[1].id='R99.2';
 assert.equal(projectProgress(renamed).copyNoBenefitReview.repair,'R99.2','renaming an identical candidate does not erase its copy result');
 assert.throws(()=>proposeRepair(renamed,{repair:'R99.2'}),/changed no passing saved test outcome/);
 assert.equal(recordRepairPlan(w,{repairs:[]}).repairs.length,0);assert.equal(JSON.stringify(w),original);
 append(w,{name:'record_repair_plan',result:recordRepairPlan(w,{repairs:[]})});
 assert.equal(projectProgress(w).phase,'check');assert(names(w).includes('propose_check'));
 const old=structuredClone(w);old.version=26;old.operations.pop();assert.equal(projectProgress(old).copyNoBenefitReview,undefined);
 const cloud=structuredClone(w);cloud.engine='chatgpt';cloud.operations.pop();assert.equal(projectProgress(cloud).copyNoBenefitReview,undefined);
 const changed=structuredClone(w);changed.operations.pop();changed.operations.find(o=>o.id===copy.id).result.diagnosis.baseline.counts.fail=1;assert.equal(projectProgress(changed).copyNoBenefitReview,undefined);
});
test('retained live input-budget failures fit with the full contract and one diagnostic view',async()=>{
 const cases=JSON.parse(await readFile(new URL('fixtures/project-progress-replays.json',import.meta.url)));
 const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 const style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
 for(const {record:w} of cases){
  const original=JSON.stringify(w),history=wf.executionHistory(w),request=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt,history,context:wf.context(w),tools:wf.toolsFor(w)}),c=JSON.parse(request.messages.at(-1).content);
  assert(request.inputBytes<=24000);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);assert.equal(JSON.stringify(w),original);
  if(c.diagnosticCheck?.output){assert(!request.messages.filter(m=>m.role==='tool').some(m=>JSON.parse(m.content).evidenceId===c.diagnosticCheck.evidence&&JSON.parse(m.content).result.content));assert(c.diagnosticCheck.output.includes('fail'));}
 }
});
test('corrected repair arguments leave the active prompt while the full rejected attempts remain saved',async()=>{
 const cases=JSON.parse(await readFile(new URL('fixtures/project-progress-replays.json',import.meta.url))),w=cases.at(-1).record;
 const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 assert.equal(w.operations.filter(o=>o.name==='record_repair_plan'&&o.status==='failed').length,2);
 const original=JSON.stringify(w);assert(!wf.executionHistory(w).some(m=>m.tool_name==='record_repair_plan'));assert.equal(JSON.stringify(w),original);
 const unresolved=structuredClone(w);unresolved.operations.pop();
 const failures=wf.executionHistory(unresolved).filter(m=>m.tool_name==='record_repair_plan');assert.equal(failures.length,1);assert.equal(JSON.parse(failures[0].content).evidenceId,'E7');
});

test('retained copy-policy failure offers the tested renamed repair within the unchanged input limit',async()=>{
 const sample=JSON.parse(await readFile(new URL('fixtures/copy-gate-replay.json',import.meta.url))),w=structuredClone(sample.record);
 for(const copy of sample.copies){const o=w.operations.find(o=>o.action===copy.id),p=copy.payload;Object.assign(o.result,{candidate:{path:p.candidate.path,beforeRevision:sha(p.candidate.before),revision:sha(p.candidate.content)},check:p.check,sources:p.files.map(({path,revision})=>({path,revision}))});}
 const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),p=projectProgress(w);
 assert.equal(p.next.tool,'propose_repair');assert.equal(p.next.arguments.repair,'R10.1');
 const style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
 const request=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)}),c=JSON.parse(request.messages.at(-1).content);
 assert(request.inputBytes<=24000);assert.equal(c.goal,w.goal);assert.deepEqual(c.outputRequirements,w.requirements);assert.equal(c.copyBeforeEdit.testedRepairs[0].repair,'R10.1');
 assert.deepEqual(c.copyBeforeEdit.testedRepairs[0].runs.map(r=>r.outcome),['assertion_failure','assertion_failure']);
});
