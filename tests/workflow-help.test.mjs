import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Workflows} from '../src/workflows.mjs';
const call=(name,args={})=>({content:'',tool_calls:[{function:{name,arguments:args}}],metrics:{tokens:12,seconds:0.1}});
const until=async fn=>{const end=Date.now()+4000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');};
async function fixture(t,{respond,cloudResponse,plan}={}){
 const dir=await mkdtemp(join(tmpdir(),'aurora-help-'));const requests=[];
 const ollama={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'},{name:'other'}]}),chat:async(m,tools,signal,chunk,options)=>{signal?.throwIfAborted();if(options?.format?.properties?.steps)return {content:plan??JSON.stringify({steps:[{title:'Inspect fixture',check:'Read an observation.'}]}),metrics:{tokens:10}};return respond?respond(JSON.parse(m.at(-1).content)):call('request_help',{question:'How can I inspect this reliably?',reason:'Need stronger reasoning'});}};
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],ollamaClient:ollama,workflowOptions:{pollMs:10},cloudFetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return cloudResponse?cloudResponse():Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Inspect the local file. Do not claim success without reading it.'}]}],usage:{input_tokens:20,output_tokens:15}});}});
 const get=id=>app.store.get('workflows',id);
 const wait=(id,status)=>until(async()=>{const w=await get(id);return w.status===status&&!app.workflows.running.has(id)?w:false;});
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);await rm(dir,{recursive:true,force:true});});
 return Object.assign(app,{requests,ollama,get,wait,configure:()=>app.settings.save({cloud:{provider:'openai',model:'fixture-online',apiKey:'fixture-key',enabled:true}})});
}
async function pending(f,id){await f.configure();const w=await f.get(id);return f.workflows.help(id,{revision:w.revision,question:'A reviewed question',context:'Only this reviewed context'});}
async function requestHelp(f){const w=await f.workflows.start({goal:'Inspect fixture'});return f.wait(w.id,'needs_help');}

test('local help is durable without credentials; failed setup does not create a request',async t=>{
 const f=await fixture(t),w=await requestHelp(f);assert.equal(f.requests.length,0);assert(w.help.question);assert(w.localUsage.length>=2);
 await assert.rejects(f.workflows.help(w.id,{revision:1,question:'Help'}),/not configured/);assert.equal((await f.store.list('actions')).length,0);
 await f.workflows.close();await f.workflows.init();assert.equal((await f.get(w.id)).status,'needs_help');
 await f.workflows.control(w.id,'resume');await f.wait(w.id,'needs_help');assert.equal((await f.get(w.id)).helpHistory[0].resolution,'continue locally');assert.equal(f.requests.length,0);
});

test('invalid plan and repeated unsupported completion claims request help automatically',async t=>{
 const f=await fixture(t,{plan:'not JSON'}),w=await requestHelp(f);assert.match(w.help.reason,/unusable plan/);
 const g=await fixture(t,{respond:()=>call('finish_step',{summary:'Done',evidence:['imaginary']})}),job=await requestHelp(g);assert.equal(job.operations.filter(o=>o.status==='failed').length,3);assert.equal(job.result,undefined);
});

test('invalid plan details are bounded and durable; malformed steps cannot trigger actions',async t=>{
 for(const [plan,reason] of [['null','expected one to four steps'],[JSON.stringify({steps:[null]}),'step 1 needs a nonempty title'],[JSON.stringify({steps:[{title:'x'.repeat(201),check:'Observe'}]}),'at most 200 characters'],[JSON.stringify({steps:[{title:'Inspect',check:'x'.repeat(6000)}]}),'at most 600 characters']]){
  const f=await fixture(t,{plan}),w=await requestHelp(f);assert(w.planFailure.reason.includes(reason));assert(w.planFailure.response.length<=5000);assert.equal(w.calls,1);assert.equal(w.operations.length,0);assert.equal((await f.store.list('actions')).length,0);
  await f.workflows.close();await f.workflows.init();assert.deepEqual((await f.get(w.id)).planFailure,w.planFailure);assert.equal(f.workflows.running.size,0);
 }
});

test('approved advice returns to the same task but cannot serve as completion evidence',async t=>{
 const seen=[];const f=await fixture(t,{respond:state=>{seen.push(state);const advice=state.consultations?.[0];return advice?call('finish_step',{summary:'Consultant did it',evidence:[advice.id]}):call('request_help',{question:'How?',reason:'Stuck'});}}),w=await requestHelp(f);
 const {action}=await pending(f,w.id);assert.equal(f.requests.length,0);await f.actions.decide(action.id,'approve',action.digest);
 const stopped=await f.wait(w.id,'needs_help');assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.input,'A reviewed question\n\nREFERENCE CONTEXT:\nOnly this reviewed context');assert.equal(f.requests[0].body.store,false);assert(!('tools' in f.requests[0].body));
 assert(seen.some(x=>x.consultations?.[0]?.advice.includes('Inspect')));assert(seen.some(x=>x.consultations?.[0]?.reviewStatus.includes('approved')));assert(seen.some(x=>x.consultations?.[0]?.question==='A reviewed question'));assert.equal(stopped.result,undefined);assert(stopped.operations.some(o=>o.name==='finish_step'&&o.result?.error?.includes('consult_cloud')));assert.equal((await f.store.list('actions')).length,1);
});

