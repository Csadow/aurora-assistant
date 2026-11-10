import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {combinedDraftRepair,repairDraft} from '../src/workflow-tools.mjs';
import {sha} from '../src/vault.mjs';
import {createApp} from '../src/server.mjs';
const quote='Catalog price is 110 credits.';
const state=()=>({revision:1,requirements:{files:[{path:'/work/note.md',finalNewline:'required',lineEndings:'lf',requiredText:[quote,'](source.md)']}]},operations:[{id:'source',name:'read_system_file',status:'completed',revision:1,arguments:{path:'/work/source.md'},result:{path:'/work/source.md',content:quote,revision:sha(quote)}},{id:'draft',name:'propose_file_edit',status:'failed',revision:1,arguments:{path:'/work/note.md',content:'Keep the uncertainty (source.md).',reason:'Requested note'},result:{requirementFailures:['Missing quote and link']}}]});
test('combined repair fixes eligible links and missing quotes together without rewriting the original body',()=>{
 const w=state(),r=repairDraft(w,{draft:'E2',reason:'Restore required sources'});assert.equal(r.changes.length,1);assert.equal(r.quotes.length,1);assert.deepEqual(r.remainingFailures,[]);assert(r.arguments.content.startsWith('Keep the uncertainty [source.md](source.md).\n\n'));assert(r.arguments.content.includes('> '+quote));assert.equal(w.operations[1].arguments.content,'Keep the uncertainty (source.md).');
});
test('combined repair cannot override requirements, target a stale draft, or conceal remaining failures',()=>{
 const w=state(),args={draft:'E2',reason:'Repair'};assert.throws(()=>repairDraft(w,{...args,path:'/elsewhere'}));assert.throws(()=>repairDraft(w,{...args,content:'Replacement'}));assert.throws(()=>repairDraft(w,{...args,draft:'E1'}));assert.throws(()=>repairDraft({...w,revision:2},args));w.requirements.files[0].requiredText.push('Unsupported mandatory fact.');assert.match(combinedDraftRepair(w).remainingFailures.join(' '),/Unsupported mandatory fact/);w.operations[1].action='pending';assert.equal(combinedDraftRepair(w),null);
});
test('combined recovery remains available for formatting-only corrections without inventing source material',()=>{
 const w=state();w.requirements.files[0].requiredText=[];w.operations[1].arguments.content='Keep this paragraph.';const r=repairDraft(w,{draft:'E2',reason:'Final newline'});assert.equal(r.arguments.content,'Keep this paragraph.\n');assert.equal(r.changes.length+r.quotes.length,0);
});
const call=(name,args)=>({content:'',tool_calls:[{function:{name,arguments:args}}]});
const wait=async fn=>{const until=Date.now()+5000;while(Date.now()<until){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,10));}throw Error('Combined repair fixture timed out');};
for(const missing of [false,true])test(missing?'a remaining unsupported fact blocks approval after combined repair':'observed calculation and one combined repair reach exact approval and durable readback',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-comparison-')),source=join(dir,'source.md'),limit=join(dir,'limit.md'),path=join(dir,'note.md'),budget='The budget ceiling is 120 credits.';await writeFile(source,quote);await writeFile(limit,budget);await writeFile(path,'Original note');let repaired=false,compared=false;
 const client={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,tools,_s,_c,options)=>{
  if(options?.format?.properties.steps){assert.equal(options.format.properties.steps.maxItems,1);return {content:JSON.stringify({steps:[{title:'Compare and write',check:'Read the saved note.'}]})};}const c=JSON.parse(m.at(-1).content),last=c.recentEvidence.map(JSON.parse).at(-1);
  if(!last)return call('read_system_file',{path:source});if(last.name==='read_system_file'&&last.result.path===source)return call('read_system_file',{path:limit});
  if(last.name==='read_system_file'&&last.result.path===limit){assert(tools.some(t=>t.function.name==='compare_source_values'));return call('compare_source_values',{left:c.sourceValues.find(v=>v.source===source).id,right:c.sourceValues.find(v=>v.source===limit).id});}
  if(last.name==='compare_source_values'){assert(m.some(message=>message.role==='tool'&&message.tool_name==='compare_source_values'));assert(c.sourceArithmetic.comparisons.some(x=>x.expression==='120 > 110'));assert.equal(last.result.expression,'110 < 120');assert.equal(c.sourceComparisons[0].needsFreshRead,false);compared=true;return call('propose_file_edit',{path,content:'110 < 120\nKeep the uncertainty (source.md).',reason:'Draft'});}
  if(last.status==='failed'&&!repaired){assert(c.repairableDraft.availableRepair);assert(tools.some(t=>t.function.name==='propose_draft_repair'));assert(!tools.some(t=>['propose_citation_repair','propose_required_quotes'].includes(t.function.name)));assert.equal(c.repairableDraft.availableRepair.remainingFailures.length,missing?1:0);repaired=true;return call(c.repairableDraft.availableRepair.tool,c.repairableDraft.availableRepair.arguments);}
  if(last.status==='failed')return call('request_help',{question:'The remaining required fact has no source. How should I proceed?',reason:'Missing evidence'});
  if(last.name==='propose_file_edit')return call('read_system_file',{path});return call('finish_step',{summary:'Read the approved note.',evidence:c.evidenceForCompletion.map(e=>e.id)});
 }};
 const f=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:client,workflowOptions:{pollMs:10,segmentMs:10000}});
 t.after(async()=>{await f.workflows.close();f.actions.stopAll();await wait(()=>!f.actions.running.size);await rm(dir,{recursive:true,force:true});});
 const w=await f.workflows.start({goal:'Compare the source price with its limit and preserve uncertainty.',requirements:{files:[{path,requiredText:[quote,budget,'](source.md)','](limit.md)',...(missing?['Unsupported mandatory fact.']:[])],lineEndings:'lf',finalNewline:'required'}],commands:[]}});await wait(async()=>{const x=await f.workflows.read(w.id);return x.status==='plan_review'&&!f.workflows.running.has(w.id);});await f.workflows.control(w.id,'approve_plan','',w.revision);
 const ready=await wait(async()=>{const x=await f.workflows.read(w.id);return !f.workflows.running.has(w.id)&&['waiting_approval','needs_help'].includes(x.status)&&x;});assert(compared&&repaired);assert.equal(await readFile(path,'utf8'),'Original note');const op=ready.operations.find(o=>o.requestedTool==='propose_draft_repair');assert.equal(op.sourceExcerpts.length,2);assert.equal(op.citationRepairs.length,1);assert.equal(op.sourceCalculations[0].expression,'120 > 110');const actions=await f.store.list('actions');
 if(missing){assert.equal(actions.length,0);assert(op.result.requirementFailures);assert.equal(ready.status,'needs_help');return;}
 assert.equal(actions.length,1);const a=actions[0];assert(a.payload.content.startsWith('110 < 120\nKeep the uncertainty [source.md](source.md).'));await f.actions.decide(a.id,'approve',a.digest);await wait(async()=>(await f.workflows.read(w.id)).status==='completed');assert.equal(await readFile(path,'utf8'),a.payload.content);assert.equal(await readFile(source,'utf8'),quote);assert.equal(await readFile(limit,'utf8'),budget);
});

