import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {sha} from '../src/vault.mjs';
import {readGroupArguments,runReadGroup} from '../src/workflow-read-group.mjs';
import {Workflows} from '../src/workflows.mjs';
import {focusedTools,focusedRequest,focusedProjectPrompt,projectCompletionPrompt} from '../src/workflow-project-context.mjs';
import {projectProgress} from '../src/workflow-project-progress.mjs';
import {recordRepairPlan} from '../src/workflow-repair-plan.mjs';
import {checkpointProject} from '../src/workflow-checkpoint.mjs';
import {observationNeedsFreshRead} from '../src/workflow-tools.mjs';
import {characterIdentity,caringCharacter,Character} from '../src/character.mjs';

const call=(name,args)=>({function:{name,arguments:args}}),read=path=>call('read_system_file',{path});
const until=async fn=>{const end=Date.now()+7000;while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,10));}throw Error('Group fixture timed out');};
async function fixture(t,respond){
 const dir=await mkdtemp(join(tmpdir(),'aurora-read-group-')),root=join(dir,'project');await mkdir(root);
 for(const [name,text] of Object.entries({'a.mjs':'export const a=1;\n','b.mjs':'export const b=2;\n','test.mjs':'// fixture\n'}))await writeFile(join(root,name),text);
 const requests=[];const model={model:'fixture',generationOptions:{think:false},check:async()=>{},status:async()=>({online:true,models:[]}),chat:async(messages,tools,signal,_stream,options)=>{requests.push({messages,tools,options});return respond({messages,tools,signal,options,root,turn:requests.length});}};
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:model,workflowOptions:{pollMs:10,segmentMs:10000}});
 t.after(async()=>{await app.workflows.close();app.server.emit('close');await rm(dir,{recursive:true,force:true});});
 await app.vault.save('20 Projects/Read fixture.md','# Read fixture\n',null);
 const project=await app.projectWorkspaces.save({name:'Read fixture',notePath:'20 Projects/Read fixture.md',folders:[root],checks:[{name:'Tests',program:'node',args:['--test','test.mjs'],cwd:root,outputIncludes:'pass 1'}]});
 const w=await app.workflows.start({goal:'Inspect the two output files and complete the requested project task.',projectId:project.id,projectRevision:project.revision,projectCheckNames:['Tests'],requirements:{files:['a.mjs','b.mjs'].map(p=>({path:join(root,p),lineEndings:'lf',finalNewline:'required'})),commands:[]}});
 await until(async()=>{const s=await app.store.get('workflows',w.id);return s.status==='plan_review'&&!app.workflows.running.has(w.id);});
 await app.workflows.control(w.id,'approve_plan','',w.revision);
 const wait=async status=>until(async()=>{const s=await app.store.get('workflows',w.id);return s.status===status&&!app.workflows.running.has(w.id)?s:null;});
 return {app,root,requests,w,wait};
}

test('group validation rejects mixed actions, duplicate paths, malformed arguments and budget excess before any call',()=>{
 const valid=[read('/tmp/a'),{function:{name:'read_system_file',arguments:'{"path":"/tmp/b","offset":2}'}}];
 assert.deepEqual(readGroupArguments(valid,2),[{path:'/tmp/a'},{path:'/tmp/b',offset:2}]);
 for(const calls of [[...valid,call('propose_check',{check:'C1'})],[read('/tmp/a'),read('/tmp/./a')],Array.from({length:5},(_,i)=>read('/tmp/'+i)),[read('/tmp/a'),call('read_system_file',{path:'/tmp/b',offset:-1})],[read('/tmp/a'),call('read_system_file',{path:'/tmp/b',limit:999999})],[read('/tmp/a'),read('relative')],[read('/tmp/a'),call('read_system_file','bad json')]])assert.throws(()=>readGroupArguments(calls,72),/No calls ran/);
 assert.throws(()=>readGroupArguments(valid,1),/operation budget/);
});

test('one model turn records both real file reads with separate evidence; genuine questions still pause',async t=>{
 const f=await fixture(t,({root,turn})=>turn===1?{tool_calls:[read(join(root,'a.mjs')),read(join(root,'b.mjs'))]}:{tool_calls:[call('ask_user',{question:'Which additional output behavior should the project support?'})]});
 const w=await f.wait('waiting_input');assert.equal(w.calls,2);assert.equal(w.operations.length,3);
 assert.equal(w.question,'Which additional output behavior should the project support?');
 const first=w.operations.slice(0,2);assert(first.every(o=>o.status==='completed'&&o.result.revision===sha(o.result.content)));assert.equal(first[0].readGroup.id,first[1].readGroup.id);assert.notEqual(first[0].id,first[1].id);
 assert.deepEqual(projectProgress(w).files.map(f=>f.source),['E1','E2']);assert.equal((await f.app.store.list('actions')).length,0);
 checkpointProject(w,'restart');assert(projectProgress(w).files.every(f=>f.source===null),'group evidence becomes historical at restart');
});

