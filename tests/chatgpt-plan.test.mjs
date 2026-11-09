import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSign,generateKeyPairSync,randomUUID} from 'node:crypto';
import {ChatGPTPlan,verifyIdentity} from '../src/chatgpt-plan.mjs';
import {ChatGPTChat} from '../src/chatgpt-chat.mjs';

const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=keys.publicKey.export({format:'jwk'});jwk.kid='fixture';jwk.use='sig';
const jwt=(claims,signature=true)=>{const first=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture',typ:'JWT'})).toString('base64url'),second=Buffer.from(JSON.stringify(claims)).toString('base64url');const sign=createSign('RSA-SHA256');sign.update(first+'.'+second);return first+'.'+second+'.'+(signature?sign.sign(keys.privateKey).toString('base64url'):'bad');};
const identity=(client,nonce)=>jwt({iss:'https://auth.openai.com',aud:client,sub:'person-1',email:'user@example.com',nonce,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600});
const fixtureFetch=async url=>{if(url.endsWith('/.well-known/openid-configuration'))return Response.json({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/keys',revocation_endpoint:'https://auth.openai.com/revoke'});if(url.endsWith('/keys'))return Response.json({keys:[jwk]});throw Error('Unexpected '+url);};
test('ChatGPT identity requires verified issuer, audience, nonce, expiry and signature',async()=>{const id=identity('oaiapp_test','nonce');assert.equal((await verifyIdentity(id,{clientId:'oaiapp_test',nonce:'nonce',fetchImpl:fixtureFetch})).email,'user@example.com');for(const [token,options] of [[id,{clientId:'wrong',nonce:'nonce'}],[id,{clientId:'oaiapp_test',nonce:'wrong'}],[jwt({...JSON.parse(Buffer.from(id.split('.')[1],'base64url')),exp:1}),{clientId:'oaiapp_test',nonce:'nonce'}],[jwt({...JSON.parse(Buffer.from(id.split('.')[1],'base64url')),sub:'person-1'},false),{clientId:'oaiapp_test',nonce:'nonce'}]])await assert.rejects(()=>verifyIdentity(token,{...options,fetchImpl:fixtureFetch}),/identity/);});
test('ChatGPT sign-in uses PKCE loopback, keeps credentials private, and retains local choice until selected',async t=>{const dir=await mkdtemp(join(tmpdir(),'aurora-chatgpt-'));t.after(()=>rm(dir,{recursive:true,force:true}));let nonce,requests=[];const fetchImpl=async(url,options={})=>{requests.push({url,options});if(url.endsWith('/oauth/token'))return Response.json({access_token:'secret-access',refresh_token:'secret-refresh',id_token:identity('oaiapp_fixture',nonce),expires_in:3600,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'});if(url.endsWith('/models'))return Response.json({models:[{slug:'gpt-fixture',display_name:'Fixture GPT',visibility:'list'},{slug:'hidden',visibility:'hide'}]});return fixtureFetch(url,options);};const plan=new ChatGPTPlan({data:dir,fetchImpl});await plan.init();const started=await plan.connect(),u=new URL(started.url);nonce=u.searchParams.get('nonce');assert.equal(u.hostname,'auth.openai.com');assert.equal(u.searchParams.get('client_id'),'dynamic_agent_client');assert(u.searchParams.get('code_challenge'));assert.equal(plan.status().connected,false);const callback=u.searchParams.get('redirect_uri')+'?code=fixture&state='+encodeURIComponent(u.searchParams.get('state'))+'&client_id=oaiapp_fixture';const response=await fetch(callback);assert.equal(response.status,200);assert.equal(plan.status().connected,true);assert.equal(plan.status().account.model,'');assert.equal(JSON.stringify(plan.status()).includes('secret'),false);assert.deepEqual(await plan.models(),[{id:'gpt-fixture',name:'Fixture GPT'}]);await assert.rejects(()=>plan.select('hidden'),/Choose a model/);await plan.select('gpt-fixture');assert.equal(plan.status().account.model,'gpt-fixture');assert.equal((await stat(plan.file)).mode&0o777,0o600);const saved=JSON.parse(await readFile(plan.file,'utf8'));assert.equal(saved.accounts.oaiapp_fixture.refreshToken,'secret-refresh');assert.equal(requests.find(r=>r.url.endsWith('/oauth/token')).options.body.get('client_id'),'oaiapp_fixture');const returning=new URL((await plan.connect('oaiapp_fixture')).url);assert.equal(returning.searchParams.get('client_id'),'oaiapp_fixture');assert.equal(returning.searchParams.has('agent_name_hint'),false);plan.close();});
const stream=output=>new Response(new ReadableStream({start(c){const send=x=>c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(x)+'\n\n'));for(const item of output.filter(x=>x.type==='message'))for(const part of item.content||[])if(part.type==='output_text')send({type:'response.output_text.delta',delta:part.text});send({type:'response.completed',response:{status:'completed',output,usage:{input_tokens:10,output_tokens:4}}});c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
test('ChatGPT tool rounds keep reasoning and call IDs, use developer instructions, and never store responses remotely',async()=>{const seen=[],plan={active:()=>({model:'gpt-fixture'}),access:async()=> 'secret'};const fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body);seen.push(body);return stream(seen.length===1?[{type:'reasoning',id:'r1',summary:[]},{type:'function_call',call_id:'call_1',name:'search_memory',arguments:'{"query":"Aurora"}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Found it.'}]}]);};const chat=new ChatGPTChat(plan,{fetchImpl}),messages=[{role:'system',content:'You are Aurora'},{role:'user',content:'Find my note'}],tools=[{type:'function',function:{name:'search_memory',description:'Search notes',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}}];const first=await chat.chat(messages,tools);assert.equal(first.tool_calls[0].id,'call_1');messages.push(first,{role:'tool',tool_name:'search_memory',tool_call_id:'call_1',content:'[{"path":"a.md"}]'});let chunks='';const second=await chat.chat(messages,undefined,undefined,t=>chunks+=t);assert.equal(second.content,'Found it.');assert.equal(chunks,'Found it.');assert.equal(seen[0].store,false);assert.equal(seen[0].stream,true);assert.equal(seen[0].input[0].role,'developer');assert.equal(seen[0].tools[0].type,'namespace');assert(seen[1].input.some(x=>x.type==='reasoning'&&x.id==='r1'));assert(seen[1].input.some(x=>x.type==='function_call_output'&&x.call_id==='call_1'));assert.equal(JSON.stringify(seen).includes('secret'),false);});
test('ChatGPT stream failure cannot return a partial tool call',async()=>{const plan={active:()=>({model:'gpt-fixture'}),access:async()=> 'secret'};const chat=new ChatGPTChat(plan,{fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.failed',response:{error:{message:'usage limit'}}})+'\n\n'));c.close();}}))});await assert.rejects(()=>chat.chat([{role:'user',content:'Hi'}]),/usage limit/);});
test('ChatGPT workflow replay pairs saved tool evidence and pins model with structured output',async()=>{const account={clientId:'fixture-client',model:'gpt-fixture'},plan={active:()=>account,access:async()=> 'secret'};let body;const chat=new ChatGPTChat(plan,{fetchImpl:async(_url,options)=>{body=JSON.parse(options.body);return stream([{type:'message',role:'assistant',content:[{type:'output_text',text:'{"complete":true}'}]}]);}});const history=[{role:'system',content:'Assess saved evidence.'},{role:'assistant',content:'',tool_calls:[{function:{name:'read_system_file',arguments:{path:'/tmp/fixture'}}}]},{role:'tool',content:'{"content":"fixture"}'},{role:'user',content:'Return JSON.'}];const format={type:'object',properties:{complete:{type:'boolean'}},required:['complete'],additionalProperties:false};const reply=await chat.chat(history,undefined,undefined,undefined,{format,expectedAccount:'fixture-client',expectedModel:'gpt-fixture'});assert.equal(reply.content,'{"complete":true}');assert.equal(body.text.format.type,'json_schema');assert.deepEqual(body.text.format.schema,format);const call=body.input.find(x=>x.type==='function_call'),result=body.input.find(x=>x.type==='function_call_output');assert.equal(call.name,'read_system_file');assert.equal(call.call_id,result.call_id);account.model='changed';await assert.rejects(()=>chat.chat([{role:'user',content:'Again'}],undefined,undefined,undefined,{expectedModel:'gpt-fixture'}),/another ChatGPT account or model/);});
test('expired ChatGPT access serializes rotating refresh and sign-out clears local tokens',async t=>{const dir=await mkdtemp(join(tmpdir(),'aurora-chatgpt-refresh-'));t.after(()=>rm(dir,{recursive:true,force:true}));let refreshes=0,revoked=false;const fetchImpl=async(url,options)=>{if(url.endsWith('/oauth/token')){refreshes++;assert.equal(options.body.get('refresh_token'),'old-refresh');return Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'});}if(url.endsWith('/.well-known/openid-configuration'))return Response.json({issuer:'https://auth.openai.com',revocation_endpoint:'https://auth.openai.com/revoke'});if(url.endsWith('/revoke')){revoked=true;assert.equal(options.body.get('token'),'new-refresh');return new Response(null,{status:200});}throw Error('Unexpected '+url);};const p=new ChatGPTPlan({data:dir,fetchImpl});p.value={hostId:'urn:uuid:'+randomUUID(),active:'oaiapp_fixture',accounts:{oaiapp_fixture:{clientId:'oaiapp_fixture',subject:'person-1',email:'user@example.com',accessToken:'old-access',refreshToken:'old-refresh',expiresAt:0,model:'gpt-fixture'}}};const tokens=await Promise.all([p.access(),p.access()]);assert.deepEqual(tokens,['new-access','new-access']);assert.equal(refreshes,1);assert.equal(JSON.parse(await readFile(p.file,'utf8')).accounts.oaiapp_fixture.refreshToken,'new-refresh');const done=await p.signOut();assert.equal(done.connected,false);assert.equal(done.revoked,true);assert.equal(revoked,true);assert.equal(JSON.stringify(await readFile(p.file,'utf8')).includes('new-refresh'),false);});

test('rejected ChatGPT renewal requires reconnect without losing the saved model',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-chatgpt-rejected-'));t.after(()=>rm(dir,{recursive:true,force:true}));let attempts=0;
 const p=new ChatGPTPlan({data:dir,fetchImpl:async()=>{attempts++;return new Response(null,{status:401});}});
 p.value={hostId:'urn:uuid:'+randomUUID(),active:'fixture',accounts:{fixture:{clientId:'fixture',subject:'person-1',refreshToken:'saved-refresh',accessToken:'expired-access',expiresAt:0,model:'gpt-fixture'}}};
 await assert.rejects(()=>p.access(),/Connect again/);assert.equal(attempts,1);
 assert.equal(p.status().connected,false);assert.equal(p.status().reconnectRequired,true);assert.match(p.status().error,/Reconnect this account/);
 assert.equal(p.status().account.model,'gpt-fixture');assert.equal(p.status().accounts[0].connected,false);
 await assert.rejects(()=>p.access(),/Reconnect this account/);assert.equal(attempts,1);
 const reloaded=new ChatGPTPlan({data:dir,fetchImpl:p.fetch});await reloaded.init();
 assert.equal(reloaded.status().connected,false);assert.equal(reloaded.status().reconnectRequired,true);
 assert.equal(reloaded.status().account.model,'gpt-fixture');
 await assert.rejects(()=>reloaded.switchAccount('fixture'),/Reconnect this ChatGPT account/);
});

test('temporary ChatGPT authorization failures leave the account retryable',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-chatgpt-transient-'));t.after(()=>rm(dir,{recursive:true,force:true}));let attempts=0;
 const p=new ChatGPTPlan({data:dir,fetchImpl:async()=>{attempts++;return attempts===1?new Response(null,{status:503}):Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});}});
 p.value={hostId:'urn:uuid:'+randomUUID(),active:'fixture',accounts:{fixture:{clientId:'fixture',refreshToken:'saved-refresh',accessToken:'expired-access',expiresAt:0,model:'gpt-fixture'}}};
 await assert.rejects(()=>p.access(),/temporarily unavailable/);assert.equal(p.status().connected,true);assert.equal(p.status().reconnectRequired,false);
 assert.equal(await p.access(),'new-access');assert.equal(attempts,2);assert.equal(p.status().account.model,'gpt-fixture');
});

test('signing back into a rejected ChatGPT account restores its saved model',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-chatgpt-reconnect-'));t.after(()=>rm(dir,{recursive:true,force:true}));let nonce;
 const fetchImpl=async(url)=>url.endsWith('/oauth/token')?Response.json({access_token:'new-access',refresh_token:'new-refresh',id_token:identity('fixture',nonce),expires_in:3600,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'}):fixtureFetch(url);
 const p=new ChatGPTPlan({data:dir,fetchImpl});p.value={hostId:'urn:uuid:'+randomUUID(),active:'fixture',accounts:{fixture:{clientId:'fixture',subject:'person-1',email:'user@example.com',refreshToken:'old-refresh',model:'gpt-fixture',reconnectRequired:true}}};
 const u=new URL((await p.connect('fixture')).url);nonce=u.searchParams.get('nonce');
 const callback=u.searchParams.get('redirect_uri')+'?code=fixture&state='+encodeURIComponent(u.searchParams.get('state'));
 assert.equal((await fetch(callback)).status,200);assert.equal(p.status().connected,true);assert.equal(p.status().reconnectRequired,false);
 assert.equal(p.status().account.model,'gpt-fixture');assert.equal(p.status().error,null);
 const saved=JSON.parse(await readFile(p.file,'utf8'));assert.equal(saved.accounts.fixture.refreshToken,'new-refresh');
});

test('ChatGPT rejects an unadvertised call before any tool can run',async()=>{
 const plan={active:()=>({model:'gpt-fixture'}),access:async()=> 'secret'};
 const chat=new ChatGPTChat(plan,{fetchImpl:async()=>stream([{type:'function_call',call_id:'call_unlisted',name:'aurora.propose_command',arguments:'{"command":"exit"}'}])});
 await assert.rejects(()=>chat.chat([{role:'user',content:'Read only'}],[{type:'function',function:{name:'search_memory',description:'Search notes',parameters:{type:'object'}}}]),/unexpected tool call/);
});

test('ChatGPT rejects duplicate call references and replays synthetic IDs correctly',async()=>{
 const plan={active:()=>({model:'gpt-fixture'}),access:async()=> 'secret'};
 const tools=[{type:'function',function:{name:'search_memory',description:'Search notes',parameters:{type:'object'}}}];
 const duplicate=new ChatGPTChat(plan,{fetchImpl:async()=>stream([{type:'function_call',call_id:'same',name:'search_memory',arguments:'{}'},{type:'function_call',call_id:'same',name:'search_memory',arguments:'{}'}])});
 await assert.rejects(()=>duplicate.chat([{role:'user',content:'Find notes'}],tools),/unexpected tool call/);
 const odd=new ChatGPTChat(plan,{fetchImpl:async()=>stream([{type:'function_call',call_id:'bad',name:'search_memory',arguments:'{bad'}])});
 await assert.rejects(()=>odd.chat([{role:'user',content:'Find notes'}],tools),/unreadable tool arguments/);
 const history=[{role:'assistant',tool_calls:[{id:'first',function:{name:'search_memory',arguments:'{}'}},{function:{name:'search_memory',arguments:'{}'}}]},{role:'tool',tool_call_id:'first',content:'[]'},{role:'tool',content:'[]'},{role:'user',content:'Continue'}];
 let body;const replay=new ChatGPTChat(plan,{fetchImpl:async(_url,options)=>{body=JSON.parse(options.body);return stream([{type:'message',role:'assistant',content:[{type:'output_text',text:'Done.'}]}]);}});
 await replay.chat(history);const calls=body.input.filter(item=>item.type==='function_call'),outputs=body.input.filter(item=>item.type==='function_call_output');
 assert.equal(outputs[0].call_id,calls[0].call_id);assert.equal(outputs[1].call_id,calls[1].call_id);
});

// The signed-in ChatGPT plan streams complete output items but omits the final
// response.output array. Only the completed items are safe to dispatch/replay.
const planStream=(items,{unfinished=false,duplicate=false}={})=>new Response(new ReadableStream({start(controller){
 const send=value=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(value)+'\n\n'));
 for(const [output_index,item] of items.entries()){
  send({type:'response.output_item.added',output_index,item:{id:item.id,type:item.type,status:'in_progress'}});
  if(!unfinished){send({type:'response.output_item.done',output_index,item});if(duplicate)send({type:'response.output_item.done',output_index,item});}
 }
 send({type:'response.completed',response:{status:'completed',usage:{input_tokens:10,output_tokens:4}}});controller.close();
}}),{headers:{'Content-Type':'text/event-stream'}});
test('ChatGPT plan dispatches streamed completed function calls when terminal response omits output',async()=>{
 const plan={active:()=>({model:'gpt-fixture'}),access:async()=> 'secret'};
 let body;const chat=new ChatGPTChat(plan,{fetchImpl:async(_url,options)=>{body=JSON.parse(options.body);return planStream([{id:'fc_1',type:'function_call',status:'completed',namespace:'aurora',name:'search_memory',call_id:'call_1',arguments:'{"query":"synthetic"}'}]);}});
 const messages=[{role:'user',content:'Call search_memory for synthetic'}],tools=[{type:'function',function:{name:'search_memory',description:'Read-only search',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}}];
 const reply=await chat.chat(messages,tools,undefined,undefined,{requireReadTool:'search_memory'});
 assert.equal(body.tool_choice,'required');assert.equal(reply.tool_calls[0].function.name,'search_memory');assert.equal(reply.tool_calls[0].id,'call_1');
 messages.push(reply,{role:'tool',tool_call_id:'call_1',content:'[]'});chat.fetch=async(_url,options)=>{body=JSON.parse(options.body);return planStream([{id:'m_2',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'No matches.'}]}]);};
 const final=await chat.chat(messages,tools);assert.equal(final.content,'No matches.');assert(body.input.some(x=>x.type==='function_call'&&x.call_id==='call_1'));assert(body.input.some(x=>x.type==='function_call_output'&&x.call_id==='call_1'));
});
test('ChatGPT plan does not dispatch incomplete or repeated streamed output items',async()=>{
 const plan={active:()=>({model:'gpt-fixture'}),access:async()=> 'secret'};
 const tools=[{type:'function',function:{name:'search_memory',description:'Read-only search',parameters:{type:'object'}}}];
 const item={id:'fc_1',type:'function_call',status:'completed',name:'search_memory',call_id:'call_1',arguments:'{}'};
 for(const [options,expected] of [[{unfinished:true},/did not finish all output items/],[{duplicate:true},/invalid completed output item/]]){
  const chat=new ChatGPTChat(plan,{fetchImpl:async()=>planStream([item],options)});
  await assert.rejects(()=>chat.chat([{role:'user',content:'Read only'}],tools),expected);
 }
});