for(const existing of [false,true])test(existing?'reading an existing output after a rejected draft observes its old content':'reading a missing output after a rejected draft explains that it was not saved',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-rejected-output-')),source=join(dir,'source.md'),path=join(dir,'output.md');await writeFile(source,'Exact source sentence.\n');if(existing)await writeFile(path,'Old saved content.\n');
 const client={model:'fixture',check:async()=>{},chat:async(messages,_tools,_signal,_chunk,options)=>{
  if(options?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Save a sourced note',check:'Save and read the required output.'}]})};
  const context=JSON.parse(messages.at(-1).content),last=context.recentEvidence.map(JSON.parse).at(-1);
  if(!last)return call('read_system_file',{path:source});
  if(last.name==='read_system_file'&&last.result?.path===source)return call('propose_file_edit',{path,content:'Draft without the exact quote.\n',reason:'Requested sourced note'});
  if(last.name==='propose_file_edit')return call('read_system_file',{path});
  return call('request_help',{question:'Review the current output state.',reason:'Fixture reached the output observation.'});
 }};
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:client,workflowOptions:{pollMs:10,segmentMs:10000}});
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 const started=await app.workflows.start({goal:'Read the source and save its exact sentence.',requirements:{files:[{path,requiredText:['Exact source sentence.'],finalNewline:'required',lineEndings:'lf'}],commands:[]}});
 await wait(async()=>{const w=await app.workflows.read(started.id);return w.status==='plan_review'&&!app.workflows.running.has(w.id);});await app.workflows.control(started.id,'approve_plan','',started.revision);
 const w=await wait(async()=>{const value=await app.workflows.read(started.id);return value.status==='needs_help'&&!app.workflows.running.has(value.id)&&value;});
 const read=w.operations.findLast(o=>o.name==='read_system_file'&&o.arguments.path===path);assert(read);
 if(existing){assert.equal(read.status,'completed');assert.equal(read.result.content,'Old saved content.\n');}
 else{assert.equal(read.status,'failed');assert.match(read.result.error,/rejected draft was not saved/);}
 assert.equal((await app.store.list('actions')).length,0);
});

