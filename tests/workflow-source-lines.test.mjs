import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectSourceLines,currentSourceLines} from '../src/workflow-source-lines.mjs';
import {proseQuestion} from '../src/workflow-prose-question.mjs';
import {sha} from '../src/vault.mjs';
import {repeatedObservations} from '../src/workflow-recovery.mjs';
import {Workflows} from '../src/workflows.mjs';
import {focusedTools,focusedRequest,focusedProjectPrompt,routineProjectPrompt,projectCompletionPrompt,localReadOnlyGroupPrompt} from '../src/workflow-project-context.mjs';
import {createApp} from '../src/server.mjs';
import {characterIdentity,caringCharacter,Character} from '../src/character.mjs';

const path='/tmp/source-lines/project.mjs',content='// α\r\n\tconst value = 1;\r\nexport {value};\r\n';
const read=(text=content)=>({id:'source',revision:1,name:'read_system_file',arguments:{path},status:'completed',result:{path,content:text,revision:sha(text),truncated:false}});
const fixture=()=>({version:16,revision:1,steps:[],current:0,skills:[],project:{},requirements:{files:[{path,lineEndings:'lf',finalNewline:'required'}],commands:[{program:'/usr/bin/node',args:['--test','test.mjs'],cwd:'/tmp/source-lines',outputIncludes:'pass 1'}]},operations:[read()]});
const args={evidence:'E1',startLine:2,count:1};
test('numbered source inspection preserves literal whitespace and the complete snapshot without a fresh read',()=>{
 const w=fixture(),before=JSON.stringify(w),r=inspectSourceLines(w,args);
 assert.equal(r.numberedLines,'2: \tconst value = 1;');assert.equal(r.nextLine,3);assert.equal(r.totalLines,3);assert.equal(r.snapshotOnly,true);assert.equal(r.displayExcerpted,true);assert.equal(r.revision,sha(content));assert.equal(JSON.stringify(w),before);
 const op={name:'inspect_source_lines',status:'completed',result:r};assert(currentSourceLines(w,op));
 w.operations.push({...read(),id:'newer'});assert(!currentSourceLines(w,op),'even an equal newer read supersedes this view');
});
test('partial, redacted, stale, failed, superseded and historical source cannot be revived by inspection',()=>{
 for(const change of [w=>w.version=15,w=>w.operations[0].result.truncated=true,w=>w.operations[0].result.revision='redacted',w=>w.operations[0].arguments.offset=1,w=>w.operations[0].status='failed',w=>w.projectCheckpoint={id:'restart',operationCount:1},w=>w.operations.push({action:'check',name:'propose_command',status:'completed'}),w=>w.operations.push({...read(),id:'failed',status:'failed',result:{error:'missing'}})]){
  const w=fixture();change(w);assert.throws(()=>inspectSourceLines(w,args),/latest complete/);
 }
 for(const input of [{...args,startLine:0},{...args,startLine:4},{...args,count:41},{...args,count:1.5},{...args,evidence:path},{...args,path}])assert.throws(()=>inspectSourceLines(fixture(),input));
});
test('line views are bounded in UTF-8 bytes and never return half a line',()=>{
 const w=fixture();w.operations=[read(Array.from({length:40},()=> 'α'.repeat(90)).join('\n'))];
 const r=inspectSourceLines(w,{...args,startLine:1,count:40});assert(Buffer.byteLength(r.numberedLines)<=2400);assert(r.endLine<40);assert.equal(r.nextLine,r.endLine+1);assert(r.numberedLines.split('\n').every(l=>l.endsWith('α'.repeat(90))));
 w.operations=[read('x'.repeat(2500))];assert.throws(()=>inspectSourceLines(w,{...args,startLine:1}),/exceeds/);
});
test('new local workflows bound an oversized line request and expose the continuation',()=>{
 const w=fixture();w.version=23;w.engine='ollama';w.operations=[read(Array.from({length:80},(_,i)=>`const line${i+1} = ${i+1};`).join('\n'))];
 const before=JSON.stringify(w),r=inspectSourceLines(w,{evidence:'E1',startLine:1,count:60});
 assert.equal(r.requestedCount,60);assert.equal(r.countLimitedTo,40);assert.equal(r.endLine,40);assert.equal(r.nextLine,41);
 assert.equal(r.numberedLines,inspectSourceLines(w,{evidence:'E1',startLine:1,count:40}).numberedLines);
 assert.match(r.notice,/limited to 40.*nextLine/);assert(Buffer.byteLength(r.numberedLines)<=2400);assert.equal(JSON.stringify(w),before);
 for(const change of [x=>x.version=22,x=>x.engine='chatgpt']){const old=structuredClone(w);change(old);assert.throws(()=>inspectSourceLines(old,{evidence:'E1',startLine:1,count:60}),/1 to 40/);}
 for(const count of [0,1.5,121,'60'])assert.throws(()=>inspectSourceLines(w,{evidence:'E1',startLine:1,count}),/1 to 40/);
});
test('inspection is unavailable in old task menus, excluded from completion and stale active history',()=>{
 const w=fixture(),wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 assert(focusedTools(w,[]).some(t=>t.function.name==='inspect_source_lines'));assert(!focusedTools({...w,version:15},[]).some(t=>t.function.name==='inspect_source_lines'));
 const view={id:'view',revision:1,name:'inspect_source_lines',arguments:args,status:'completed',result:inspectSourceLines(w,args)};w.operations.push(view);
 assert(!wf.completionRefs(w).items.enum.includes('E2'));assert(!JSON.parse(wf.context(w)).evidenceForCompletion.some(o=>o.id==='E2'));
 w.operations.push({id:'command',name:'propose_command',action:'check',status:'completed',result:{code:0,content:'pass 1'}});
 const input=focusedRequest(w,{system:focusedProjectPrompt+routineProjectPrompt,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)});assert(!input.messages.some(m=>m.tool_name==='inspect_source_lines'));assert.equal(w.operations[1],view);
});
test('repeating the same cached lines still reaches the observation guard',()=>{
 const w=fixture();for(let i=0;i<6;i++)w.operations.push({id:'v'+i,name:'inspect_source_lines',status:'completed',result:inspectSourceLines(w,args)});
 assert(repeatedObservations(w));assert.equal(repeatedObservations({...w,version:15}),false);
});
test('only a complete bounded closing question becomes a pause, with the exact text retained',()=>{
 const text="The source adds values.\n```js\nreturn total + used;\n```\nWould you like the subtraction prepared?";
 assert.equal(proseQuestion(text),text);assert.equal(proseQuestion('Which behavior should remain？'),'Which behavior should remain？');
 const choices='Which file should I read?\n\n- first.txt\n- second.txt';assert.equal(proseQuestion(choices),choices);
 assert.equal(proseQuestion('Which file should I read?\n\n1. first.txt\n2. second.txt'),'Which file should I read?\n\n1. first.txt\n2. second.txt');
 for(const value of ['',null,'Why? The cause is addition.','```text\nA question inside code?','~~~\nA quoted code question?',('a'.repeat(1000)+'?')])assert.equal(proseQuestion(value),null);
 assert.equal(proseQuestion('Which file?\nThis paragraph is an answer.'),null);
});

