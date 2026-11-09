import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Computer,automaticComputerOperations} from '../src/computer.mjs';
import {Settings} from '../src/settings.mjs';
import {Store} from '../src/store.mjs';
import {Actions} from '../src/actions.mjs';
import {DesktopComputer,keyChord} from '../desktop/computer.mjs';
import {webURL,publicAddress} from '../desktop/web-url.mjs';
import {createApp} from '../src/server.mjs';

test('computer broker revokes stopped, timed-out and restarted jobs without replay',async()=>{
 const settings={value:{systemEnabled:true,computerEnabled:true}},computer=new Computer(settings,{timeout:30});
 assert.throws(()=>computer.request('execute',{}),/desktop app/);let lease=computer.connect().lease;
 const controller=new AbortController(),pending=computer.request('execute',{operation:'click'},controller.signal);const job=computer.poll(lease).job;assert(job);assert.equal(computer.poll(lease).job,null);
 controller.abort();await assert.rejects(pending,/stopped/);assert.deepEqual(computer.poll(lease).active,[]);assert(computer.complete(lease,job.id,{content:'late'}).ignored);
 const timeout=computer.request('execute',{});await assert.rejects(timeout,/timed out/);assert.equal(computer.poll(lease).job,null);
 const restart=computer.request('execute',{});computer.connect();await assert.rejects(restart,/stopped/);assert.throws(()=>computer.poll(lease),/expired/);
 settings.value.computerEnabled=false;assert.throws(()=>computer.request('execute',{}),/paused/);
});
test('routine computer actions execute, input waits for exact approval, pause invalidates execution',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-computer-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new Store(dir);await store.init();const settings=new Settings(dir);await settings.init();const calls=[];
 const computer={enabled(){if(!settings.value.computerEnabled)throw new Error('paused');},prepare:async p=>p,execute:async p=>{calls.push(p);return {content:'Done'};}};
 const actions=new Actions({store,settings,computer});const convo=await store.conversation();
 assert.equal((await actions.computerAction({operation:'open_url',url:'https://example.com'},convo.id)).status,'completed');assert.equal(calls.length,1);
 const staged=await actions.computerAction({operation:'type_text',text:'Reviewed text'},convo.id);assert.equal(staged.status,'pending');assert.equal(calls.length,1);
 const a=await store.get('actions',staged.id);await assert.rejects(actions.decide(a.id,'approve','wrong'),/changed/);
 await settings.save({computerEnabled:false});await assert.rejects(actions.decide(a.id,'approve',a.digest),/paused/);assert.equal(calls.length,1);
 await settings.save({computerEnabled:true});await actions.decide(a.id,'approve',a.digest);while(actions.running.size)await new Promise(r=>setTimeout(r,5));assert.equal(calls.length,2);await assert.rejects(actions.decide(a.id,'approve',a.digest),/already/);
 for(const op of ['click','type_text','key','close_window','browser_click','browser_fill','browser_key'])assert(!automaticComputerOperations.has(op));
});
test('a page read with a URL is rejected before creating an action or desktop job',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-read-contract-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new Store(dir);await store.init();const settings=new Settings(dir);await settings.init();
 const computer=new Computer(settings),actions=new Actions({store,settings,computer});const lease=computer.connect().lease;
 await assert.rejects(actions.computerAction({operation:'browser_read',url:'https://example.com/',reason:'Read this page'}),/Navigate first.*open_url/);
 assert.equal((await store.list('actions')).length,0);assert.equal(computer.poll(lease).job,null);
 const read=computer.prepare({operation:'browser_read',offset:20});const job=computer.poll(lease).job;
 assert.equal(job.input.operation,'browser_read');assert.equal(job.input.offset,20);
 computer.complete(lease,job.id,{operation:'browser_read',offset:20});assert.deepEqual(await read,{operation:'browser_read',offset:20});
});
test('opening a path cannot masquerade as writing content',async()=>{
 const computer=new Computer({value:{systemEnabled:true,computerEnabled:true}}),lease=computer.connect().lease;
 for(const field of ['text','content'])await assert.rejects(computer.prepare({operation:'open_path',path:'/tmp/note.txt',[field]:'new text'}),/propose_file_edit/);
 assert.equal(computer.poll(lease).job,null);
});
test('computer target identity, relative bounds, protected windows and key arguments fail closed',async()=>{
 const client={address:'0xabc',pid:123,class:'test-editor',title:'Draft',at:[100,80],size:[800,600],mapped:true,hidden:false};
 const control=new DesktopComputer({data:'/tmp/aurora-protected',browser:{},execute:async()=>({stdout:JSON.stringify([client])})});
 const p=await control.prepare({operation:'click',windowId:'0xabc',x:30,y:50});assert.equal(p.target.app,'test-editor');
 await assert.rejects(control.prepare({operation:'click',windowId:'0xabc',x:800,y:50}),/integer/);
 client.title='Different document';await assert.rejects(control.target('0xabc',p.target),/changed/);
 client.class='aurora-assistant';await assert.rejects(control.target('0xabc'),/protected/);
 assert.throws(()=>keyChord('Ctrl+Return; rm -rf'),/named key/);assert.deepEqual(keyChord('Ctrl+s'),{mods:'CTRL',key:'s'});
 await assert.rejects(control.prepare({operation:'open_path',path:'/proc/self/environ'}),/protected/);
});
test('automated browser navigation excludes privileged schemes, credentials and private addresses',()=>{
 assert.equal(webURL('https://example.com/a?q=one'),'https://example.com/a?q=one');
 for(const u of ['file:///etc/passwd','javascript:alert(1)','aster://app/api/bootstrap','http://user:pass@example.com','http://localhost:4717','http://127.1','http://2130706433','http://10.1.2.3','http://[::1]','http://[::ffff:127.0.0.1]','https://router.local'])assert.throws(()=>webURL(u));
 assert(!publicAddress('169.254.169.254'));assert(!publicAddress('100.64.0.1'));assert(publicAddress('1.1.1.1'));
});
test('computer transport and action endpoints require local CSRF authorization',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-computer-api-'));const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),projects:[],embedding:'',ollamaClient:{status:async()=>({online:true}),check:async()=>{}}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,token=(await(await fetch(base+'/api/bootstrap')).json()).token;
 for(const endpoint of ['connect','poll','complete','action'])assert.equal((await fetch(base+'/api/computer/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 const post=(path,data)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':token},body:JSON.stringify(data)});
 const lease=(await(await post('/api/computer/connect',{})).json()).lease;assert(lease);await post('/api/settings',{computerEnabled:false});assert.equal((await post('/api/computer/action',{input:{operation:'windows'}})).status,403);
 assert.equal((await(await fetch(base+'/api/computer')).json()).enabled,false);
});

