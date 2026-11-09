import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DesktopOutcomePicker} from '../src/desktop-outcome-picker.mjs';
import {DesktopComputer} from '../desktop/computer.mjs';
import {createApp} from '../src/server.mjs';
const page={url:'https://example.com/final?week=6#summary',title:'Report <b>6</b>',navigation:2};
const window={id:'0x42',pid:42,app:'Editor',title:'report.md — Editor'};
function fixture(t,options={}){
 let now=100,enabled=true,online=true,response={page:structuredClone(page),windows:[structuredClone(window)]};const requests=[];
 const computer={lease:'first',enabled(){if(!enabled)throw Error('paused');},status:()=>({online}),request:async(method,input)=>{assert.equal(method,'outcome_targets');assert.deepEqual(Object.keys(input),['kind']);requests.push(input);return structuredClone(response);}};
 const picker=new DesktopOutcomePicker(computer,{now:()=>now,...options});t.after(()=>picker.close());
 return {picker,computer,requests,set time(v){now=v;},set enabled(v){enabled=v;},set online(v){online=v;},set response(v){response=v;},get response(){return response;}};
}
test('picker returns bounded labels only, copies reviewed optional fields and never executes an action',async t=>{
 const f=fixture(t);f.response.page.text='SECRET BODY';f.response.windows[0].x=30;
 const browser=await f.picker.preview({kind:'browser'});assert.deepEqual(browser.targets,[{key:'page',url:page.url,title:page.title}]);assert(!JSON.stringify(browser).includes('SECRET'));
 assert.deepEqual(await f.picker.select({id:browser.id,target:'page',includeTitle:true}),{kind:'browser',requirement:{url:page.url,title:page.title}});
 await assert.rejects(f.picker.select({id:browser.id,target:'page'}),/expired/);
 const noTitle=await f.picker.preview({kind:'browser'});f.response.page.title='Updated dynamic title';assert.deepEqual((await f.picker.select({id:noTitle.id,target:'page'})).requirement,{url:page.url});
 const w=await f.picker.preview({kind:'window'});assert.deepEqual(w.targets,[{key:window.id,title:window.title,app:window.app}]);assert.deepEqual((await f.picker.select({id:w.id,target:window.id,includeApp:true})).requirement,{title:window.title,app:window.app});
 const noApp=await f.picker.preview({kind:'window'});assert.deepEqual((await f.picker.select({id:noApp.id,target:window.id})).requirement,{title:window.title});assert.equal(f.requests.length,8);
});
test('redirects, title changes, reloads and same-title replacement windows require a fresh preview',async t=>{
 for(const change of [{url:'https://example.com/elsewhere'},{title:'Report 7'},{navigation:3}]){
  const f=fixture(t),p=await f.picker.preview({kind:'browser'});Object.assign(f.response.page,change);await assert.rejects(f.picker.select({id:p.id,target:'page',includeTitle:true}),/changed/);
 }
 for(const change of [{title:'other-report.md — Editor'},{app:'Other'},{pid:43},{id:'0x43'}]){
  const f=fixture(t),p=await f.picker.preview({kind:'window'});Object.assign(f.response.windows[0],change);await assert.rejects(f.picker.select({id:p.id,target:window.id,includeApp:true}),/changed/);
 }
 const f=fixture(t),p=await f.picker.preview({kind:'window'});f.response.windows=[];await assert.rejects(f.picker.select({id:p.id,target:window.id}),/changed/);
});
test('window order, position and unrelated windows do not change the selected identity',async t=>{
 const f=fixture(t);f.response.windows.push({...window,id:'0x43',pid:43,title:'other.md'});const p=await f.picker.preview({kind:'window'});f.response.windows.reverse();f.response.windows[1].x=500;
 assert.deepEqual((await f.picker.select({id:p.id,target:window.id})).requirement,{title:window.title});
});
test('expiry, reconnect, paused/offline control and abort reject copying; previews are bounded and consumed',async t=>{
 const f=fixture(t,{limit:2,ttl:1000}),p=await f.picker.preview({kind:'browser'});f.time=1100;await assert.rejects(f.picker.select({id:p.id,target:'page'}),/expired/);
 f.time=2000;const old=await f.picker.preview({kind:'browser'});f.computer.lease='new';await assert.rejects(f.picker.select({id:old.id,target:'page'}),/changed/);
 f.enabled=false;await assert.rejects(f.picker.preview({kind:'window'}),/paused/);f.enabled=true;f.online=false;await assert.rejects(f.picker.preview({kind:'window'}),/desktop app/);f.online=true;
 const first=await f.picker.preview({kind:'browser'});await f.picker.preview({kind:'browser'});await f.picker.preview({kind:'window'});assert.equal(f.picker.previews.size,2);await assert.rejects(f.picker.select({id:first.id,target:'page'}),/expired/);
 const abort=new AbortController();abort.abort();await assert.rejects(f.picker.preview({kind:'browser'},abort.signal));
 const active=await f.picker.preview({kind:'browser'});f.computer.request=async()=>{f.computer.lease='third';return f.response;};await assert.rejects(f.picker.select({id:active.id,target:'page'}),/changed/);
 f.picker.close();assert.equal(f.picker.previews.size,0);
});
test('invalid inputs, credential URLs, oversized and duplicate identities cannot become requirements',async t=>{
 const f=fixture(t);for(const input of [{kind:'command'},{kind:'browser',execute:true},null])await assert.rejects(f.picker.preview(input));assert.equal(f.requests.length,0);
 f.response.page.url='https://user:secret@example.com/';await assert.rejects(f.picker.preview({kind:'browser'}),/credentials/);
 f.response.page={...page,title:'x'.repeat(501)};await assert.rejects(f.picker.preview({kind:'browser'}));
 f.response.windows=[window,window];await assert.rejects(f.picker.preview({kind:'window'}),/duplicate/);
 f.response.windows=[{...window,pid:null}];await assert.rejects(f.picker.preview({kind:'window'}),/identity/);
 f.response.windows=[window];const p=await f.picker.preview({kind:'window'});await assert.rejects(f.picker.select({id:p.id,target:'0x99'}),/displayed/);
});
test('native target enumeration excludes protected, redacted and truncated labels without focusing a window',async()=>{
 const c=(address,title,klass='Editor')=>({address,title,class:klass,pid:42,mapped:true,hidden:false});
 const desktop=new DesktopComputer({data:'/tmp/picker-enumeration',browser:{outcomeTarget:()=>page},execute:async()=>{throw Error('No system action expected');}});
 desktop.clients=async()=>[c('0x42',window.title),c('0x43','Password manager','keepass'),c('0x44','x'.repeat(201)),c('0x45','access_token=secret'),{...c('0x47','Unknown owner'),pid:0},{...c('0x46','Hidden'),hidden:true}];
 assert.deepEqual(await desktop.handle('outcome_targets',{kind:'window'}),{windows:[window],omitted:3});assert.deepEqual(await desktop.handle('outcome_targets',{kind:'browser'}),{page});await assert.rejects(desktop.handle('outcome_targets',{kind:'window',operation:'click'}));
 desktop.clients=async()=>[...Array.from({length:80},(_,i)=>c('0x'+(100+i).toString(16),'x'.repeat(201))),c('0x999','Beyond the ordinary window observer')];assert.deepEqual(await desktop.handle('outcome_targets',{kind:'window'}),{windows:[],omitted:81});
});
test('picker API is authenticated and leaves workflows/actions empty until ordinary task review',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-picker-')),app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),embedding:'',projects:[],ollamaClient:{status:async()=>({online:true}),check:async()=>{}}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.outcomePicker.close();await app.workflows.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,token=(await(await fetch(base+'/api/bootstrap')).json()).token;
 const post=(name,data,auth=true)=>fetch(base+'/api/workflow-outcome-'+name,{method:'POST',headers:{'Content-Type':'application/json',...auth?{'X-Aster-Token':token}:{}},body:JSON.stringify(data)});
 for(const endpoint of ['preview','select'])assert.equal((await post(endpoint,{kind:'browser'},false)).status,403);
 app.computer.connect();app.computer.request=async(method,input)=>{assert.equal(method,'outcome_targets');assert.equal(input.kind,'browser');return {page};};
 const preview=await(await post('preview',{kind:'browser'})).json();assert(preview.id);const selected=await(await post('select',{id:preview.id,target:'page',includeTitle:true})).json();assert.deepEqual(selected.requirement,{url:page.url,title:page.title});
 assert.equal((await app.store.list('actions')).length,0);assert.equal((await app.store.list('workflows')).length,0);await app.settings.save({computerEnabled:false});assert.equal((await post('preview',{kind:'browser'})).status,403);
});