test('new local tasks group one current line view with a different file read, each with separate evidence',async t=>{
 const view=call('inspect_source_lines',{evidence:'E1',startLine:1,count:60});
 const f=await fixture(t,({root,turn})=>turn===1?{tool_calls:[read(join(root,'a.mjs'))]}:turn===2?{tool_calls:[read(join(root,'b.mjs')),view]}:{tool_calls:[call('ask_user',{question:'Which additional behavior is needed?'})]});
 const w=await f.wait('waiting_input');assert.equal(w.version,33);assert.equal(w.engine,'local');assert.equal(w.calls,3);
 assert.deepEqual(w.operations.map(o=>o.name),['read_system_file','read_system_file','inspect_source_lines','ask_user']);
 const [first,second,inspection]=w.operations;assert(first.status==='completed'&&second.status==='completed'&&inspection.status==='completed');
 assert.equal(second.readGroup.id,inspection.readGroup.id);assert.notEqual(second.id,inspection.id);
 assert.equal(inspection.result.sourceEvidence,'E1');assert.equal(inspection.result.requestedCount,60);assert.equal(inspection.result.countLimitedTo,40);
 assert.equal(inspection.result.snapshotOnly,true);assert.equal((await f.app.store.list('actions')).length,0);
 assert.deepEqual(readGroupArguments([read(join(f.root,'b.mjs')),view],72,w),[{path:join(f.root,'b.mjs')},{evidence:'E1',startLine:1,count:60}]);
 for(const change of [x=>x.version=23,x=>x.engine='chatgpt']){const old=structuredClone(w);change(old);assert.throws(()=>readGroupArguments([read(join(f.root,'b.mjs')),view],72,old),/No calls ran/);}
 for(const invalid of [[read(join(f.root,'a.mjs')),view],[read(join(f.root,'b.mjs')),call('inspect_source_lines',{evidence:'E99',startLine:1,count:2})],[read(join(f.root,'b.mjs')),view,view],[read(join(f.root,'b.mjs')),view,call('propose_check',{check:'C1'})]])assert.throws(()=>readGroupArguments(invalid,72,w),/No calls ran/);
});

test('a failed read in a mixed group never runs its later cached line view',async t=>{
 const f=await fixture(t,({root,turn})=>turn===1?{tool_calls:[read(join(root,'a.mjs'))]}:turn===2?{tool_calls:[read(join(root,'missing.mjs')),call('inspect_source_lines',{evidence:'E1',startLine:1,count:2})]}:{tool_calls:[call('request_help',{reason:'Missing source',question:'Where is missing.mjs?'})]});
 const w=await f.wait('needs_help');assert.deepEqual(w.operations.map(o=>o.name),['read_system_file','read_system_file','request_help']);
 assert.equal(w.operations[1].status,'failed');assert.match(w.operations[1].result.error,/Path not found/);
 assert.equal((await f.app.store.list('actions')).length,0);
});

test('a failed scoped read stops the group without observing the remaining file or bypassing system access',async t=>{
 const f=await fixture(t,({root,turn})=>turn===1?{tool_calls:[read(join(root,'a.mjs')),read(join(root,'missing.mjs')),read(join(root,'b.mjs'))]}:{tool_calls:[call('request_help',{reason:'Missing source',question:'Where is missing.mjs?'})]});
 const w=await f.wait('needs_help'),reads=w.operations.filter(o=>o.name==='read_system_file');assert.equal(reads.length,2);assert.equal(reads[0].status,'completed');assert.equal(reads[1].status,'failed');assert.match(reads[1].result.error,/Path not found/);assert.equal(reads[1].readGroup.total,3);
 assert(!w.operations.some(o=>o.result?.path===join(f.root,'b.mjs')));
});

test('mixed tool replies execute nothing and their rejection is returned to the model',async t=>{
 const f=await fixture(t,({root,turn,messages})=>{
  if(turn===1)return {tool_calls:[read(join(root,'a.mjs')),call('propose_file_edit',{path:join(root,'a.mjs'),content:'bad',reason:'Invalid mixed reply'})]};
  assert(messages.some(m=>m.role==='tool'&&m.content.includes('No calls ran')));
  return {tool_calls:[call('ask_user',{question:'Which behavior is intended?'})]};
 });
 const w=await f.wait('waiting_input');assert.equal(w.operations[0].name,'read_file_group');assert.equal(w.operations[0].status,'failed');assert.equal((await f.app.store.list('actions')).length,0);assert.equal(await readFile(join(f.root,'a.mjs'),'utf8'),'export const a=1;\n');
});