const call=(name,arguments_)=>({tool_calls:[{function:{name,arguments:arguments_}}]});
const until=async fn=>{for(let i=0;i<600;i++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,10));}throw Error('Source fixture timeout');};
async function appFixture(t,respond){
 const dir=await mkdtemp(join(tmpdir(),'aurora-lines-')),root=join(dir,'project');await mkdir(root);const path=join(root,'value.mjs');await writeFile(path,'// Source\nexport const value = 1;\n');await writeFile(join(root,'test.mjs'),'// fixture only\n');
 let app,calls=0,reads=0;const model={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[]}),chat:async messages=>{calls++;return respond({root,path,calls,w:(await app.store.list('workflows'))[0],context:JSON.parse(messages.at(-1).content)});}};
 app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backup'),projects:[],embedding:'',ollamaClient:model,workflowOptions:{pollMs:10}});
 t.after(async()=>{await app.workflows.close();app.server.emit('close');await rm(dir,{recursive:true,force:true});});
 const original=app.assistant.runTool.bind(app.assistant);app.assistant.runTool=async(...args)=>{if(args[0].function.name==='read_system_file')reads++;return original(...args);};
 const notePath='20 Projects/Lines.md';await app.vault.save(notePath,'# Lines\n',null);const project=await app.projectWorkspaces.save({name:'Lines',notePath,folders:[root],checks:[{name:'Tests',program:'node',args:['--test','test.mjs'],cwd:root,outputIncludes:'pass 1'}]});
 const w=await app.workflows.start({goal:'Inspect source and discuss the needed correction before execution.',projectId:project.id,projectRevision:project.revision,projectCheckNames:['Tests'],requirements:{files:[{path,lineEndings:'lf',finalNewline:'required'}],commands:[]}});
 const wait=status=>until(async()=>{const s=await app.store.get('workflows',w.id);return s.status===status&&!app.workflows.running.has(w.id)?s:null;});
 await wait('plan_review');await app.workflows.control(w.id,'approve_plan','',w.revision);
 return {app,path,w,wait,get reads(){return reads;}};
}
test('real runner journals source inspection, then pauses on prose without extra inference or actions',async t=>{
 const question='The observed value is 1. Should I prepare a change to 2?';
 const f=await appFixture(t,({path,calls,w})=>calls===1?call('read_system_file',{path}):calls===2?call('inspect_source_lines',{evidence:'E1',startLine:2,count:1}):{content:question});
 const w=await f.wait('waiting_input');assert.equal(w.calls,3);assert.equal(f.reads,1);assert.equal(w.question,question);assert.equal(w.operations[1].result.numberedLines,'2: export const value = 1;');assert.equal(w.operations.at(-1).questionSource,'model prose');assert.equal(w.operations.at(-1).name,'ask_user');assert.equal((await f.app.store.list('actions')).length,0);assert(!w.toolContinuations);
});
test('real local runner records an oversized inspection as a bounded view',async t=>{
 const question='The source value is 1. Should I prepare a correction?';
 const f=await appFixture(t,({path,calls})=>calls===1?call('read_system_file',{path}):calls===2?call('inspect_source_lines',{evidence:'E1',startLine:1,count:60}):{content:question});
 const w=await f.wait('waiting_input'),view=w.operations[1];
 assert.equal(w.version,36);assert.equal(w.calls,3);assert.equal(f.reads,1);assert.equal(view.status,'completed');
 assert.equal(view.arguments.count,60);assert.equal(view.result.countLimitedTo,40);assert.equal(view.result.requestedCount,60);
 assert.equal(view.result.totalLines,2);assert.equal(view.result.nextLine,null);assert.equal((await f.app.store.list('actions')).length,0);
});
test('a cached view cannot finish a task or bypass fresh source approval',async t=>{
 const f=await appFixture(t,({path,calls,w})=>{
  if(calls===1)return call('read_system_file',{path});
  if(calls===2)return call('inspect_source_lines',{evidence:'E1',startLine:2,count:1});
  if(calls===3)return call('finish_step',{summary:'Claim from a cached view.',evidence:['E2']});
  if(calls===4){assert.match(w.operations.at(-1).result.error,/not successful observations/);return call('record_repair_plan',{repairs:[{file:path,line:2,before:'value = 1',after:'value = 2',reason:'Requested candidate.'}]});}
  return call('propose_repair',{repair:'R4.1'});
 });
 const w=await f.wait('waiting_approval'),a=await f.app.store.get('actions',w.operations.at(-1).action);assert.equal(a.kind,'write');assert.equal(f.reads,1);
 await writeFile(f.path,'// External change\nexport const value = 3;\n');await f.app.actions.decide(a.id,'approve',a.digest);const failed=await until(async()=>{const x=await f.app.store.get('actions',a.id);return x.status==='failed'&&!f.app.actions.running.has(a.id)?x:null;});assert.match(JSON.stringify(failed.result),/changed|current|read/i);assert.equal(await readFile(f.path,'utf8'),'// External change\nexport const value = 3;\n');
});


