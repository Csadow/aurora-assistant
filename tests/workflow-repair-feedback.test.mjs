import test from 'node:test';
import assert from 'node:assert/strict';
import {sha} from '../src/vault.mjs';
import {spanEdit} from '../src/workflow-span.mjs';
import {recordRepairPlan,repairPlanContext,repairFeedback,proposeRepair} from '../src/workflow-repair-plan.mjs';
import {focusedTools,focusedRequest,focusedProjectPrompt} from '../src/workflow-project-context.mjs';
import {projectProgress} from '../src/workflow-project-progress.mjs';
import {readFile} from 'node:fs/promises';

const path='/tmp/project/code.mjs',other='/tmp/project/other.mjs',source='const width=Math.max(a,b),height=1;\nreturn {width:width+left+right};\n';
const read=(id='source',file=path,content=source)=>({id,name:'read_system_file',status:'completed',arguments:{path:file},result:{path:file,content,revision:sha(content),truncated:false}});
const fixture=()=>({version:8,revision:1,project:{},requirements:{files:[{path},{path:other}],commands:[{program:'node'}]},operations:[read(),read('tests','/tmp/project/test.mjs','assert(width===700);\n')]});
const item=()=>({file:path,line:1,before:'Math.max(a,b)',after:'Math.min(a,b)',reason:'Bound the requested width.'});
const args=()=>({repairs:[item(),{file:path,line:2,before:'width+left+right',after:'width-left-right',reason:'Subtract reserved margins.'}]});
function record(w,a){const op={id:'plan'+w.operations.length,name:'record_repair_plan',revision:w.revision,status:'started',arguments:a};w.operations.push(op);try{op.result=recordRepairPlan(w,a);op.status='completed';}catch(e){op.result={error:e.message,repairFeedback:e.repairFeedback};op.status='failed';}return op;}