test('incomplete project prose gets bounded tool continuation without an unnecessary completion-model call',async t=>{
 const f=await fixture(t,({turn,root,options})=>{
  assert(!options?.format,'no completion assessment while requirements are incomplete');
  if(turn===1)return {tool_calls:[read(join(root,'a.mjs')),read(join(root,'b.mjs'))]};
  if(turn===2)return {content:'The work is complete.'};
  return {tool_calls:[call('ask_user',{question:'Which additional result is required?'})]};
 });
 const w=await f.wait('waiting_input');assert.equal(w.calls,3);assert.equal(w.toolContinuations.length,1);assert.equal(w.toolContinuations[0].draft,'The work is complete.');assert(!w.operations.some(o=>o.name==='finish_step'));assert.equal(w.steps[0].status,'running');
});

test('interruption preserves only attempted reads and group operations cannot exceed the task limit',async()=>{
 const w={id:'task',revision:1,operations:[]},controller=new AbortController();let calls=0;
 const service={save:async()=>{},assistant:{runTool:async c=>{calls++;const content='read';if(calls===2)controller.abort(new Error('stop'));return {path:c.function.arguments.path,content,revision:sha(content)};}}};
 await assert.rejects(runReadGroup(service,w,{id:'step'},[read('/tmp/a'),read('/tmp/b'),read('/tmp/c')],controller.signal),/stop/);
 assert.deepEqual(w.operations.map(o=>o.status),['completed','started']);assert.equal(calls,2);
 const restored=JSON.parse(JSON.stringify(w));await Workflows.prototype.reconcile.call({store:{list:async()=>[]}},restored);
 assert.deepEqual(restored.operations.map(o=>o.status),['completed','interrupted']);assert.equal(calls,2,'reconciliation cannot repeat reads or invent the unattempted third read');
 const bounded={id:'task',revision:1,operations:Array.from({length:71},()=>({status:'completed'}))};
 await runReadGroup(service,bounded,{id:'step'},[read('/tmp/a'),read('/tmp/b')],new AbortController().signal);
 assert.equal(bounded.operations.length,72);assert.equal(bounded.operations.at(-1).status,'failed');assert.equal(calls,2);
});

test('repeated invalid groups still stop at the existing failure limit',async t=>{
 const f=await fixture(t,({root})=>({tool_calls:[read(join(root,'a.mjs')),call('propose_check',{check:'C1',reason:'Invalid mixed reply'})]}));
 const w=await f.wait('needs_help');assert.equal(w.calls,3);assert.equal(w.operations.length,3);assert(w.operations.every(o=>o.status==='failed'));assert.equal((await f.app.store.list('actions')).length,0);
});

test('group reads honor target guards and retain normal truncation and source freshness',async()=>{
 const w={id:'task',revision:1,version:14,operations:[]};let reads=0;
 const service={save:async()=>{},projectWorkspaces:{target:async(_project,path)=>{if(path==='/outside')throw new Error('Outside project');}},assistant:{runTool:async c=>{reads++;return {path:c.function.arguments.path,content:'excerpt',revision:sha('complete source'),truncated:true,nextOffset:7};}}};
 await runReadGroup(service,w,{id:'step'},[read('/tmp/a'),read('/outside'),read('/tmp/b')],new AbortController().signal);
 assert.equal(reads,1);assert.equal(w.operations.length,2);assert.equal(w.operations[0].result.truncated,true);assert.equal(w.operations[1].status,'failed');
 w.operations.push({action:'edit',name:'propose_file_edit',status:'completed',expected:{path:'/tmp/a'}});assert(observationNeedsFreshRead(w,0,'/tmp/a'));
});

test('captured 1.42 failures retain full goals and requirements while final checks take priority in new tasks',async()=>{
 const samples=JSON.parse(await readFile(new URL('fixtures/task-completion-replays.json',import.meta.url))),wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 for(const sample of samples.cases){
  const w=structuredClone(sample.record);w.version=14;
  const input=focusedRequest(w,{system:focusedProjectPrompt+projectCompletionPrompt,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)}),context=JSON.parse(input.messages.at(-1).content);
  assert(input.inputBytes<=24000);assert.equal(context.goal,w.goal);assert.deepEqual(context.outputRequirements,w.requirements);
  for(const reply of sample.replies)if(reply.tool_calls.length>1)assert.equal(readGroupArguments(reply.tool_calls,72).length,reply.tool_calls.length);
  if(sample.id==='layout'){
   assert.equal(projectProgress(w).phase,'check');const names=input.tools.map(t=>t.function.name);assert(names.includes('propose_check'));assert(!names.includes('read_system_file'));assert(names.includes('ask_user'));assert(names.includes('request_help'));
   w.projectToolGroup='files';assert(wf.toolsFor(w).some(t=>t.function.name==='read_system_file'),'uncovered issues remain investigable');
   w.projectToolGroup='project';w.version=13;assert(wf.toolsFor(w).some(t=>t.function.name==='read_system_file'),'legacy menu unchanged');
  }
 }
});

