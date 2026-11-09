import {plannerUIChecks} from './planner-ui-checks.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {previewServer} from './mobile-preview.mjs';
const dir=await mkdtemp(join(tmpdir(),'aurora-mobile-test-')),artifact=new URL('../artifacts/',import.meta.url);
await mkdir(artifact,{recursive:true});
const server=previewServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
const browser=spawn('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${dir}`,'about:blank'],{stdio:['ignore','ignore','pipe']});let stderr='';browser.stderr.on('data',d=>stderr+=d);
let socket,session,sequence=0;const pending=new Map(),errors=[],results=[];
async function until(fn,label,timeout=15000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await new Promise(r=>setTimeout(r,80));}throw Error(`Timeout ${label}: ${last?.message||stderr.slice(-500)}`);}
function command(method,params={},sid=session){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`CDP timeout ${method}`)),15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));});}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
const click=s=>evaluate(`document.querySelector(${JSON.stringify(s)}).click()`);
const set=(s,v)=>evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(s)});n.value=${JSON.stringify(v)};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const submit=s=>evaluate(`document.querySelector(${JSON.stringify(s)}).requestSubmit()`);
const waitText=s=>until(()=>evaluate(`document.body.textContent.includes(${JSON.stringify(s)})`),s);
const check=s=>{results.push(s);console.log('PASS '+s);};
async function reload(){const previous=await evaluate('performance.timeOrigin');await command('Page.reload');await until(()=>evaluate(`performance.timeOrigin!==${previous}&&document.body.dataset.ready==='true'`),'reload');}
async function screenshot(name){const r=await command('Page.captureScreenshot',{format:'png'});await writeFile(new URL(name,artifact),Buffer.from(r.data,'base64'));}
try{
  const port=await until(async()=>(await readFile(join(dir,'DevToolsActivePort'),'utf8')).split('\n'),'Chromium');socket=new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);if(m.method==='Page.javascriptDialogOpening')command('Page.handleJavaScriptDialog',{accept:true});const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
  const target=await command('Target.createTarget',{url:'about:blank'},null);session=(await command('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId;
  await command('Runtime.enable');await command('Page.enable');await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride',{width:412,height:915,deviceScaleFactor:1,mobile:true});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`window.calls=[];window.exports=[];window.AuroraNative={hasKey:()=>true,takeShared:()=>'',generate:(id,raw)=>window.calls.push({id,...JSON.parse(raw)}),cancel:()=>{window.cancelled=true;},configureKey:()=>{},removeKey:()=>{},speak:text=>window.spoken=text,stopSpeech:()=>window.stopped=true,exportFile:(name,raw)=>window.exports.push({name,raw}),exportMarkdown:raw=>window.exports.push({name:'markdown',raw}),importFile:()=>{}};`});
  await command('Page.navigate',{url});await until(()=>evaluate("document.body.dataset.ready==='true'"),'app ready');
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));assert.equal(await evaluate('calls.length'),0);check('phone layout loads without desktop APIs or cloud calls');
  await click('[data-tab="memory"]');await click('#new-note');await set('#path','60 Inbox/Plans.md');await set('#content','# Plans\nBuild a caring assistant. [[Other]]\n<script>window.XSS=true</script>');await submit('#note-editor');await waitText('Saved on this device');check('Markdown note saved locally with script text inert');
  await set('#content','A durable unsaved draft');await waitText('Draft kept on this device');await reload();await waitText('Recovered your note draft');assert.equal(await evaluate('document.querySelector("#content").value'),'A durable unsaved draft');check('unsaved note draft survives app reload');
  await evaluate(`(async()=>{const {transact}=await import('./storage.js'),{saveNote}=await import('./core.js');await transact(s=>saveNote(s,s.notes[0].path,'Concurrent edit',s.notes[0].revision));})()`);
  await submit('#note-editor');await waitText('changed in another view');assert.equal(await evaluate('document.querySelector("#content").value'),'A durable unsaved draft');check('stale editor refuses overwrite and preserves draft');
  await click('#close-editor');await click('.note');await until(()=>evaluate('!document.querySelector("#note-editor").hidden'),'saved note reopened');await set('#content','# Plans\nBuild a caring assistant. <script>window.XSS=true</script>');await submit('#note-editor');await waitText('Saved on this device');await click('#close-editor');
  await click('#new-note');await set('#path','Private.md');await set('#content','PRIVATE-EXCLUDED-MARKER');await submit('#note-editor');await waitText('Saved on this device');await click('#close-editor');
  await set('#search','caring');assert.equal(await evaluate('document.querySelectorAll(".note").length'),1);await set('#search','');check('offline full-text memory search works');
  await click('[data-tab="chat"]');await set('#message','My draft survives');await reload();assert.equal(await evaluate('document.querySelector("#message").value'),'My draft survives');
  await command('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await submit('#composer');await waitText('Saved on device');assert.equal(await evaluate('calls.length'),0);check('offline request and composer draft persist without sending');
  await command('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:0,uploadThroughput:0});
  await click('.request .actions button');await until(()=>evaluate('document.querySelector("#review").open'),'preview');assert.equal(await evaluate('document.querySelectorAll("#memory-choice input:checked").length'),0);assert(!(await evaluate('document.querySelector("#payload").textContent')).includes('PRIVATE-EXCLUDED-MARKER'));
  await click('#memory-choice input');await click('#send');await until(()=>evaluate('calls.length===1'),'one provider request');
  const sent=await evaluate('calls[0]');assert(JSON.stringify(sent).includes('caring assistant'));assert(!JSON.stringify(sent).includes('PRIVATE-EXCLUDED-MARKER'));assert.equal(await evaluate('window.XSS'),undefined);check('review sends exactly selected memory and no unselected private note');
  await evaluate(`window.auroraResult({id:calls[0].id,body:{candidates:[{finishReason:'STOP',content:{parts:[{text:'Let’s choose one useful next step. <script>window.XSS=true</script>'}]}}]}})`);await waitText('Let’s choose');assert.equal(await evaluate('window.XSS'),undefined);
  await click('.request .actions button');assert((await evaluate('spoken')).includes('Let’s choose'));await click('#stop-speech');assert(await evaluate('stopped'));check('complete answer renders safely; speech starts only on Read aloud and can stop');
  await set('#message','Second request');await submit('#composer');await until(()=>evaluate('document.querySelectorAll(".request").length===2'),'second request');await click('.request:last-child .actions button');await click('#send');await until(()=>evaluate('calls.length===2'),'second send');
  await click('.request:last-child .actions button');await waitText('Stopped waiting');assert(await evaluate('cancelled'));await evaluate(`window.auroraResult({id:calls[1].id,body:{candidates:[{finishReason:'STOP',content:{parts:[{text:'LATE RESULT MUST NOT APPEAR'}]}}]}})`);assert(!(await evaluate('document.body.textContent')).includes('LATE RESULT MUST NOT APPEAR'));check('cancellation preserves uncertainty and ignores a late reply');
  await click('.request:last-child .actions button');await click('#send');await until(()=>evaluate('calls.length===3'),'retry after review');await reload();await waitText('app closed before the reply');assert.equal(await evaluate('calls.length'),0);check('in-flight request recovers without replay after restart');
  await set('#target','laptop');await set('#message','Check the project when my laptop returns');await submit('#composer');await waitText('For your laptop');assert.equal(await evaluate('document.querySelector(".request:last-child .actions").textContent'),'Cancel');check('laptop queue cannot be sent to cloud or executed');
  await screenshot('aurora-mobile-chat.png');
  await click('[data-tab="settings"]');await click('#export');await until(()=>evaluate('exports.length===1'),'backup export');const backup=JSON.parse((await evaluate('exports[0]')).raw);assert.equal(backup.notes.length,2);assert.equal(backup.requests.length,3);assert(!('key' in backup));check('backup contains memory and request history without credentials');
  const bundle={format:'aurora-mobile-v1',notes:[{path:'60 Inbox/Plans.md',content:'Different imported version'}],requests:[]};
  await evaluate(`window.auroraImport({name:'backup.json',raw:${JSON.stringify(JSON.stringify(bundle))}})`);await click('#confirm-import');await waitText('1 different notes kept');await click('[data-tab="memory"]');await waitText('(import 1).md');check('reviewed import preserves both conflicting note versions');
  await evaluate(`window.auroraImport({name:'backup.json',raw:${JSON.stringify(JSON.stringify(bundle))}})`);await click('#confirm-import');await waitText('Imported 0 notes');check('reimport does not duplicate conflict copies');
  await evaluate(`window.auroraImport(${JSON.stringify({name:'Thought.md',raw:'# Thought\nPortable Markdown'})})`);await click('#confirm-import');await waitText('Thought.md');check('single Markdown import works');
  await evaluate(`window.auroraImport({name:'invalid.json',raw:'{"format":"aurora-mobile-v1","notes":[{"path":"../bad.md","content":"bad"}],"requests":[]}'})`);await waitText('relative Markdown path');check('unsafe import paths are rejected');
  const before=await evaluate(`(async()=> (await (await import('./storage.js')).transact()).notes.length)()`);
  const conflictBundle={format:'aurora-mobile-v1',notes:[{path:'MustNotCommit.md',content:'uncommitted'}],requests:[{...backup.requests[0],text:'Conflicting history'}]};
  await evaluate(`window.auroraImport({name:'conflict.json',raw:${JSON.stringify(JSON.stringify(conflictBundle))}})`);await click('#confirm-import');await waitText('Import was cancelled');assert.equal(await evaluate(`(async()=> (await (await import('./storage.js')).transact()).notes.length)()`),before);await click('#cancel-import');check('failed import rolls back every note and request atomically');
  await click('[data-tab="chat"]');await evaluate(`window.auroraShared('A link shared from another app')`);assert((await evaluate('document.querySelector("#message").value')).includes('A link shared'));assert.equal(await evaluate('calls.length'),0);check('Android shared text enters a local draft without sending');
  await click('.request:first-child .actions button:last-child');await reload();await waitText('Recovered your note draft');assert((await evaluate('document.querySelector("#content").value')).includes('Let’s choose'));await click('#close-editor');check('Save as note draft survives restart before its first edit');
  await click('[data-tab="memory"]');await evaluate('document.querySelector("#notice").hidden=true');await screenshot('aurora-mobile-memory.png');
  await command('Emulation.setDeviceMetricsOverride',{width:360,height:640,deviceScaleFactor:1,mobile:true});assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));check('small-screen layout stays within viewport');
  await command('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  await plannerUIChecks({evaluate,until,check,root:'#mobile-planner',open:'document.querySelector("[data-tab=planner]").click()'});
  assert.equal(await evaluate('calls.length'),0);check('phone planner needs no network or model calls');
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));await evaluate('document.querySelectorAll("#mobile-planner>details").forEach(n=>n.open=false);window.scrollTo(0,0)');await screenshot('aurora-mobile-planner.png');
  await command('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:0,uploadThroughput:0});
  await reload();await until(()=>evaluate('document.querySelector("#mobile-planner").textContent.includes("Planner second task")'),'planner restart');check('offline tasks persist across app restart');
  assert.equal(errors.length,0,JSON.stringify(errors));check('no uncaught browser errors');
}finally{
  await writeFile(new URL('mobile-browser-results.json',artifact),JSON.stringify({date:new Date().toISOString(),checks:results,errors,limitations:'Native bridge mocked; no live API request or physical Android device test.'},null,2));
  socket?.close();browser.kill('SIGTERM');server.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>setTimeout(r,300));await rm(dir,{recursive:true,force:true});
}
