import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Workflows} from '../src/workflows.mjs';

const wait=async fn=>{const until=Date.now()+5000;while(Date.now()<until){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Timed out waiting for workflow state.');};
const completed=output=>new Response(new ReadableStream({start(controller){const send=value=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(value)+'\n\n'));for(const item of output.filter(value=>value.type==='message'))for(const part of item.content||[])if(part.type==='output_text')send({type:'response.output_text.delta',delta:part.text});send({type:'response.completed',response:{status:'completed',output,usage:{input_tokens:20,output_tokens:7}}});controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
const message=text=>[{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const call=(name,args)=>[{type:'function_call',call_id:'call_'+name,name,arguments:JSON.stringify(args)}];

async function fixture(t,{edit=false,failure=null}={}){
 const dir=await mkdtemp(join(tmpdir(),'aurora-chatgpt-workflow-')),home=join(dir,'project'),path=join(home,'note.txt');await mkdir(home);await writeFile(path,'before');
 let localCalls=0,failedOnce=false;const requests=[];
 const ollama={model:'fixture-local',generationOptions:{think:false},check:async()=>{},status:async()=>({online:true,model:'fixture-local',models:[{name:'fixture-local'}]}),chat:async()=>{localCalls++;throw Error('Cloud workflow called local inference.');}};
 const chatgptFetch=async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);requests.push(body);assert.equal(body.model,'fixture-gpt');assert.equal(body.store,false);assert.equal(body.stream,true);
  if(body.text?.format){assert.equal(body.text.format.type,'json_schema');return completed(message(JSON.stringify({steps:[{title:'Inspect fixture',check:edit?'Read back the saved edit.':'Read the file and report its content.'}]})));}
  if(failure&&!failedOnce){failedOnce=true;return failure();}
  const state=JSON.parse(body.input.findLast(item=>item.role==='user').content),recent=state.recentEvidence.map(JSON.parse),last=recent.at(-1);
  if(!last)return completed(call(edit?'propose_file_edit':'read_system_file',edit?{path,content:'after',reason:'Fixture edit'}:{path}));
  if(edit&&last.name==='propose_file_edit')return completed(call('read_system_file',{path}));
  return completed(call('finish_step',{summary:edit?'Saved and read back the fixture.':'Read the fixture.',evidence:recent.filter(item=>item.status==='completed').map(item=>item.id)}));
 };
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],ollamaClient:ollama,chatgptFetch,workflowOptions:{pollMs:10,segmentMs:5000}});
 app.chatgpt.value={hostId:'urn:uuid:fixture',active:'fixture-client',accounts:{'fixture-client':{clientId:'fixture-client',subject:'fixture-person',model:'fixture-gpt',refreshToken:'fixture-refresh',accessToken:'fixture-access',expiresAt:Date.now()+3600000}}};
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await wait(()=>!app.actions.running.size);await rm(dir,{recursive:true,force:true});});
 return {...app,dir,path,requests,get localCalls(){return localCalls;}};
}

test('disconnected ChatGPT chat leaves the draft out of conversation history',async t=>{
 const f=await fixture(t),conversation=await f.store.conversation();
 f.chatgpt.value.accounts['fixture-client'].reconnectRequired=true;
 await assert.rejects(()=>f.assistant.chat({id:conversation.id,message:'Keep this draft',engine:'chatgpt'},new AbortController().signal,()=>{}),/Choose Local or reconnect/);
 assert.deepEqual((await f.store.get('conversations',conversation.id)).messages,[]);
 assert.equal(f.requests.length,0);assert.equal(f.localCalls,0);assert.equal(f.assistant.busy.size,0);
 assert.equal(f.chatgpt.active().model,'fixture-gpt');
});

test('rejected ChatGPT token renewal leaves the unsent message out of history',async t=>{
 const f=await fixture(t),conversation=await f.store.conversation();let renewals=0;
 f.chatgpt.active().expiresAt=0;
 f.chatgpt.fetch=async url=>{assert.match(url,/\/oauth\/token$/);renewals++;return new Response(null,{status:401});};
 await assert.rejects(()=>f.assistant.chat({id:conversation.id,message:'Keep this draft',engine:'chatgpt'},new AbortController().signal,()=>{}),/authorization was rejected/);
 assert.deepEqual((await f.store.get('conversations',conversation.id)).messages,[]);
 assert.equal(f.chatgpt.status().connected,false);assert.equal(f.chatgpt.status().reconnectRequired,true);
 assert.equal(f.requests.length,0);assert.equal(f.localCalls,0);assert.equal(renewals,1);
});

