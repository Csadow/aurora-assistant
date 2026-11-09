import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';

const response=output=>new Response(new ReadableStream({start(controller){
 const send=value=>controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
 for(const item of output)if(item.type==='message')for(const part of item.content||[])if(part.type==='output_text')send({type:'response.output_text.delta',delta:part.text});
 send({type:'response.completed',response:{status:'completed',output,usage:{input_tokens:12,output_tokens:8}}});controller.close();
}}));

test('connected chat persists a real read-only tool result and source after reload',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-cloud-evidence-'));const requests=[];
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:{model:'fixture-local',status:async()=>({online:false})},chatgptFetch:async(_url,options)=>{
  const body=JSON.parse(options.body);requests.push(body);
  if(requests.length===1)return response([{type:'function_call',call_id:'read_1',name:'aurora.search_memory',arguments:'{"query":"cobalt fern"}'}]);
  assert.equal(body.input.findLast(item=>item.type==='function_call_output').call_id,'read_1');
  return response([{type:'message',role:'assistant',content:[{type:'output_text',text:'The saved label is cobalt fern. [M1]'}]}]);
 }});
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 app.chatgpt.value={hostId:'urn:uuid:fixture',active:'fixture-client',accounts:{'fixture-client':{clientId:'fixture-client',subject:'fixture-person',model:'fixture-gpt',refreshToken:'fixture-refresh',accessToken:'fixture-access',expiresAt:Date.now()+3600000}}};
 const finalPreference='Answer with calm, clear language after a memory lookup.';
 await app.character.save('# Aurora character\n'+('Be practical and warm. '.repeat(120))+finalPreference,null);
 await app.vault.save('30 Knowledge/Label.md','# Label\nThe saved label is cobalt fern.',null);
 const conversation=await app.store.conversation(),events=[];
 await app.assistant.chat({id:conversation.id,message:'Find the saved label and cite its note.',engine:'chatgpt'},new AbortController().signal,event=>events.push(event));
 const saved=await app.store.get('conversations',conversation.id),answer=saved.messages.at(-1);
 assert.equal(answer.engine,'chatgpt');assert.deepEqual(answer.tools,[{name:'search_memory',status:'completed'}]);
 assert(answer.sources.some(source=>source.path==='30 Knowledge/Label.md'));
 assert.equal(events.filter(event=>event.type==='tool'&&event.status==='done').length,1);
 assert.equal(requests.length,2);assert.equal(requests[1].input.filter(item=>item.type==='function_call').length,1);
 for(const request of requests){assert.equal(request.input[0].role,'developer');assert(request.input[0].content.includes(finalPreference));}
 assert.equal((await app.store.list('actions')).length,0);assert.equal((await app.store.list('proposals')).length,0);
 assert.equal(JSON.stringify(answer.tools).includes('cobalt fern'),false);
});

test('an explicit ChatGPT memory tool request requires a real read before answering',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-cloud-requested-'));const requests=[];
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:{model:'fixture-local',status:async()=>({online:false})},chatgptFetch:async(_url,options)=>{
  const body=JSON.parse(options.body);requests.push(body);
  if(requests.length===1){
   assert.equal(body.tool_choice,'required');assert.equal(body.parallel_tool_calls,false);
   assert.deepEqual(body.tools[0].tools.map(tool=>tool.name),['search_memory']);
   return response([{type:'function_call',call_id:'explicit_read_1',name:'search_memory',arguments:'{"query":"assistant preferences"}'}]);
  }
  assert.equal(body.tool_choice,undefined);
  assert(body.tools[0].tools.some(tool=>tool.name==='search_memory'));
  assert.equal(body.input.findLast(item=>item.type==='function_call_output').call_id,'explicit_read_1');
  return response([{type:'message',role:'assistant',content:[{type:'output_text',text:'The confirmed assistant preference is clear explanations. [M1]'}]}]);
 }});
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 app.chatgpt.value={hostId:'urn:uuid:fixture',active:'fixture-client',accounts:{'fixture-client':{clientId:'fixture-client',subject:'fixture-person',model:'fixture-gpt',refreshToken:'fixture-refresh',accessToken:'fixture-access',expiresAt:Date.now()+3600000}}};
 await app.vault.save('30 Knowledge/Test preference.md','# Assistant preferences\nClear explanations.',null);
 const conversation=await app.store.conversation(),events=[];
 await app.assistant.chat({id:conversation.id,message:'Please call search_memory with the query "assistant preferences" before answering.',engine:'chatgpt'},new AbortController().signal,event=>events.push(event));
 const saved=await app.store.get('conversations',conversation.id),answer=saved.messages.at(-1);
 assert.deepEqual(answer.tools,[{name:'search_memory',status:'completed'}]);
 assert(answer.sources.some(source=>source.path==='30 Knowledge/Test preference.md'));
 assert.equal(requests.length,2);
 assert.equal(events.filter(event=>event.type==='tool'&&event.status==='done').length,1);
 assert.equal((await app.store.list('actions')).length,0);assert.equal((await app.store.list('proposals')).length,0);
});

test('a required memory read cannot silently finish without its tool call',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-cloud-required-'));let first;
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:{model:'fixture-local',status:async()=>({online:false})},chatgptFetch:async(_url,options)=>{
  first=JSON.parse(options.body);
  return response([{type:'message',role:'assistant',content:[{type:'output_text',text:'I found the note.'}]}]);
 }});
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 app.chatgpt.value={hostId:'urn:uuid:fixture',active:'fixture-client',accounts:{'fixture-client':{clientId:'fixture-client',subject:'fixture-person',model:'fixture-gpt',refreshToken:'fixture-refresh',accessToken:'fixture-access',expiresAt:Date.now()+3600000}}};
 const conversation=await app.store.conversation();
 await assert.rejects(app.assistant.chat({id:conversation.id,message:'Please call search_memory to check the saved note.',engine:'chatgpt'},new AbortController().signal,()=>{}),/did not call the explicitly requested memory search/);
 assert.equal(first.tool_choice,'required');
 const saved=await app.store.get('conversations',conversation.id);
 assert.equal(saved.messages.at(-1).interrupted,true);
 assert.deepEqual((await app.store.list('actions')),[]);assert.deepEqual((await app.store.list('proposals')),[]);
});