test('real discussion-first replies become exact questions and the long-source replay keeps its contract',async()=>{
 const {cases}=JSON.parse(await readFile(new URL('fixtures/project-scope-replays.json',import.meta.url)));
 const discussion=cases.find(c=>c.id==='discuss');const replies=discussion.replies.filter(r=>!r.tool_calls?.length);
 assert.equal(replies.length,3);for(const r of replies)assert.equal(proseQuestion(r.content),r.content.trim());
 const w=structuredClone(cases.find(c=>c.id==='catalog').record);w.version=16;w.current=0;w.operations=w.operations.slice(0,2);
 const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),before=JSON.stringify(w);
 const input=focusedRequest(w,{system:focusedProjectPrompt+routineProjectPrompt,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)}),c=JSON.parse(input.messages.at(-1).content);
 assert(input.inputBytes<=24000);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);assert.equal(JSON.stringify(w),before);
 const result=inspectSourceLines(w,{evidence:'E1',startLine:78,count:6});assert.match(result.numberedLines,/const start = \(page \+ 1\) \* size/);assert.equal(result.snapshotOnly,true);
});

test('the new inspection menu fits the retained two-file repair context with the full persona',async()=>{
 const {cases}=JSON.parse(await readFile(new URL('fixtures/routine-continuation-replays.json',import.meta.url))),w=cases.find(c=>c.id==='layout').record;w.version=16;
 const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}}),style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
 const request=focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt+routineProjectPrompt,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)}),c=JSON.parse(request.messages.at(-1).content);
 assert(request.inputBytes<=24000);assert.equal(c.goal,w.goal);assert.deepEqual(c.outputRequirements,w.requirements);assert(request.tools.some(t=>t.function.name==='inspect_source_lines'));
});