test('new repair lists bind the selected output file to its latest read, never a supporting test',()=>{
 const w=fixture(),before=JSON.stringify(w),r=recordRepairPlan(w,args());assert.equal(JSON.stringify(w),before);assert(r.repairs.every(x=>x.path===path&&x.evidence==='E1'&&x.binding==='required_file'));
 const tool=focusedTools(w,[]).find(t=>t.function.name==='record_repair_plan'),schema=tool.function.parameters.properties.repairs.items;
 assert.deepEqual(schema.properties.file.enum,[path,other]);assert(!schema.properties.evidence);assert(schema.required.includes('file'));assert(!schema.required.includes('evidence'));
 for(const override of [{file:'/tmp/project/test.mjs'},{file:'code.mjs'},{file:path+'/../code.mjs'},{evidence:'E2'},{file:other}]){
  assert.throws(()=>recordRepairPlan(w,{repairs:[{...item(),...override}]}),e=>e.repairFeedback.issues.length===1);
 }
 w.operations.push(read('new'));assert.equal(recordRepairPlan(w,args()).repairs[0].evidence,'E3');
});
test('local JSON-encoded repair arrays use the same source and scope guards without rewriting model arguments',()=>{
 const w={...fixture(),version:19,engine:'local'},encoded=JSON.stringify(args().repairs),input={repairs:encoded},before=JSON.stringify(w);
 const saved=recordRepairPlan(w,input);assert.equal(saved.inputEncoding,'json_string');assert.equal(saved.repairs.length,2);assert.equal(input.repairs,encoded);assert.equal(JSON.stringify(w),before);assert(!w.operations.some(o=>o.action));
 for(const invalid of ['{broken}',JSON.stringify({repairs:args().repairs}),JSON.stringify([{...item(),file:'/tmp/other.mjs'}]),JSON.stringify([{...item(),after:'multiline\nchange'}]),'x'.repeat(16001)])assert.throws(()=>recordRepairPlan(w,{repairs:invalid}));
 assert.throws(()=>recordRepairPlan({...w,engine:'chatgpt'},input));assert.throws(()=>recordRepairPlan({...w,version:18},input));
});
test('binding refuses stale, failed and partial latest reads without falling back to an earlier source',()=>{
 for(const latest of [{...read('failed'),status:'failed',result:{error:'unreadable'}},{...read('partial'),arguments:{path,offset:10}},{...read('truncated'),result:{...read().result,truncated:true}},{...read('redacted'),result:{...read().result,revision:'wrong'}}]){
  const w=fixture();w.operations.push(latest);assert.throws(()=>recordRepairPlan(w,args()),e=>e.repairFeedback.issues.every(x=>x.code==='incomplete_source'));
 }
 const w=fixture();w.projectCheckpoint={id:'restart',operationCount:2};assert.throws(()=>recordRepairPlan(w,args()),e=>e.repairFeedback.issues.every(x=>x.code==='stale_source'));w.operations.push(read('fresh'));assert.doesNotThrow(()=>recordRepairPlan(w,args()));
});
test('field feedback distinguishes multiline replacement, no-op, line type and reversed fragments without rewriting them',()=>{
 const w=fixture(),base={evidence:'E1',...item()};delete base.file;
 for(const [change,field,code] of [[{after:'x\ny'},'after','multiple_lines'],[{before:'x\ry'},'before','multiple_lines'],[{after:base.before},'after','unchanged'],[{line:'1'},'line','positive_integer'],[{reason:''},'reason','reason_required']])assert.throws(()=>spanEdit(w,{...base,...change}),e=>e.repairIssue.field===field&&e.repairIssue.code===code);
 assert.throws(()=>spanEdit(w,{...base,before:'Math.min(a,b)',after:'Math.max(a,b)'}),e=>e.repairIssue.code==='fragment_absent'&&/reversed/.test(e.message)&&e.repairIssue.observation.text===source.split('\n')[0]);
 assert.throws(()=>spanEdit(w,{...base,line:2}),e=>e.repairIssue.matchingLines[0]===1);
});
test('a bad list reports source-matched siblings atomically and preserves the prior list and applied effects',()=>{
 const w=fixture(),saved=record(w,args()),id=saved.result.repairs[0].id;
 w.operations.push({id:'write',name:'propose_file_edit',status:'completed',revision:1,repair:id,action:'exact',expected:{path,revision:sha(source.replace('Math.max','Math.min'))}});
 w.operations.push(read('fresh',path,source.replace('Math.max','Math.min')));
 const bad={repairs:[{...args().repairs[1]},{...args().repairs[1],after:'const x=1;\nreturn x;'}]};
 const rejected=record(w,bad);assert.equal(rejected.status,'failed');assert.deepEqual(rejected.result.repairFeedback.matchedItems,[1]);assert.equal(rejected.result.repairFeedback.issues[0].field,'after');assert.equal(repairPlanContext(w).evidence,'E3');assert.equal(repairPlanContext(w).repairs[0].state,'edit_applied');assert.throws(()=>proposeRepair(w,{repair:id}),/completed or pending/);
 assert.equal(projectProgress(w).phase,'repair');assert.match(projectProgress(w).next.message,/repairFeedback/);assert.equal(w.operations.filter(o=>o.action).length,1);
 record(w,{repairs:[args().repairs[1]]});assert.equal(repairFeedback(w),null);assert.equal(w.operations.find(o=>o.id===rejected.id).result.repairFeedback.issues.length,1);
});
test('feedback snapshots survive restart, become historical, and never silently change a source target',()=>{
 let w=fixture();record(w,{repairs:[{...item(),after:'x\ny'}]});assert.equal(repairFeedback(w).issues[0].currentSource,true);
 w=JSON.parse(JSON.stringify(w));w.projectCheckpoint={id:'restart',operationCount:w.operations.length};assert.equal(repairFeedback(w).issues[0].currentSource,false);
 w.operations.push(read('fresh'));assert.equal(repairFeedback(w).issues[0].currentSource,true);w.operations.push(read('changed',path,'different\n'));assert.equal(repairFeedback(w).issues[0].currentSource,false);
 w.revision++;assert.equal(repairFeedback(w),null);assert.equal(w.operations.length,5);
});
test('syntactically valid wrong diagnoses are not labelled correct by source binding',()=>{
 const w=fixture();w.operations=[read('source',path,'const margins=value||[0,0,0,0];\n')];
 const r=record(w,{repairs:[{file:path,line:1,before:'[0,0,0,0]',after:'[10,30,10,20]',reason:'An incorrect diagnosis from a retained live trial.'}]});
 assert.equal(r.status,'completed');assert.equal(repairPlanContext(w).repairs[0].state,'remaining');assert.match(r.result.notice,/does not establish coverage/);assert(!w.operations.some(o=>o.action));
});
test('older tasks retain evidence-based repair arguments and reject the new file contract',()=>{
 const w={...fixture(),version:7},old={...item(),evidence:'E1'};delete old.file;assert.doesNotThrow(()=>recordRepairPlan(w,{repairs:[old]}));assert.throws(()=>recordRepairPlan(w,args()));
 const schema=focusedTools(w,[]).find(t=>t.function.name==='record_repair_plan').function.parameters.properties.repairs.items;assert(schema.properties.evidence);assert(!schema.properties.file);
});
test('current repair feedback is included once in the bounded prompt with the full task contract',()=>{
 const w=fixture(),failed=record(w,{repairs:[item(),{...args().repairs[1],after:'x\ny'}]}),feedback=failed.result.repairFeedback;
 const history=[{role:'tool',tool_name:'record_repair_plan',content:JSON.stringify({evidenceId:'E3',result:failed.result})}],context=JSON.stringify({goal:'Preserve the whole requested task',outputRequirements:w.requirements});
 const request=focusedRequest(w,{system:focusedProjectPrompt,history,context,tools:focusedTools(w,[])}),c=JSON.parse(request.messages.at(-1).content);
 assert.equal(c.repairFeedback.evidence,'E3');assert(!c.repairFeedback.issues);assert.equal(c.goal,'Preserve the whole requested task');assert.deepEqual(c.outputRequirements,w.requirements);assert.equal(JSON.stringify(request).split('contains a line break').length-1,1);assert(request.inputBytes<=24000);assert.deepEqual(feedback.matchedItems,[1]);
});
test('checkpoint context retains full historical feedback when its old tool exchange is withheld',()=>{
 const w=fixture(),op=record(w,{repairs:[{...item(),after:'x\ny'}]});w.projectCheckpoint={operationCount:3,id:'checkpoint'};
 const history=[{role:'assistant',tool_calls:[{function:{name:'record_repair_plan',arguments:op.arguments}}]},{role:'tool',tool_name:'record_repair_plan',content:JSON.stringify({evidenceId:'E3',result:op.result})}];
 const request=focusedRequest(w,{system:focusedProjectPrompt,history,context:JSON.stringify({goal:'Keep the goal'}),tools:focusedTools(w,[])}),c=JSON.parse(request.messages.at(-1).content);
 assert(!request.messages.some(m=>m.role==='tool'));assert.equal(c.repairFeedback.issues[0].field,'after');assert.equal(c.repairFeedback.issues[0].currentSource,false);assert(c.repairFeedback.issues[0].observation.text.includes('Math.max'));assert.equal(c.goal,'Keep the goal');
});
test('retained live malformed, reversed and wrong-source proposals get specific feedback without blessing a wrong diagnosis',async()=>{
 const cases=JSON.parse(await readFile(new URL('fixtures/repair-feedback-replays.json',import.meta.url)));
 for(const c of cases){
  const w={version:8,revision:1,project:{},requirements:c.requirements,operations:c.reads},before=JSON.stringify(w);
  if(c.expected==='source_match_only'){const r=recordRepairPlan(w,c.arguments);assert.match(r.notice,/hypotheses|diagnoses/);assert(r.repairs.every(x=>x.binding==='required_file'));}
  else assert.throws(()=>recordRepairPlan(w,c.arguments),e=>e.repairFeedback.issues.some(i=>i.field===c.expected.field&&i.code===c.expected.code),c.name);
  assert.equal(JSON.stringify(w),before,c.name+' performed no action');
 }
});
