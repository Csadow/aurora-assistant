import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {retrieve} from '../src/vault.mjs';
import {OverlaySettings,overlayBounds,overlaySize,overlayViewport} from '../desktop/overlay.mjs';
import {Ollama} from '../src/ollama.mjs';

test('reasoning signals activity without exposing thoughts and output limits are reported as incomplete',async()=>{
 const thoughts='private intermediate reasoning';let thinking=0,visible='';
 const frames=[{message:{thinking:thoughts}},{message:{thinking:'more'}},{message:{content:'Partial answer'}},{done:true,done_reason:'length',eval_count:6144,prompt_eval_count:3500}];
 const ollama=new Ollama('http://127.0.0.1:11434','fixture',async()=>new Response(frames.map(f=>JSON.stringify(f)).join('\n')+'\n'));
 await assert.rejects(ollama.chat([],undefined,undefined,s=>{visible+=s;},{think:true,onThinking:()=>thinking++}),e=>{assert.match(e.message,/output limit/);assert.equal(e.code,'model_output_limit');assert.equal(e.metrics.tokens,6144);assert.equal(e.metrics.promptTokens,3500);assert.equal(e.tool_calls,undefined);assert.equal(e.content,undefined);return true;});
 assert.equal(thinking,1);assert.equal(visible,'Partial answer');assert(!visible.includes(thoughts));
});
test('a malformed local tool envelope rejects the whole streamed reply',async()=>{
 const frames=[{message:{content:'partial',tool_calls:[{function:{name:'ask_user',arguments:{question:'unsafe partial'}}}]}},{error:'XML syntax error on line 5: element <function> closed by </parameter>'}];
 const model=new Ollama('http://127.0.0.1:11434','fixture',async()=>new Response(frames.map(f=>JSON.stringify(f)).join('\n')+'\n'));
 await assert.rejects(model.chat([],[],undefined),e=>{assert.equal(e.code,'model_tool_parse_error');assert.equal(e.tool_calls,undefined);assert.equal(e.content,undefined);return true;});
 const other=new Ollama('http://127.0.0.1:11434','fixture',async()=>new Response('{"error":"ordinary backend failure"}\n'));
 await assert.rejects(other.chat([],[],undefined),e=>{assert.equal(e.code,undefined);return true;});
});

async function setup(t,chat){const dir=await mkdtemp(join(tmpdir(),'aurora-agents-'));const captures=[];const ollama={model:'fixture:4b',status:async()=>({online:true,models:[{name:'fixture:4b',size:4e9},{name:'fixture:27b',size:17e9}]}),check:async()=>{},chat:async(...args)=>{captures.push(args);return chat(...args);}};const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],ollamaClient:ollama,embedding:''});t.after(async()=>{app.agents.stopAll();await Promise.allSettled([...app.agents.running.values()].map(r=>r.work));await rm(dir,{recursive:true,force:true});});return {app,dir,captures};}
const answer=async()=>({role:'assistant',content:'A grounded local result.',metrics:{}});
async function finish(app,id){for(let i=0;i<100;i++){const r=await app.store.get('runs',id);if(!['queued','running'].includes(r.status))return r;await new Promise(r=>setTimeout(r,10));}throw new Error('Run did not finish');}