test('ChatGPT workflow pins account and model, uses structured planning and local read evidence',async t=>{
 const f=await fixture(t);
 const finalPreference='When you report a completed task, be direct and gently supportive.';
 await f.character.save('# Aurora character\n'+('Be clear and caring. '.repeat(120))+finalPreference,null);
 const started=await f.workflows.start({goal:'Inspect the fixture',engine:'chatgpt'});
 const done=await wait(async()=>{const w=await f.store.get('workflows',started.id);return w.status==='completed'?w:null;});
 assert.equal(done.engine,'chatgpt');assert.equal(done.model,'fixture-gpt');assert.equal(done.chatgptClientId,'fixture-client');assert.equal(JSON.stringify(done).includes('fixture-person'),false);
 assert.equal(f.localCalls,0);assert.equal(done.chatgptUsage.length,3);assert.equal(done.localUsage,undefined);assert.equal(done.operations[0].name,'read_system_file');assert.equal(done.operations[1].name,'finish_step');
 assert.equal((await f.workflows.read(done.id)).health.code,'completed');assert.equal(f.requests.some(body=>body.text?.format?.schema?.properties?.steps),true);
 const execution=f.requests.find(body=>body.tools?.[0]?.tools?.some(tool=>tool.name==='read_system_file'));
 assert(execution);assert.equal(execution.input[0].role,'developer');
 assert.match(execution.input[0].content,/You are Aurora, a female AI assistant/);
 assert(execution.input[0].content.includes(finalPreference));
});

test('ChatGPT edit workflow keeps action review and refuses a changed account after restart',async t=>{
 const f=await fixture(t,{edit:true}),started=await f.workflows.start({goal:'Edit the fixture and verify',engine:'chatgpt'});
 const pending=await wait(async()=>{const w=await f.store.get('workflows',started.id);return w.status==='waiting_approval'?w:null;});
 assert.equal(await readFile(f.path,'utf8'),'before');assert.equal((await f.store.list('actions')).length,1);
 await f.workflows.close();f.workflows=new Workflows({assistant:f.assistant,store:f.store,skills:f.skills,actions:f.actions,pollMs:10,segmentMs:5000});await f.workflows.init();
 const saved=await f.store.get('workflows',started.id);assert.equal(saved.status,'paused');assert.equal(saved.engine,'chatgpt');
 f.chatgpt.value.accounts['fixture-client'].model='other-model';await assert.rejects(()=>f.workflows.control(started.id,'resume'),/original ChatGPT account and model/);
 assert.equal((await f.workflows.read(started.id)).health.code,'model_changed');f.chatgpt.value.accounts['fixture-client'].model='fixture-gpt';
 await f.workflows.control(started.id,'resume');const action=await f.store.get('actions',pending.operations.at(-1).action);await f.actions.decide(action.id,'approve',action.digest);
 const done=await wait(async()=>{const w=await f.store.get('workflows',started.id);return w.status==='completed'?w:null;});
 assert.equal(await readFile(f.path,'utf8'),'after');assert.equal((await f.store.list('actions')).length,1);assert.equal(done.operations.filter(op=>op.name==='propose_file_edit').length,1);assert.equal(f.localCalls,0);
});

const refused=()=>completed([{type:'message',role:'assistant',content:[{type:'refusal',refusal:'I cannot perform this request.'}]},...call('propose_file_edit',{path:'/tmp/never.txt',content:'unsafe',reason:'No approval'})]);
const disconnected=()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.output_item.added',output_index:0,item:{type:'function_call',name:'propose_file_edit'}})+'\n\n'));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});

for(const [name,failure,expected] of [['refusal',refused,/declined this request/],['interrupted stream',disconnected,/disconnected before completing/]]){
 test('ChatGPT workflow preserves a disposable file and approval boundary after '+name,async t=>{
  const f=await fixture(t,{edit:true,failure}),started=await f.workflows.start({goal:'Edit disposable fixture and read it back',engine:'chatgpt'});
  const paused=await wait(async()=>{const w=await f.store.get('workflows',started.id);return w.status==='paused'?w:null;});
  assert.match(paused.error,expected);assert.equal(paused.operations.length,0);assert.equal((await f.store.list('actions')).length,0);assert.equal(await readFile(f.path,'utf8'),'before');assert.equal(f.localCalls,0);
  await f.workflows.control(started.id,'resume');
  const pending=await wait(async()=>{const w=await f.store.get('workflows',started.id);return w.status==='waiting_approval'?w:null;});
  assert.equal(await readFile(f.path,'utf8'),'before');assert.equal((await f.store.list('actions')).length,1);
  const action=await f.store.get('actions',pending.operations.at(-1).action);assert.equal(action.status,'pending');await f.actions.decide(action.id,'approve',action.digest);
  const done=await wait(async()=>{const w=await f.store.get('workflows',started.id);return w.status==='completed'?w:null;});
  assert.equal(done.engine,'chatgpt');assert.equal(done.model,'fixture-gpt');assert.equal(done.operations.filter(op=>op.name==='propose_file_edit').length,1);assert.equal(await readFile(f.path,'utf8'),'after');assert.equal(f.localCalls,0);
 });
}