test('a rejected pre-plan copy points to the saved repair and does not invite repeated project reads',async()=>{
 const {record:sample}=JSON.parse(await readFile(new URL('fixtures/focus-copy-before-plan-replay.json',import.meta.url)));
 const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 const w=structuredClone(sample);w.version=29;
 const progress=projectProgress(w);assert.equal(progress.next.tool,'record_repair_plan');
 const input=focusedRequest(w,{system:focusedProjectPrompt+projectCompletionPrompt,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)});
 assert(input.inputBytes<=24000);
 const names=input.tools.map(t=>t.function.name);assert(names.includes('record_repair_plan'));assert(names.includes('inspect_source_lines'));assert(!names.includes('read_system_file'));assert(!names.includes('propose_test_copy'));assert(!names.includes('propose_check'));
 assert.equal(JSON.parse(input.messages.at(-1).content).projectProgress.next.tool,'record_repair_plan');
 const old=structuredClone(sample);assert.equal(projectProgress(old).phase,'inspect');assert(wf.toolsFor(old).some(t=>t.function.name==='read_system_file'));
 w.projectToolGroup='files';assert(wf.toolsFor(w).some(t=>t.function.name==='read_system_file'));
});

test('supporting test repair feedback names allowed source outputs without extending edit scope',async()=>{
 const {record:sample}=JSON.parse(await readFile(new URL('fixtures/focus-copy-before-plan-replay.json',import.meta.url)));
 const w=structuredClone(sample);w.version=31;
 const testPath=w.operations[1].result.path,output=w.requirements.files[0].path;
 const candidate={repairs:[{file:testPath,line:1,before:'wrong',after:'different',reason:'Test helper diagnosis.'}]};
 let failure;try{recordRepairPlan(w,candidate);}catch(e){failure=e;}
 assert.equal(failure?.repairFeedback?.issues[0]?.code,'output_file');
 assert.deepEqual(failure.repairFeedback.issues[0].allowedOutputFiles,[output]);
 w.operations.push({id:'bad-plan',name:'record_repair_plan',revision:w.revision,status:'failed',arguments:candidate,result:{error:failure.message,repairFeedback:failure.repairFeedback}});
 const progress=projectProgress(w);assert.equal(progress.next.tool,'record_repair_plan');assert.match(progress.next.message,/supporting test/);
 const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 const input=focusedRequest(w,{system:focusedProjectPrompt+projectCompletionPrompt,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)});
 assert(input.inputBytes<=24000);assert(input.tools.some(t=>t.function.name==='record_repair_plan'));assert(!input.tools.some(t=>t.function.name==='read_system_file'));assert(!input.tools.some(t=>t.function.name==='propose_check'));
 w.projectToolGroup='files';assert(wf.toolsFor(w).some(t=>t.function.name==='read_system_file'));
 const older=structuredClone(sample);older.version=30;
 assert.throws(()=>recordRepairPlan(older,candidate),e=>e.repairFeedback?.issues[0]?.allowedOutputFiles===undefined);
});

test('retained chat-approval stall identifies the exact review tool without approving or suppressing a question',async()=>{
 const sample=JSON.parse(await readFile(new URL('fixtures/approval-route-replay.json',import.meta.url))),w=sample.record;
 const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),before=JSON.stringify(w);
 const input=focusedRequest(w,{system:focusedProjectPrompt+projectCompletionPrompt,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)}),context=JSON.parse(input.messages.at(-1).content);
 assert.deepEqual({tool:context.actionReview.tool,arguments:context.actionReview.arguments},{tool:'propose_test_copy',arguments:{repair:'R5.1',check:'C1'}});
 assert(input.tools.some(t=>t.function.name==='ask_user'));assert(!input.tools.some(t=>t.function.name==='finish_step'));assert.equal(JSON.stringify(w),before);assert.equal(w.status,'waiting_input');assert(input.inputBytes<=24000);
 assert.equal(context.goal,w.goal);assert.deepEqual(context.outputRequirements,w.requirements);assert.match(context.actionReview.instruction,/Execution waits for approval/);
});

test('retained completion recovery failures fit the unchanged input budget with the full persona and task contract',async()=>{
 const samples=JSON.parse(await readFile(new URL('fixtures/completion-recovery-replays.json',import.meta.url))),wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 const style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
 for(const {record:w} of samples.cases){
  const before=JSON.stringify(w),input=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt+projectCompletionPrompt,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)}),context=JSON.parse(input.messages.at(-1).content);
  assert(input.inputBytes<=24000);assert.equal(context.goal,w.goal);assert.equal(context.scope,w.scope);assert.deepEqual(context.outputRequirements,w.requirements);assert.equal(JSON.stringify(w),before);
 }
});
