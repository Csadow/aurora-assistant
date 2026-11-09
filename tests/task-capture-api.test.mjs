import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
test('capture HTTP API enforces local origin and token, persists preview, and saves once',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-capture-api-'));
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],ollamaClient:{status:async()=>({online:false,models:[]})}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,boot=await(await fetch(base+'/api/bootstrap')).json();
 const post=(data,headers={})=>fetch(base+'/api/task-capture',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)}),headers={'X-Aster-Token':boot.token};
 const initial=await(await fetch(base+'/api/task-capture')).json(),fields={text:'Captured through API',project:'',duration:'40',due:'2091-02-12',planDate:'',startTime:''};
 assert.equal((await post({action:'save',revision:initial.revision,fields})).status,403);
 assert.equal((await post({action:'save',revision:initial.revision,fields},{...headers,Origin:'https://external.invalid'})).status,403);
 assert.equal((await fetch(base+'/api/task-capture',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 const saved=await(await post({action:'save',revision:initial.revision,fields},headers)).json();assert.deepEqual(saved.fields,fields);
 assert.equal((await post({action:'clear',revision:initial.revision},headers)).status,409);
 const p=await(await post({action:'preview',revision:saved.revision},headers)).json();assert.equal((await app.vault.tasks()).length,0);assert.equal(p.proposal.status,'pending');
 assert((await(await fetch(base+'/api/proposals')).json()).some(r=>r.id===p.proposalId));
 for(let i=0;i<2;i++){const r=await post({action:'accept',revision:p.revision},headers);assert.equal(r.status,200);assert.equal((await r.json()).proposal.status,'accepted');}
 assert.equal((await app.vault.tasks()).filter(t=>t.text===fields.text).length,1);
 const module=await fetch(base+'/task-capture.js');assert.match(module.headers.get('content-type'),/javascript/);assert.match(await module.text(),/task-capture-title/);
});