test('skills are portable Markdown, selected explicitly, revision checked, and excluded from memory recall',async t=>{const {app}=await setup(t,answer);assert.equal((await app.skills.list()).length,4);const n=await app.skills.read('project-review');assert(n.content.includes('Instructions'));await assert.rejects(app.skills.read('../private'));await assert.rejects(app.skills.selected(['project-review','project-review']));await app.skills.save({id:'project-review',content:'# My revised review\nUse code evidence.',revision:n.revision});await assert.rejects(app.skills.save({id:'project-review',content:'overwrite',revision:n.revision}),/changed/);assert(!retrieve(await app.vault.list(),'project review',100,100000).some(n=>n.path.startsWith('70 Skills/')));await app.skills.init();assert.match((await app.skills.read('project-review')).content,/My revised/);});
test('team agents execute separate sequential roles with skill snapshots and persisted results',async t=>{const {app,captures}=await setup(t,answer);await assert.rejects(app.agents.start({role:'__proto__',task:'Invalid role'}),/Choose an agent/);const run=await app.agents.start({role:'team',task:'Plan a learning project',skills:['learning-coach']});const result=await finish(app,run.id);assert.equal(result.status,'completed');assert.deepEqual(result.steps.map(s=>s.role),['planner','researcher','reviewer']);assert.equal(result.result,'A grounded local result.');assert(captures.every(c=>c[0][0].content.includes('USER-SELECTED SKILLS')));assert.equal(result.skills[0].revision,(await app.skills.read('learning-coach')).revision);assert(captures[2][0][1].content.includes('previousWork'));assert.equal(app.assistant.busy.size,0);});
test('agents recover from an empty final reply within the existing four-turn bound',async t=>{
 let calls=0;const {app}=await setup(t,async()=>++calls===1?{role:'assistant',content:'',metrics:{doneReason:'stop'}}:answer());
 const run=await app.agents.start({role:'researcher',task:'Check the available evidence'});assert.equal((await finish(app,run.id)).status,'completed');assert.equal(calls,2);
 const empty=await setup(t,async()=>({role:'assistant',content:'',metrics:{doneReason:'stop'}}));const stopped=await empty.app.agents.start({role:'reviewer',task:'Check the evidence'});assert.equal((await finish(empty.app,stopped.id)).status,'failed');assert.equal(empty.captures.length,4);
});
test('Qwen sampling follows the active reasoning mode and explicit overrides survive',async()=>{
 const bodies=[];const model=new Ollama('http://127.0.0.1:11434','qwen3.5:9b',async(_u,o)=>{bodies.push(JSON.parse(o.body));return new Response('{"message":{"content":"done"},"done":true}\n');});
 await model.chat([],undefined,undefined,undefined,{think:true});await model.chat([],undefined,undefined,undefined,{think:false,temperature:0.1});
 assert.equal(bodies[0].options.temperature,1);assert.equal(bodies[0].options.presence_penalty,1.5);assert.equal(bodies[0].options.top_p,0.95);assert.equal(bodies[1].options.temperature,0.1);assert.equal(bodies[1].options.top_p,0.8);
});
test('agents refuse write, command, cloud and recursive tools even when a model requests them',async t=>{let count=0;const {app}=await setup(t,async()=>++count===1?{role:'assistant',content:'',tool_calls:['propose_command','propose_file_edit','consult_cloud','delegate_agent'].map(name=>({function:{name,arguments:{}}}))}:answer());const run=await app.agents.start({role:'coder',task:'Review a project'});const r=await finish(app,run.id);assert.equal(r.status,'completed');assert(r.steps[0].tools.every(v=>v.result.includes('read-only')));assert.equal((await app.store.list('actions')).length,0);});
test('stop aborts inference, releases the shared slot, and preserves partial agent work',async t=>{const {app}=await setup(t,async(_m,_t,signal)=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));const run=await app.agents.start({role:'planner',task:'Make a plan'});for(let i=0;i<100;i++){if((await app.store.get('runs',run.id)).steps.length)break;await new Promise(r=>setTimeout(r,10));}await assert.rejects(app.agents.start({role:'planner',task:'Another plan'}),/running/);app.agents.stop(run.id);assert.equal((await finish(app,run.id)).status,'stopped');assert.equal(app.assistant.busy.size,0);});
test('restart marks unfinished runs interrupted without rerunning them',async t=>{const {app,captures}=await setup(t,answer);const record={id:'00000000-0000-4000-8000-000000000001',status:'running',created:new Date().toISOString(),steps:[]};await app.store.put('runs',record);await app.agents.init();assert.equal((await app.store.get('runs',record.id)).status,'interrupted');assert.equal(captures.length,0);});
test('local model selection persists and rejects uninstalled models or an active response',async t=>{const {app,dir}=await setup(t,answer);await assert.rejects(app.models.save({model:'cloud:latest',thinking:true}),/installed/);await assert.rejects(app.models.save({model:'fixture:27b',thinking:true},()=>true),/active response/);await app.models.save({model:'fixture:27b',thinking:true});assert.equal(app.assistant.ollama.model,'fixture:27b');assert.equal(app.assistant.ollama.generationOptions.think,true);const {LocalModels}=await import('../src/models.mjs');const restored=new LocalModels({data:join(dir,'data'),ollama:app.assistant.ollama});await restored.init();assert.equal(restored.value.model,'fixture:27b');});
test('overlay sizing fits the monitor and restores size and partly off-screen placement',async t=>{const dir=await mkdtemp(join(tmpdir(),'aurora-layout-'));t.after(()=>rm(dir,{recursive:true,force:true}));const s=new OverlaySettings(join(dir,'overlay.json'));await s.init();await s.resize(600);await s.remember({x:700,y:120,width:336,height:600},'eDP-1');const r=new OverlaySettings(s.file);await r.init();assert.deepEqual(r.value,s.value);await assert.rejects(r.resize(0));const area={x:0,y:30,width:1280,height:690};const bounds=overlayBounds(overlaySize(920,area,true),area,{right:9000,top:-900});assert.equal(bounds.x,1280-96);assert.equal(bounds.y+bounds.height,30+96);assert(bounds.height<=area.height);});

test('new agent/model/skill endpoints require local CSRF authorization and block model changes during inference',async t=>{
 const {app}=await setup(t,async(_m,_t,signal)=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.agents.stopAll();await Promise.allSettled([...app.agents.running.values()].map(r=>r.work));app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});const base='http://127.0.0.1:'+app.server.address().port;
 const token=(await(await fetch(base+'/api/bootstrap')).json()).token;const post=(path,data={},auth=true)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Aster-Token':token}:{})},body:JSON.stringify(data)});
 for(const path of ['/api/agent-start','/api/agent-stop','/api/skill','/api/local-model'])assert.equal((await post(path,{},false)).status,403);
 const response=await post('/api/agent-start',{role:'planner',task:'A slow planning task'});assert.equal(response.status,202);const run=await response.json();assert.equal((await post('/api/local-model',{model:'fixture:27b',thinking:true})).status,409);assert.equal((await post('/api/agent-stop',{id:run.id})).status,200);assert.equal((await finish(app,run.id)).status,'stopped');
});

test('partly offscreen companion placement survives with controls in the visible portion',()=>{
 const area={x:-1280,y:30,width:1280,height:900},size={width:400,height:800};
 for(const target of [{x:-1180,y:530},{x:-1480,y:100},{x:-1180,y:-370},{x:-200,y:100}]){
  const b=overlayBounds(size,area,{right:target.x+size.width,top:target.y});assert.deepEqual(b,{...size,...target});
  const v=overlayViewport(b,area);assert(b.x+v.x>=area.x);assert(b.y+v.y>=area.y);assert(b.x+v.x+v.width<=area.x+area.width);assert(b.y+v.y+v.height<=area.y+area.height);assert(v.width>=96&&v.height>=96);
 }
 const far=overlayBounds(size,area,{right:99999,top:99999});assert.deepEqual(overlayViewport(far,area),{x:0,y:0,width:96,height:96});
});