test('empty local model answer after a computer action retries only the summary, never the action',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-computer-summary-'));t.after(()=>rm(dir,{recursive:true,force:true}));let calls=0,executions=0;
 const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),projects:[],embedding:'',ollamaClient:{check:async()=>{},chat:async(messages,tools,signal,onChunk,options)=>{
  calls++;if(calls===1)return {role:'assistant',content:'',tool_calls:[{function:{name:'computer_action',arguments:{operation:'open_url',url:'https://example.com',reason:'User request'}}}]};
  if(calls===2)return {role:'assistant',content:''};
  assert.equal(tools,undefined);assert.equal(options.think,false);assert(messages.some(m=>m.role==='tool'&&m.content.includes('Example Domain')));const content='The heading is Example Domain.';onChunk(content);return {role:'assistant',content,metrics:{}};
 }}});
 app.actions.computerAction=async()=>{executions++;return {status:'completed',kind:'computer',result:{text:'Example Domain',url:'https://example.com'}};};
 const c=await app.store.conversation(),events=[];await app.assistant.chat({id:c.id,message:'Open example.com and report the heading'},new AbortController().signal,e=>events.push(e));
 assert.equal(calls,3);assert.equal(executions,1);assert.match(events.find(e=>e.type==='done').conversation.messages.at(-1).content,/Example Domain/);
});
