import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sourceQuoteDraft} from '../src/workflow-source-quotes.mjs';
import {requiredQuoteTool,repairRequiredQuotes} from '../src/workflow-tools.mjs';
import {createApp} from '../src/server.mjs';
import {sha} from '../src/vault.mjs';
const literal='The quoted value is 140 credits.';
const source={path:'/project/source.md',content:literal,evidence:'source',revision:sha(literal),after:'[Source](source.md)'};
const input={path:'/project/note.md',content:'The price remains unresolved.',reason:'Research note'};
const state=()=>({revision:1,requirements:{files:[{path:input.path,finalNewline:'required',lineEndings:'lf',requiredText:[literal,'](source.md)']}]},operations:[{id:'source',name:'read_system_file',status:'completed',revision:1,arguments:{path:source.path},result:{path:source.path,content:source.content,revision:source.revision}},{id:'draft',name:'propose_file_edit',status:'failed',revision:1,arguments:input,result:{requirementFailures:['Missing exact quote.']}}]});
test('required excerpt appendix preserves the entire draft and records exact source bytes',()=>{
 const r=sourceQuoteDraft(input,[literal], [source]);assert.equal(r.arguments.content,input.content+'\n\n## Required source excerpts\n\n> '+literal+'\n\n[Source](source.md)\n');assert.equal(r.quotes[0].sourceRevision,source.revision);assert.equal(r.quotes[0].sourceEvidence,'source');assert.equal(input.content,'The price remains unresolved.');assert.equal(r.arguments.reason,input.reason);
});
test('unobserved, ambiguous, already present and non-excerpt requirements are not synthesized',()=>{
 for(const [args,required,sources] of [[input,['A missing unsupported sentence.'],[source]],[input,[literal],[source,{...source,path:'/other/source.md'}]],[{...input,content:literal},[literal],[source]],[input,['price'],[{...source,content:'price'}]],[input,['line\nbreak'],[{...source,content:'line\nbreak'}]]])assert.equal(sourceQuoteDraft(args,required,sources).quotes.length,0);
 assert.equal(sourceQuoteDraft(input,[literal,literal],[source]).quotes.length,1);
});
test('quote recovery is limited to the latest rejected draft and fresh, complete, explicit source reads',()=>{
 const args={draft:'E2',reason:'Restore required quotation'},w=state();assert.equal(requiredQuoteTool(w).length,1);assert.equal(repairRequiredQuotes(w,args).quotes.length,1);
 for(const change of [x=>x.revision=2,x=>x.requirements.files[0].exactText='exact',x=>x.requirements.files[0].requiredText=[literal],x=>x.operations[0].result.truncated=true,x=>x.operations[0].result.revision='redacted',x=>x.operations[0].status='failed',x=>x.operations[1].action='pending',x=>x.operations.push({name:'propose_command',action:'ran',status:'completed'})]){const copy=state();change(copy);assert.equal(requiredQuoteTool(copy).length,0);assert.throws(()=>repairRequiredQuotes(copy,args));}
 assert.throws(()=>repairRequiredQuotes(w,{...args,content:'override'}));assert.throws(()=>repairRequiredQuotes(w,{...args,reason:''}));w.operations.push({...w.operations[1],id:'new'});assert.throws(()=>repairRequiredQuotes(w,args));
});
const call=(name,args)=>({content:'',tool_calls:[{function:{name,arguments:args}}]});
const wait=async fn=>{const end=Date.now()+5000;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,10));}throw Error('Quote recovery fixture timed out');};
for(const extraMissing of [false,true])test(extraMissing?'quote recovery keeps unrelated requirements enforced without creating an approval':'quote recovery stages exact approval, preserves existing prose, and verifies the saved note',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-quotes-')),sourcePath=join(dir,'source.md'),path=join(dir,'note.md');await writeFile(sourcePath,literal);await writeFile(path,'Original file');
 let offered=false,attempted=false;
 const client={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,tools,_s,_c,opts)=>{
  if(opts?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Sourced note',check:'Read back the exact saved note.'}]})};const c=JSON.parse(m.at(-1).content),last=c.recentEvidence.map(JSON.parse).at(-1);
  if(!last)return call('read_system_file',{path:sourcePath});
  if(last.name==='read_system_file'&&last.result.path===sourcePath)return call('propose_formatted_file',{path,content:input.content+' [Source](source.md)',reason:'Draft'});
  if(last.status==='failed'&&!attempted){assert(c.repairableDraft.requiredSourceExcerpts.some(q=>q.text===literal));offered=tools.some(x=>x.function.name==='propose_draft_repair');attempted=true;return call('propose_required_quotes',{draft:c.repairableDraft.evidence,reason:'Append required source wording'});}
  if(last.status==='failed')return call('request_help',{reason:'Unrelated requirement remains unsatisfied.'});
  if(last.name==='propose_file_edit')return call('read_system_file',{path});return call('finish_step',{summary:'Verified the saved note.',evidence:c.evidenceForCompletion.map(x=>x.id)});
 }};
 const f=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:client,workflowOptions:{pollMs:10,segmentMs:10000}});
 t.after(async()=>{await f.workflows.close();f.actions.stopAll();await wait(()=>!f.actions.running.size);await rm(dir,{recursive:true,force:true});});
 const w=await f.workflows.start({goal:'Sourced note',requirements:{files:[{path,requiredText:[literal,'](source.md)',...(extraMissing?['Unobserved required sentence.']:[])],finalNewline:'required',lineEndings:'lf'}],commands:[]}});
 await wait(async()=>{const x=await f.workflows.read(w.id);return x.status==='plan_review'&&!f.workflows.running.has(w.id);});await f.workflows.control(w.id,'approve_plan','',w.revision);
 await wait(async()=>{const x=await f.workflows.read(w.id);return !f.workflows.running.has(w.id)&&['waiting_approval','needs_help'].includes(x.status);});assert(offered);assert.equal(await readFile(path,'utf8'),'Original file');
 const record=await f.workflows.read(w.id),op=record.operations.find(o=>o.requestedTool==='propose_required_quotes');assert.equal(op.sourceExcerpts[0].text,literal);assert.equal(op.sourceExcerpts[0].sourceRevision,sha(literal));
 const actions=await f.store.list('actions');if(extraMissing){assert.equal(actions.length,0);assert.equal(record.status,'needs_help');assert(op.result.requirementFailures);return;}
 assert.equal(actions.length,1);const a=actions[0];assert(a.payload.content.startsWith(input.content+' [Source](source.md)'));assert(a.payload.content.includes('> '+literal));await f.actions.decide(a.id,'approve',a.digest);await wait(async()=>(await f.workflows.read(w.id)).status==='completed');assert.equal(await readFile(path,'utf8'),a.payload.content);assert.equal(await readFile(sourcePath,'utf8'),literal);
});
