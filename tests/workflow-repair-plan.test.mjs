import test from 'node:test';
import assert from 'node:assert/strict';
import {sha} from '../src/vault.mjs';
import {recordRepairPlan,repairPlanContext,proposeRepair,checkRepairExpression} from '../src/workflow-repair-plan.mjs';
import {focusedTools,focusedRequest,projectInputLimit,selectTools,projectResult} from '../src/workflow-project-context.mjs';
const path='/tmp/project/a.js',source='const a = bad(a,b); const other=1;\n';
const read=(id='read',content=source)=>({id,name:'read_system_file',status:'completed',arguments:{path},result:{path,content,revision:sha(content),truncated:false}});
const fixture=()=>({version:7,revision:1,project:{},requirements:{files:[{path}],commands:[{program:'node'}]},operations:[read()]});
const args=()=>({repairs:[{evidence:'E1',line:1,before:'bad(a,b)',after:'good(a,b)',reason:'Correct the observed operation.'}]});
function savePlan(w){const op={id:'plan',name:'record_repair_plan',revision:1,status:'started'};w.operations.push(op);op.result=recordRepairPlan(w,args());op.status='completed';return op.result.repairs[0].id;}
test('saved repairs are hypotheses; staging preserves surrounding code and requires current evidence',()=>{
 const w=fixture(),id=savePlan(w),original=JSON.stringify(w),patch=proposeRepair(w,{repair:id});
 assert.equal(JSON.stringify(w),original);assert.equal(patch.path,path);assert.equal(patch.revision,sha(source));assert.equal(patch.edits[0].after,'const a = good(a,b); const other=1;\n');
 assert.equal(repairPlanContext(w).repairs[0].state,'remaining');assert.equal(repairPlanContext(w).repairs[0].currentRead,'E1');
 w.operations.push({id:'command',action:'reviewed',name:'propose_command',status:'completed'});
 assert.throws(()=>proposeRepair(w,{repair:id}),/current file/);assert.equal(repairPlanContext(w).repairs[0].needsFreshRead,true);
 w.operations.push(read('fresh'));assert.doesNotThrow(()=>proposeRepair(w,{repair:id}));
 w.operations.push(read('different','const x=1;\n'));assert.throws(()=>proposeRepair(w,{repair:id}),/not present/);
});
test('repair list rejects stale, malformed, duplicate and out-of-scope diagnoses atomically',()=>{
 const w=fixture(),before=JSON.stringify(w);
 for(const a of [{repairs:[]},{repairs:args().repairs,extra:true},{repairs:[...args().repairs,...args().repairs]},{repairs:[{...args().repairs[0],reason:'x'.repeat(601)}]},{repairs:[{...args().repairs[0],before:'invented'}]},{repairs:[{...args().repairs[0],evidence:'E1 line 2 explanation'}]}])assert.throws(()=>recordRepairPlan(w,a));
 assert.equal(JSON.stringify(w),before);w.requirements.files=[];assert.throws(()=>recordRepairPlan(w,args()),/required output/);
 w.requirements.files=[{path}];w.projectCheckpoint={operationCount:1};assert.throws(()=>recordRepairPlan(w,args()),/current file/);
});
test('indented repair feedback directs a retry of the same complete list',()=>{
 const content='  const width=Math.max(a,b);\n',w=fixture();w.version=19;w.operations=[read('indented',content)];
 const item={file:path,line:1,before:'  const width=Math.max(a,b);',after:'  const width=Math.min(a,b);',reason:'Keep width within the available area.'};
 assert.throws(()=>recordRepairPlan(w,{repairs:[item]}),e=>e.repairFeedback?.issues[0]?.code==='indentation'&&/Remove those spaces or tabs.*retry the same repair tool/.test(e.repairFeedback.issues[0].message)&&/omit leading spaces or tabs/.test(e.message));
 assert.equal(w.operations.length,1);
 const saved=recordRepairPlan(w,{repairs:[{...item,before:'Math.max(a,b)',after:'Math.min(a,b)'}]});
 assert.equal(saved.repairs.length,1);assert.equal(saved.repairs[0].before,'Math.max(a,b)');
});
test('new local plans remove only an unchanged preceding source line from a two-line repair',()=>{
 const content='  const stable=1;\n  return bad(value);\n',w=fixture();w.version=30;w.engine='local';w.operations=[read('source',content)];
 const item={file:path,line:2,before:'    const stable=1;\n    return bad(value);',after:'    const stable=1;\n    return good(value);',reason:'The saved test requires good(value).'};
 const unchanged=JSON.stringify(w),saved=recordRepairPlan(w,{repairs:[item]}),repair=saved.repairs[0];
 assert.equal(JSON.stringify(w),unchanged);assert.equal(repair.before,'return bad(value);');assert.equal(repair.after,'return good(value);');assert.equal(repair.inputNormalization.kind,'unchanged_previous_line_removed');
 const op={id:'plan',name:'record_repair_plan',revision:1,status:'completed',result:saved};w.operations.push(op);
 assert.equal(proposeRepair(w,{repair:repair.id}).edits[0].after,'  return good(value);\n');
 const old=fixture();old.version=29;old.engine='local';old.operations=[read('source',content)];
 assert.throws(()=>recordRepairPlan(old,{repairs:[item]}),e=>e.repairFeedback?.issues[0]?.code==='multiple_lines');
 for(const changed of [
  {...item,before:item.before.replace('stable=1','stable=2')},
  {...item,before:item.before.replace('bad(value)','other(value)')},
  {...item,after:item.after.replace('    return','  return')},
 ])assert.throws(()=>recordRepairPlan({...old,version:30},{repairs:[changed]}),e=>e.repairFeedback?.issues[0]?.code==='multiple_lines');
 const cloud={...old,version:30,engine:'chatgpt'};assert.throws(()=>recordRepairPlan(cloud,{repairs:[item]}),e=>e.repairFeedback?.issues[0]?.code==='multiple_lines');
});
test('new local plans reject a removed arrow callback name that remains in its expression',()=>{
 const content='const pending=choices.filter(([id,c])=>decisions[id]?.revision===hash(c)).length;\n',w=fixture();w.version=32;w.engine='local';w.operations=[read('callback',content)];
 const before='filter(([id,c])=>decisions[id]?.revision===hash(c))';
 const item={file:path,line:1,before,after:'filter(([,c])=>!(decisions[id]?.revision===hash(c)))',reason:'Count choices without an exact decision.'};
 const unchanged=JSON.stringify(w);
 assert.throws(()=>recordRepairPlan(w,{repairs:[item]}),e=>e.repairFeedback?.issues[0]?.code==='callback_binding_removed'&&e.repairFeedback.issues[0].removedName==='id');
 assert.equal(JSON.stringify(w),unchanged);
 for(const after of [
  'filter(([id,c])=>!(decisions[id]?.revision===hash(c)))',
  'filter(([key,c])=>!(decisions[key]?.revision===hash(c)))',
  'filter(([,c])=>hash(c))',
 ])assert.equal(recordRepairPlan(w,{repairs:[{...item,after}]}).repairs.length,1);
 const old={...w,version:31},cloud={...w,engine:'chatgpt'};
 assert.equal(recordRepairPlan(old,{repairs:[item]}).repairs.length,1);
 assert.equal(recordRepairPlan(cloud,{repairs:[item]}).repairs.length,1);
 const capacity=fixture();capacity.version=32;capacity.engine='local';capacity.operations=[read('capacity','const occupied=busy.map(([s,e])=>[s,e]);\n')];
 assert.equal(recordRepairPlan(capacity,{repairs:[{file:path,line:1,before:'busy.map(([s,e])=>[s,e])',after:'merge(busy.map(([s,e])=>[s,e]))',reason:'Merge overlapping busy intervals.'}]}).repairs.length,1);
});
test('callback guard ignores later expressions, string text and property names on the same observed line',()=>{
 for(const expression of ['c.ready','c.name==="id"','c.id']){
  const before=`filter(([id,c])=>${expression}).map(id=>id)`;
  const after=`filter(([,c])=>${expression}).map(id=>id)`;
  const w=fixture();w.version=32;w.engine='local';w.operations=[read('chained','const values=choices.'+before+';\n')];
  assert.equal(recordRepairPlan(w,{repairs:[{file:path,line:1,before,after,reason:'Remove the unused callback binding.'}]}).repairs.length,1);
 }
});
test('new local tasks bind a unique adjacent fragment to its observed line and retain the requested line',()=>{
 const content='const marker=1;\nconst width=Math.max(a,b);\nconst footer=2;\n',w=fixture();
 w.version=20;w.engine='ollama';w.operations=[read('adjacent',content)];
 const item={file:path,line:3,before:'Math.max(a,b)',after:'Math.min(a,b)',reason:'Keep width within area.'};
 const saved=recordRepairPlan(w,{repairs:[item]});
 assert.equal(item.line,3);
 assert.equal(saved.repairs[0].line,2);assert.deepEqual(saved.repairs[0].lineCorrection,{requestedLine:3,matchedLine:2});
 assert.equal(saved.repairs[0].revision,sha(content));
 const op={id:'plan',name:'record_repair_plan',revision:1,status:'completed',result:saved};w.operations.push(op);
 const patch=proposeRepair(w,{repair:saved.repairs[0].id});
 assert.equal(patch.edits[0].after,'const width=Math.min(a,b);\n');
 assert.equal(w.operations[0].result.content,content);
 for(const changed of [{...w,version:19},{...w,engine:'chatgpt'}])assert.throws(()=>recordRepairPlan(changed,{repairs:[item]}),e=>e.repairFeedback?.issues[0]?.code==='fragment_absent');
});
test('adjacent correction rejects ambiguous or distant fragments',()=>{
 const item={file:path,line:3,before:'Math.max(a,b)',after:'Math.min(a,b)',reason:'Keep width within area.'};
 for(const content of [
  'const width=Math.max(a,b);\nconst other=2;\nconst footer=3;\n',
  'const width=Math.max(a,b);\nconst width2=Math.max(a,b);\nconst footer=3;\n',
  'const marker=1;\nconst width=Math.max(a,b);\nconst done=Math.min(a,b);\n'
 ]){
  const w=fixture();w.version=20;w.engine='ollama';w.operations=[read('source',content)];
  assert.throws(()=>recordRepairPlan(w,{repairs:[item]}),e=>e.repairFeedback?.issues[0]?.code==='fragment_absent');
 }
});
test('pending and completed repair actions survive serialization without becoming success claims or replaying',()=>{
 let w=fixture();const id=savePlan(w),op={id:'write',name:'propose_file_edit',repair:id,revision:1,action:'action',status:'waiting_approval'};w.operations.push(op);
 assert.equal(repairPlanContext(w).repairs[0].state,'awaiting_action');assert.throws(()=>proposeRepair(w,{repair:id}),/completed or pending/);
 op.status='completed';op.expected={path,revision:sha(source.replace('bad','good'))};w=JSON.parse(JSON.stringify(w));w.projectCheckpoint={operationCount:3};
 assert.equal(repairPlanContext(w).repairs[0].state,'edit_applied');assert.equal(repairPlanContext(w).repairs[0].needsFreshRead,true);assert.throws(()=>proposeRepair(w,{repair:id}),/completed or pending/);
 w.operations.push(read('external','// external\n'));assert.equal(repairPlanContext(w).repairs[0].changedSinceEdit,true);
 w.revision=2;assert.equal(repairPlanContext(w),null,'old diagnoses do not override a changed goal');
});
test('tool menus retain a path to browser, memory and file tools and leave legacy tasks unchanged',()=>{
 const w=fixture(),names=['read_system_file','propose_span_edit','propose_check','computer_action','inspect_desktop','read_note','propose_file_patch','finish_step','ask_user','request_help','verify_outcome'],tools=names.map(name=>({function:{name}}));
 assert(!focusedTools(w,tools).some(t=>t.function.name==='computer_action'));assert(focusedTools(w,tools).some(t=>t.function.name==='select_project_tools'));
 for(const [group,name] of [['desktop','computer_action'],['files','propose_file_patch'],['memory','read_note'],['files','propose_span_edit'],['project','record_repair_plan']]){selectTools(w,{group});assert(focusedTools(w,tools).some(t=>t.function.name===name));}
 assert.throws(()=>selectTools(w,{group:'system'}));assert.throws(()=>selectTools(w,{group:'files',permissions:'all'}));assert.equal(focusedTools({...w,version:6},tools),tools);
});
test('aggregate input budget includes UTF-8 source, tool schemas and history while retaining the full contract',()=>{
 const w=fixture(),c={goal:'Complete ALL requested work',scope:'Only this project',updates:[{instruction:'Keep this latest change'}],outputRequirements:w.requirements,currentStep:{check:'Full acceptance condition'},fileObservations:[{excerpt:'界'.repeat(10000),truncated:false}],memory:['irrelevant'.repeat(9000)]};
 const original=JSON.stringify(c),history=[{role:'tool',tool_name:'read_system_file',content:JSON.stringify({result:{numberedLines:'界'.repeat(10000)}})}];
 const r=focusedRequest(w,{system:'Full skills',history,context:original,tools:[{description:'schema'.repeat(700)}]}),view=JSON.parse(r.messages.at(-1).content);
 assert.equal(r.inputBytes,Buffer.byteLength(JSON.stringify({messages:r.messages,tools:r.tools})));assert(r.inputBytes<=projectInputLimit);assert.deepEqual(view.outputRequirements,c.outputRequirements);assert.deepEqual(view.updates,c.updates);assert.equal(view.goal,c.goal);assert.equal(view.currentStep.check,c.currentStep.check);assert(view.fileObservations[0].truncated);assert.equal(JSON.stringify(c),original);assert.equal(JSON.parse(history[0].content).result.numberedLines.length,10000);
 assert.throws(()=>focusedRequest(w,{system:'skills'.repeat(8000),history:[],context:original,tools:[]}),e=>e.code==='project_input_limit');
 const result=projectResult({content:'x'.repeat(9000),revision:'fixed'});assert(result.truncated);assert(result.content.length<=4500);assert.equal(JSON.parse(JSON.stringify(result)).revision,'fixed');
});
test('repair tools expose source-only references and bind a fresh read without accepting a caller override',()=>{
 const w=fixture();w.operations.push({...read('tests'),result:{...read().result,path:'/tmp/project/test.js'}});
 let tools=focusedTools(w,[]),record=tools.find(t=>t.function.name==='record_repair_plan');assert.deepEqual(record.function.parameters.properties.repairs.items.properties.evidence.enum,['E1']);assert(!tools.some(t=>t.function.name==='propose_repair'));
 const id=savePlan(w);tools=focusedTools(w,[]);assert.deepEqual(tools.find(t=>t.function.name==='propose_repair').function.parameters.properties.repair.enum,[id]);
 assert.throws(()=>proposeRepair(w,{repair:id,evidence:'E2'}),/only the repair/);
 w.operations.push({...read('partial'),arguments:{path,offset:10},result:{...read().result,truncated:true}});assert.equal(repairPlanContext(w).repairs[0].currentRead,null);assert.throws(()=>proposeRepair(w,{repair:id}),/current file/);
});
test('input trimming preserves the newest complete read when shortening older excerpts is sufficient',()=>{
 const w=fixture(),content='a'.repeat(2000),history=[{role:'tool',tool_name:'read_system_file',content:JSON.stringify({result:{numberedLines:content,truncated:false}})}];
 const r=focusedRequest(w,{system:'s'.repeat(1000),history,context:JSON.stringify({goal:'Keep the complete goal',fileObservations:[{excerpt:'b'.repeat(10000),truncated:false}]}),tools:[{description:'t'.repeat(19000)}]});
 const view=JSON.parse(r.messages.find(m=>m.role==='tool').content);assert.equal(view.result.numberedLines,content);assert.equal(view.result.truncated,false);assert(r.inputBytes<=projectInputLimit);assert(JSON.parse(r.messages.at(-1).content).fileObservations[0].truncated);
});
test('resumed prompts withhold historical pass results and point to the saved fresh check',()=>{
 const w=fixture();w.operations.push({id:'check',name:'propose_command',status:'completed',result:{code:0,content:'historical pass sentinel'}});w.projectCheckpoint={id:'checkpoint',operationCount:2};
 const history=[{role:'assistant',tool_calls:[{function:{name:'propose_check'}}]},{role:'tool',content:JSON.stringify({evidenceId:'E2',result:w.operations[1].result})}];
 const context=JSON.stringify({goal:'Keep the whole goal',evidenceForCompletion:[{id:'E1'},{id:'E2'}],savedChecks:[{id:'C1'}],requirementChecks:[{kind:'command',passed:false}]});
 let r=focusedRequest(w,{system:'skills',history,context,tools:[]}),c=JSON.parse(r.messages.at(-1).content);
 assert(!JSON.stringify(r).includes('historical pass sentinel'));assert.deepEqual(c.evidenceForCompletion,[]);assert.equal(c.savedChecks[0].id,'C1');assert.equal(c.savedChecks[0].passed,false);assert.match(c.savedChecks[0].next,/Run this saved check/);assert.equal(w.operations[1].result.content,'historical pass sentinel');assert.equal(history.length,2);
 w.operations[1].executionCheckpoint='checkpoint';r=focusedRequest(w,{system:'skills',history,context,tools:[]});assert(JSON.stringify(r).includes('historical pass sentinel'),'a pending check actually executed after this checkpoint stays current');assert.deepEqual(JSON.parse(r.messages.at(-1).content).evidenceForCompletion,[{id:'E2'}]);
});