test('dismissed, failed and partial consultations pause without automatic retries or laptop verification',async t=>{
 for(const outcome of ['dismissed','failed','partial']){
  const f=await fixture(t,{cloudResponse:()=>outcome==='failed'?new Response('',{status:429}):Response.json({status:'incomplete',output:[{type:'message',content:[{type:'output_text',text:'Partial advice'}]}]})}),w=await requestHelp(f),{action}=await pending(f,w.id);
  await f.actions.decide(action.id,outcome==='dismissed'?'dismiss':'approve',action.digest);const stopped=await f.wait(w.id,'needs_help');
  await f.workflows.tick();assert.equal(f.requests.length,outcome==='dismissed'?0:1);assert.equal(stopped.result,undefined);assert.match(stopped.error,outcome==='partial'?/partial advice/:outcome==='failed'?/rate limit/:/dismissed/);
 }
});

test('restart recovers an orphaned completed consultation once, and stays paused',async t=>{
 const f=await fixture(t),w=await requestHelp(f),{action}=await pending(f,w.id);await f.workflows.close();await f.actions.decide(action.id,'approve',action.digest);await until(()=>!f.actions.running.size);
 const stale=await f.get(w.id);delete stale.operations.at(-1).action;stale.operations.at(-1).status='started';await f.store.put('workflows',stale);
 f.workflows=new Workflows({assistant:f.assistant,store:f.store,skills:f.skills,actions:f.actions,pollMs:10});await f.workflows.init();assert.equal((await f.get(w.id)).status,'paused');assert.equal((await f.get(w.id)).operations.at(-1).status,'completed');await f.workflows.tick();assert.equal(f.requests.length,1);
});

test('daily output allowance counts failed attempts; limits do not reset through model changes',async t=>{
 const f=await fixture(t,{cloudResponse:()=>new Response('',{status:500})}),w=await requestHelp(f);await f.configure();await f.settings.save({cloud:{dailyOutputLimit:4096}});
 const {action}=await pending(f,w.id);await f.actions.decide(action.id,'approve',action.digest);await f.wait(w.id,'needs_help');const next=await pending(f,w.id);await assert.rejects(f.actions.decide(next.action.id,'approve',next.action.digest),/output-token allowance/);assert.equal(f.requests.length,1);
});

test('model migration is explicit, retires pending approvals, preserves budgets and records both settings',async t=>{
 const f=await fixture(t),w=await requestHelp(f),{action}=await pending(f,w.id);await f.workflows.control(w.id,'pause');
 f.ollama.model='other';f.ollama.generationOptions={think:true,num_predict:6144,num_ctx:12288};
 await assert.rejects(f.workflows.control(w.id,'resume'),/Restore/);await assert.rejects(f.workflows.migrate(w.id,{model:'other',generation:{think:false},revision:1}),/settings changed/);
 const before=await f.get(w.id);const moved=await f.workflows.migrate(w.id,{model:'other',generation:f.ollama.generationOptions,revision:1});
 assert.equal(moved.id,w.id);assert.equal(moved.model,'other');assert.equal(moved.calls,before.calls);assert.equal(moved.activeMs,before.activeMs);assert.equal(moved.modelTransitions.length,1);assert.equal(moved.modelTransitions[0].from.model,'fixture');assert.equal(moved.revision,2);assert.equal((await f.store.get('actions',action.id)).status,'dismissed');assert.equal(f.requests.length,0);
});

test('stale revisions, duplicate previews and cancelled tasks cannot send help',async t=>{
 const f=await fixture(t),w=await requestHelp(f);await f.configure();await assert.rejects(f.workflows.help(w.id,{revision:0,question:'Help'}),/changed/);
 const {action}=await pending(f,w.id);await assert.rejects(f.workflows.help(w.id,{revision:1,question:'Duplicate'}),/paused task/);await f.workflows.control(w.id,'cancel');await assert.rejects(f.actions.decide(action.id,'approve',action.digest),/already been handled/);assert.equal(f.requests.length,0);
});

test('restart completes an interrupted model transition once without reviving its approval',async t=>{
 const f=await fixture(t),w=await requestHelp(f),{action}=await pending(f,w.id);await f.workflows.close();
 const stale=await f.get(w.id);stale.pendingSteer={id:'transition-fixture',instruction:'Continue with the other local model.',at:new Date().toISOString(),modelTransition:{from:{model:stale.model,generation:stale.generation},to:{model:'other',generation:{think:true}}}};stale.status='paused';await f.store.put('workflows',stale);
 await f.workflows.init();await f.workflows.close();await f.workflows.init();const recovered=await f.get(w.id);assert.equal(recovered.status,'paused');assert.equal(recovered.model,'other');assert.equal(recovered.modelTransitions.length,1);assert.equal(recovered.revision,2);assert.equal(recovered.calls,w.calls);assert.equal((await f.store.get('actions',action.id)).status,'dismissed');assert.equal(f.requests.length,0);
});