test('a declared output missing before its first write does not consume the ordinary failure streak',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-missing-output-')),path=join(dir,'output.md');
 const client={model:'fixture',check:async()=>{},chat:async(messages,_tools,_signal,_chunk,options)=>{
  if(options?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Save the required note',check:'Read back the saved output.'}]})};
  const c=JSON.parse(messages.at(-1).content),n=c.recentEvidence.length;
  if(n<2)return call('read_system_file',{path});
  if(n===2)return call('propose_formatted_file',{path,content:'Incomplete.\n',reason:'First draft missing required text'});
  if(n===3)return call('propose_formatted_file',{path,content:'Required fact.\n',reason:'Correct the exact output'});
  if(n===4)return call('read_system_file',{path});
  return call('finish_step',{summary:'The required output was read back.',evidence:c.evidenceForCompletion.map(e=>e.id)});
 }};
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:client,workflowOptions:{pollMs:10,segmentMs:10000}});
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 const started=await app.workflows.start({goal:'Create an output note containing Required fact.',requirements:{files:[{path,requiredText:['Required fact.'],finalNewline:'required',lineEndings:'lf'}],commands:[]}});
 assert.equal(started.version,36);await wait(async()=>{const w=await app.workflows.read(started.id);return w.status==='plan_review'&&!app.workflows.running.has(w.id);});
 await app.workflows.control(started.id,'approve_plan','',started.revision);
 const ready=await wait(async()=>{const w=await app.workflows.read(started.id);return w.status==='waiting_approval'&&!app.workflows.running.has(w.id)&&w;});
 assert.deepEqual(ready.operations.slice(0,3).map(o=>o.status),['failed','failed','failed']);
 assert(ready.operations[0].result.expectedMissingOutput&&ready.operations[1].result.expectedMissingOutput);
 assert.match(ready.operations[0].result.error,/does not exist yet.*before reading it back/);
 assert.match(ready.operations[2].result.error,/Missing required text/);
 assert.equal(ready.operations[3].status,'waiting_approval');assert.equal((await app.store.list('actions')).length,1);
 await assert.rejects(async()=>app.workflows.checkObservationProgress({version:36,operations:ready.operations.slice(0,2).concat(ready.operations[0]),requirementRetryStart:0}),/Three reads found declared output files still missing/);
 const action=await app.store.get('actions',ready.operations[3].action);await app.actions.decide(action.id,'approve',action.digest);
 await wait(async()=>(await app.workflows.read(started.id)).status==='completed');assert.equal(await readFile(path,'utf8'),'Required fact.\n');
});
