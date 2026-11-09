import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {citationDraft} from '../src/workflow-citations.mjs';
import {sha} from '../src/vault.mjs';
import {repairCitations,citationRepairTool} from '../src/workflow-tools.mjs';
import {createApp} from '../src/server.mjs';
const state=()=>({revision:1,requirements:{files:[{path:'/project/note.md',finalNewline:'required',lineEndings:'lf',requiredText:['](source.md)']}]},operations:[{id:'source',name:'read_system_file',revision:1,status:'completed',arguments:{path:'/project/source.md'},result:{path:'/project/source.md',content:'A supported observation.',revision:sha('A supported observation.')}}]});
const draft=content=>({path:'/project/note.md',content,reason:'User output'});
test('explicit local link checks repair existing markers while preserving other text and source receipts',()=>{
 const w=state(),original=JSON.stringify(w),input=draft('Price is disputed (source.md).\n\n[[source.md]] and [](source.md).\nKeep 110 and 140 unresolved.\n'),r=citationDraft(w,input);
 assert.equal(r.arguments.content,'Price is disputed [source.md](source.md).\n\n[source.md](source.md) and [source.md](source.md).\nKeep 110 and 140 unresolved.\n');assert.equal(r.changes.length,3);assert(r.changes.every(c=>c.source==='/project/source.md'&&c.sourceRevision===w.operations[0].result.revision));assert.equal(JSON.stringify(w),original);assert.equal(input.content.includes('[[source.md]]'),true);
});
test('an explicit full link preserves its requested label; competing labels need an explicit edit',()=>{
 const w=state();w.requirements.files[0].requiredText=['[Observed source](source.md)'];assert.equal(citationDraft(w,draft('(source.md)')).arguments.content,'[Observed source](source.md)');w.requirements.files[0].requiredText.push('[Another label](source.md)');assert.equal(citationDraft(w,draft('(source.md)')).changes.length,0);
});
test('no explicit link requirement, exact-text rules, unknown destinations and ambiguous aliases are left unchanged',()=>{
 for(const modify of [w=>w.requirements.files[0].requiredText=[],w=>w.requirements.files[0].exactText='(source.md)',w=>w.operations[0].result.path='/other/source.md',w=>w.requirements.files[0].requiredText=['](https://example.com/source.md)']]){const w=state();modify(w);assert.equal(citationDraft(w,draft('(source.md)')).changes.length,0);}
 assert.equal(citationDraft(state(),draft('(unknown.md)')).changes.length,0);assert.equal(citationDraft(state(),draft('No reference here.')).changes.length,0);
});
test('code, quoted literals, escaped references, image embeds and existing links are never rewritten',()=>{
 const text='`(source.md)`\n```md\n(source.md)\n```\n~~~~\n[[source.md]]\n~~~~\n    (source.md)\n> Quote (source.md)\n"Quoted (source.md)"\n“Quoted [[source.md]]”\n\\(source.md) ![[source.md]] ![](source.md)\n[Correct label](source.md)\n<!-- (source.md) -->\n`unclosed (source.md)\n';assert.equal(citationDraft(state(),draft(text)).arguments.content,text);
 const w=state();w.requirements.files[0].requiredText.push('Quote (source.md)');assert.equal(citationDraft(w,draft('Quote (source.md)')).changes.length,0);
});
test('incomplete, redacted, failed, old-revision and superseded observations cannot back citation repair',()=>{
 for(const patch of [{status:'failed'},{revision:0},{result:{truncated:true}},{result:{content:'redacted',revision:'different'}}]){const w=state();w.operations[0]={...w.operations[0],...patch};assert.equal(citationDraft(w,draft('(source.md)')).changes.length,0);}
 for(const effect of [{name:'propose_command',status:'failed',action:'executed'},{name:'propose_file_edit',status:'completed',action:'changed'},{name:'computer_action',arguments:{operation:'type_text'},status:'interrupted',action:'input'},{name:'read_system_file',arguments:{path:'/project/source.md'},status:'failed'}]){const w=state();w.operations.push(effect);assert.equal(citationDraft(w,draft('(source.md)')).changes.length,0);}
 const w=state();w.operations.push({name:'propose_command',status:'failed'});assert.equal(citationDraft(w,draft('(source.md)')).changes.length,1);
});
test('relative destinations resolve against output directory; duplicate markers stay bounded',()=>{
 const w=state();w.requirements.files[0].path='/project/reports/note.md';w.requirements.files[0].requiredText=['](../source.md)'];const r=citationDraft(w,{...draft('(../source.md)'),path:'/project/reports/note.md'});assert.equal(r.changes.length,1);assert.equal(r.arguments.content,'[../source.md](../source.md)');assert.equal(citationDraft(state(),draft('(source.md) '.repeat(25))).changes.length,0);
});
test('citation repair is tied to the latest rejected draft, source observation and task revision',()=>{
 const w=state();w.operations.push({id:'draft',name:'propose_file_edit',status:'failed',revision:1,arguments:draft('Fact (source.md)'),result:{requirementFailures:['Missing link']}});const args={draft:'E2',reason:'Repair reference syntax'};
 assert.equal(citationRepairTool(w).length,1);assert.equal(repairCitations(w,args).arguments.content,'Fact [source.md](source.md)\n');assert.throws(()=>repairCitations(w,{...args,path:'/elsewhere'}));assert.throws(()=>repairCitations({...w,revision:2},args));w.operations.push({...w.operations.at(-1),id:'new'});assert.throws(()=>repairCitations(w,args));w.operations.at(-1).action='approved';assert.equal(citationRepairTool(w).length,0);
});
const call=(name,args)=>({content:'',tool_calls:[{function:{name,arguments:args}}]});
const wait=async fn=>{const end=Date.now()+5000;while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,10));}throw Error('Citation fixture timed out');};
async function fixture(t,repair=false){
 const dir=await mkdtemp(join(tmpdir(),'aurora-citations-')),source=join(dir,'source.md'),path=join(dir,'note.md');await writeFile(source,'Unresolved price: 110 or 140.');await writeFile(path,'before');
 const client={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,_t,_s,_c,opts)=>{
  if(opts?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Sourced note',check:'Read back the sourced note.'}]})};const c=JSON.parse(m.at(-1).content),last=c.recentEvidence.map(JSON.parse).at(-1);
  if(!last)return call('read_system_file',{path:source});if(last.name==='read_system_file'&&last.result.path===source)return call(repair?'propose_file_edit':'propose_formatted_file',{path,content:'Keep price unresolved (source.md).',reason:'Fixture'});
  if(last.status==='failed')return call('propose_citation_repair',{draft:c.repairableDraft.evidence,reason:'Repair known reference syntax'});
  if(last.name==='propose_file_edit')return call('read_system_file',{path});return call('finish_step',{summary:'Read saved note.',evidence:c.evidenceForCompletion.map(x=>x.id)});
 }};
 const f=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:client,workflowOptions:{pollMs:10,segmentMs:10000}});
 t.after(async()=>{await f.workflows.close();f.actions.stopAll();await wait(()=>!f.actions.running.size);await rm(dir,{recursive:true,force:true});});
 const w=await f.workflows.start({goal:'Sourced note',requirements:{files:[{path,requiredText:['](source.md)'],finalNewline:'required',lineEndings:'lf'}],commands:[]}});await wait(async()=>{const x=await f.workflows.read(w.id);return x.status==='plan_review'&&!f.workflows.running.has(w.id);});await f.workflows.control(w.id,'approve_plan','',w.revision);
 const a=await wait(async()=>!f.workflows.running.has(w.id)&&(await f.store.list('actions')).find(a=>a.status==='pending'));return {...f,path,source,w,a};
}
for(const repair of [false,true])test(repair?'rejected plain drafts have an explicit reviewed citation-repair tool':'formatted proposals repair only explicit source markers before exact review',async t=>{
 const f=await fixture(t,repair);assert.equal(await readFile(f.path,'utf8'),'before');assert.equal(f.a.payload.content,'Keep price unresolved [source.md](source.md).\n');assert.equal((await f.store.list('actions')).length,1);const op=(await f.workflows.read(f.w.id)).operations.at(-1);assert.equal(op.citationRepairs.length,1);assert.equal(op.citationRepairs[0].before,'(source.md)');assert.equal(op.requestedTool,repair?'propose_citation_repair':'propose_formatted_file');await f.actions.decide(f.a.id,'approve',f.a.digest);await wait(async()=>(await f.workflows.read(f.w.id)).status==='completed');assert.equal(await readFile(f.source,'utf8'),'Unresolved price: 110 or 140.');
});