test('rereading the same snapshot cannot reset the repeated-line guard by changing evidence handles',()=>{
 const w=fixture();
 for(let i=0;i<6;i++){
  const fresh={...read(),id:'fresh-'+i};w.operations.push(fresh);
  const result=inspectSourceLines(w,{...args,evidence:'E'+w.operations.length});
  w.operations.push({id:'view-'+i,name:'inspect_source_lines',status:'completed',result});
 }
 assert(repeatedObservations(w));
});

test('retained line-view overflow fits without dropping the task contract, newest range or saved repair',async()=>{
 const {cases}=JSON.parse(await readFile(new URL('fixtures/project-scope-recovery-replays.json',import.meta.url))),{record:w,system}=cases.find(c=>c.id==='inspection_context_limit'),before=JSON.stringify(w);
 const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 const request=focusedRequest(w,{system,history:wf.executionHistory(w),context:wf.context(w),tools:wf.toolsFor(w)}),c=JSON.parse(request.messages.at(-1).content);
 assert(request.inputBytes<=24000);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);assert.deepEqual(c.updates,w.updates||[]);assert.equal(c.repairPlan.repairs.length,1);
 const views=request.messages.filter(m=>m.tool_name==='inspect_source_lines');assert.equal(views.length,1);
 const view=JSON.parse(views[0].content);assert.equal(view.evidenceId,'E4');assert.match(view.result.numberedLines,/80:   const start = \(page \+ 1\) \* size;/);assert.match(c.contextNotice,/Older cached line views/);assert.equal(JSON.stringify(w),before);
 assert(request.messages.some(m=>m.tool_name==='read_system_file'&&m.content.includes('other helpers unchanged')),'the current small test source remains readable');
});

test('post-copy local prompt retains the failing test comparison and repair line within the input budget',async()=>{
 const {record:w}=JSON.parse(await readFile(new URL('fixtures/focus-review-input-limit-replay.json',import.meta.url))),before=JSON.stringify(w);
 const wf=Object.assign(Object.create(Workflows.prototype),{assistant:{projects:{items:[]}}});
 const style=(await Character.prototype.prompt.call({read:async()=>({body:caringCharacter})})).slice(0,1800);
 const system=characterIdentity+style+'\n'+focusedProjectPrompt+projectCompletionPrompt+localReadOnlyGroupPrompt;
 const build=record=>focusedRequest(record,{system,history:wf.executionHistory(record),context:wf.context(record),tools:wf.toolsFor(record)});
 const old=structuredClone(w);old.version=27;assert.throws(()=>build(old),/input budget/,'the saved version 27 state exceeded the budget');
 const request=build(w),c=JSON.parse(request.messages.at(-1).content),views=request.messages.filter(m=>m.tool_name==='inspect_source_lines');
 assert(request.inputBytes<=24000);assert.equal(c.goal,w.goal);assert.equal(c.scope,w.scope);assert.deepEqual(c.outputRequirements,w.requirements);
 assert.equal(views.length,1);const view=JSON.parse(views[0].content);assert.equal(view.result.displayExcerpted,true);assert.match(view.result.numberedLines,/19: .*pending:/);
 const copy=request.messages.find(m=>m.tool_name==='propose_test_copy');assert(copy);const d=JSON.parse(copy.content).result.diagnosis;assert.equal(d.resolved,1);assert.equal(d.stillFailing,3);assert.equal(d.displaySummary,true);assert.equal(d.tests.length,5);assert.match(d.failure.output.text,/unreviewed focus choices/);
 assert.equal(JSON.stringify(w),before,'display compaction leaves the saved journal intact');
});