function numericPlan(before='Math.max(a,b)',after='Math.min(a,b)'){
 const w=fixture();w.operations=[read('source','const width=Math.max(a,b),height=1;\n')];
 const op={id:'plan',name:'record_repair_plan',revision:1,status:'started'};w.operations.push(op);op.result=recordRepairPlan(w,{repairs:[{evidence:'E1',line:1,before,after,reason:'Keep width within area.'}]});op.status='completed';return w;
}
const exampleArgs=w=>({repair:repairPlanContext(w).repairs[0].id,before:'Math.max(a,b)',after:'Math.min(a,b)',cases:[{inputs:{a:700,b:1280},expected:700},{inputs:{a:460,b:320},expected:320}]});
function saveCheck(w,args){const op={id:'calculation'+w.operations.length,name:'check_repair_expression',revision:1,status:'started'};w.operations.push(op);op.result=checkRepairExpression(w,args);op.status='completed';return op;}
test('expression checks bind the complete saved replacement, allow operator context, and never mutate the task',()=>{
 for(const [before,after] of [['Math.max(a,b)','Math.min(a,b)'],['Math.max','Math.min'],['const width=Math.max(a,b),height=1;','const width=Math.min(a,b),height=1;']]){
  const w=numericPlan(before,after),original=JSON.stringify(w),result=checkRepairExpression(w,exampleArgs(w));assert.equal(JSON.stringify(w),original);assert.equal(result.sourceRevision,w.operations[0].result.revision);assert.equal(result.examplesMatch,true);assert.equal(result.caseCount,2);assert.match(result.notice,/Model-supplied/);
 }
 const w=numericPlan('const width=Math.max(a,b),height=1;','const width=Math.min(a,b),height=2;');assert.throws(()=>checkRepairExpression(w,exampleArgs(w)),/WHOLE saved/);
 for(const change of [{before:'max',after:'min'},{path:'/wrong'},{after:'Math.max(a,b)'},{cases:[{inputs:{a:1,b:2},expected:'x'}]}])assert.throws(()=>checkRepairExpression(numericPlan(),{...exampleArgs(numericPlan()),...change}));
});
test('failed cases cannot be erased by easier examples; results persist but become historical after restart or action',()=>{
 let w=numericPlan(),args=exampleArgs(w);const failArgs={...args,cases:[{inputs:{a:700,b:1280},expected:1280}]};
 saveCheck(w,failArgs);assert.throws(()=>proposeRepair(w,{repair:args.repair}),/failed an expression example/);
 saveCheck(w,args);assert.equal(repairPlanContext(w).repairs[0].expressionCheck.examplesMatch,true);assert.equal(repairPlanContext(w).repairs[0].expressionCheck.hasFailedExamples,true);assert.throws(()=>proposeRepair(w,{repair:args.repair}),/Passing a different/);
 w=JSON.parse(JSON.stringify(w));assert.equal(repairPlanContext(w).repairs[0].expressionCheck.currentSource,true);
 const brief=repairPlanContext(w,{briefChecks:true}).repairs[0].expressionCheck;assert.equal(brief.cases,undefined);assert.equal(brief.matched,2);
 w.projectCheckpoint={operationCount:w.operations.length};assert.equal(repairPlanContext(w).repairs[0].expressionCheck.currentSource,false);assert.throws(()=>checkRepairExpression(w,args),/current file/);
 w.operations.push(read('fresh',w.operations[0].result.content));assert.equal(repairPlanContext(w).repairs[0].expressionCheck.currentSource,true);
 w.operations.push({name:'propose_command',action:'effect',status:'completed'});assert.equal(repairPlanContext(w).repairs[0].expressionCheck.currentSource,false);
 w.revision=2;assert.equal(repairPlanContext(w),null);
});
test('new expression results never mark a saved edit applied and remain absent from legacy tool menus',()=>{
 const w=numericPlan(),args=exampleArgs(w);saveCheck(w,args);assert.equal(repairPlanContext(w).repairs[0].state,'remaining');assert.doesNotThrow(()=>proposeRepair(w,{repair:args.repair}));assert.equal(w.operations.filter(o=>o.action).length,0);
 const tool=focusedTools(w,[]).find(t=>t.function.name==='check_repair_expression');assert.deepEqual(tool.function.parameters.properties.repair.enum,[args.repair]);assert(!focusedTools({...w,version:6},[]).some(t=>t.function.name==='check_repair_expression'));
 w.operations.push({...read('different'),result:{...read().result,content:'const width=Math.max(a,b),height=2;\n',revision:sha('const width=Math.max(a,b),height=2;\n')}});assert.equal(repairPlanContext(w).repairs[0].expressionCheck.currentSource,false);
});
test('missing example inputs cannot become sticky candidate failures or invalidate a correct saved repair',()=>{
 const w=numericPlan(),args=exampleArgs(w),before=JSON.stringify(w);
 assert.throws(()=>checkRepairExpression(w,{...args,cases:[{inputs:{a:700,'scaled.b':1280},expected:700}]}),/missing inputs: b/);assert.equal(JSON.stringify(w),before);assert.equal(repairPlanContext(w).repairs[0].expressionCheck,null);
 saveCheck(w,args);assert.equal(repairPlanContext(w).repairs[0].expressionCheck.hasFailedExamples,false);assert.doesNotThrow(()=>proposeRepair(w,{repair:args.repair}));
});
