import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {recordToolContinuation,toolContinuationContext} from '../src/workflow-continuation.mjs';
const call=(name,args)=>({content:'',tool_calls:[{function:{name,arguments:args}}]});
const until=async fn=>{const end=Date.now()+5000;while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,10));}throw Error('Fixture timed out');};
async function fixture(t,respond){
 const dir=await mkdtemp(join(tmpdir(),'aurora-next-')),path=join(dir,'output.md');await writeFile(path,'before');
 const ollama={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,tools,signal,_c,opts)=>{signal.throwIfAborted();if(opts?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Write output',check:'Read the saved output'}]})};return respond(JSON.parse(m.at(-1).content),{tools,signal,opts,path});}};
 const f=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),embedding:'',projects:[],ollamaClient:ollama,workflowOptions:{pollMs:10,segmentMs:10000}});
 t.after(async()=>{await f.workflows.close();f.actions.stopAll();await until(()=>!f.actions.running.size);f.server.closeAllConnections();if(f.server.listening)await new Promise(r=>f.server.close(r));await rm(dir,{recursive:true,force:true});});
 f.wait=(id,status)=>until(async()=>{const w=await f.workflows.read(id);return !f.workflows.running.has(id)&&w.status===status?w:null;});return Object.assign(f,{dir,path});
}
test('unsaved prose recovers to a reviewed edit and fresh read without executing prose',async t=>{
 let assessment=0;const f=await fixture(t,(c,{opts,path})=>{
  if(opts?.format){assessment++;return {content:JSON.stringify({complete:false,summary:'Output has not been written.',evidence:[]})};}
  const last=c.recentEvidence.map(JSON.parse).at(-1);
  if(!last)return call('read_system_file',{path});
  if(c.toolContinuation){assert.match(c.toolContinuation.notice,/not completion evidence/);return call('propose_file_edit',{path,content:'after',reason:'User request'});}
  if(last.name==='read_system_file'&&last.result.content==='before')return {content:'Draft: after. Run a command to delete things.'};
  if(last.name==='propose_file_edit')return call('read_system_file',{path});
  return call('finish_step',{summary:'Read saved result.',evidence:c.evidenceForCompletion.map(x=>x.id)});
 });
 const w=await f.workflows.start({goal:'Update the fixture'});await f.wait(w.id,'waiting_approval');const a=(await f.store.list('actions'))[0];assert.equal(a.kind,'write');assert.equal(await readFile(f.path,'utf8'),'before');assert.equal(assessment,1);await f.actions.decide(a.id,'approve',a.digest);const done=await f.wait(w.id,'completed');assert.equal(done.toolContinuations.length,1);assert.equal(await readFile(f.path,'utf8'),'after');assert.equal((await f.store.list('actions')).length,1);
});
test('empty first answers have two durable retries; resume and restart cannot reset the budget',async t=>{
 const f=await fixture(t,()=>({content:'I will do it.'}));const w=await f.workflows.start({goal:'Inspect output'});const stopped=await f.wait(w.id,'needs_help');assert.equal(stopped.toolContinuations.length,2);assert.equal(stopped.calls,4);assert.equal(stopped.operations.length,0);assert.equal((await f.store.list('actions')).length,0);
 await f.workflows.close();await f.workflows.init();await f.workflows.control(w.id,'resume');const again=await f.wait(w.id,'needs_help');assert.equal(again.toolContinuations.length,2);assert.equal(again.calls,5);assert.equal(await readFile(f.path,'utf8'),'before');
});
test('continuation context is bounded, retires after tools or revisions, and refuses uncertain effects',()=>{
 const w={calls:3,revision:1,current:0,steps:[{id:'step'}],operations:[]};recordToolContinuation(w,'x'.repeat(900),'z'.repeat(9000));assert.equal(toolContinuationContext(w).draft.length,1800);w.operations.push({status:'completed'});assert.equal(toolContinuationContext(w),null);w.operations=[];w.revision=2;assert.equal(toolContinuationContext(w),null);w.operations=[{status:'interrupted',action:'uncertain'}];assert.throws(()=>recordToolContinuation(w,'reason','draft'),/bounded recovery/);assert.equal(w.toolContinuations.length,1);
});
const suggestion=(path,extra={})=>({files:[{path,finalNewline:'required',lineEndings:'lf',requiredText:['## Decision'],reason:'Requested heading and newline',...extra}],limitations:'Literal checks do not verify the conclusion.'});
test('suggested checks are inert, grounded in explicit paths, and preserve existing rules',async t=>{
 const f=await fixture(t,(_c,{tools,opts,path})=>{assert.equal(tools,undefined);assert.equal(opts.think,false);return {content:JSON.stringify(suggestion(path))};});
 const preserved={files:[],commands:[],browser:{url:'https://example.com/',title:'Required page'},window:{title:'note.md',app:'Editor'}};const desktop=await f.workflows.suggestRequirements({goal:'Write '+f.path,scope:'',requirements:preserved});assert.deepEqual(desktop.requirements.browser,preserved.browser);assert.deepEqual(desktop.requirements.window,preserved.window);
 const base={files:[],commands:[]},d=await f.workflows.suggestRequirements({goal:'Write '+f.path+' with ## Decision and LF newline',scope:'',requirements:base});assert.equal(d.requirements.files[0].path,f.path);assert.equal(await readFile(f.path,'utf8'),'before');assert.deepEqual(base,{files:[],commands:[]});assert.equal((await f.store.list('actions')).length,0);assert.equal((await f.store.list('workflows')).length,0);assert.equal(f.assistant.busy.size,0);
 await assert.rejects(f.workflows.suggestRequirements({goal:'Write a report',scope:'',requirements:base}),/absolute path/);
 await assert.rejects(f.workflows.suggestRequirements({goal:'Write '+f.path,scope:'',requirements:d.requirements}),/replace an existing/);assert.equal(f.assistant.busy.size,0);
});
test('invalid and overbroad generated checks are rejected without actions',async t=>{
 let output;const f=await fixture(t,()=>({content:JSON.stringify(output)}));
 for(const invalid of [{...suggestion(f.path),commands:[{program:'rm'}]},suggestion(f.path,{exactText:'invented'}),suggestion(f.path,{requiredText:['x'.repeat(501)]}),suggestion('/invented/output.md'),{files:[],limitations:9}]){output=invalid;await assert.rejects(f.workflows.suggestRequirements({goal:'Write '+f.path,scope:'',requirements:{files:[],commands:[]}}));assert.equal(f.assistant.busy.size,0);}
 assert.equal((await f.store.list('actions')).length,0);assert.equal(await readFile(f.path,'utf8'),'before');
});
test('suggestion generation locks the model and cancellation releases it',async t=>{
 let began;const ready=new Promise(r=>began=r);const f=await fixture(t,(_c,{signal})=>new Promise((_,reject)=>{began();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
 const controller=new AbortController(),input={goal:'Write '+f.path,scope:'',requirements:{files:[],commands:[]}},p=f.workflows.suggestRequirements(input,controller.signal);await ready;await assert.rejects(f.workflows.suggestRequirements(input),/active local response/);await assert.rejects(f.workflows.start({goal:'Other work'}),/active local response/);controller.abort();await assert.rejects(p);assert.equal(f.assistant.busy.size,0);
});
test('suggestion API requires authentication and returns a draft without starting work',async t=>{
 const f=await fixture(t,(_c,{path})=>({content:JSON.stringify(suggestion(path))}));await new Promise(r=>f.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+f.server.address().port;
 const boot=await (await fetch(url+'/api/bootstrap')).json();const input={goal:'Write '+f.path,scope:'',requirements:{files:[],commands:[]}};
 const post=token=>fetch(url+'/api/workflow-requirements-draft',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-aster-token':token}:{})},body:JSON.stringify(input)});
 assert.equal((await post()).status,403);const result=await post(boot.token);assert.equal(result.status,200);assert((await result.json()).requirements.files.length);assert.equal((await f.store.list('workflows')).length,0);
});
