import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir,mkdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {config} from '../src/config.mjs';
import {sha} from '../src/vault.mjs';
const base=`http://127.0.0.1:${config.port}`,boot=await(await fetch(base+'/api/bootstrap')).json();
const request=async(path,data)=>{const r=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-Aster-Token':boot.token},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error(await r.text());return r;};
const api=async(...args)=>(await request(...args)).json();
assert.equal((await api('/api/computer')).online,true,'Desktop connection required');
const goalFor=path=>`Open https://example.com in Aurora Browser, read the actual page title, then save that title followed by a newline to ${path}. Read the saved file back to verify it. Use browser and file tools. Only modify this one disposable file. Do not run commands, send messages, use cloud models, or change any other files.`;
const resume=process.argv[2]==='--resume'?process.argv[3]:null;
let dir,path,c,id,record,approved=0;
if(resume){
  assert.match(resume,/^[0-9a-f-]{36}$/);record=await api('/api/workflow?id='+resume);
  assert.equal(record.status,'paused');assert.equal(record.operations.length,0,'Resume harness only accepts a test interrupted before any operations');
  path=record.goal.match(/to (\/tmp\/aurora-laptop-live-[A-Za-z0-9]+\/heading\.txt)\./)?.[1];assert(path);assert.equal(record.goal,goalFor(path));
  dir=path.slice(0,-'/heading.txt'.length);await mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});assert((await lstat(dir)).isDirectory());
  c=await api('/api/conversation?id='+record.conversation);id=record.id;
}else{dir=await mkdtemp(join(tmpdir(),'aurora-laptop-live-'));path=join(dir,'heading.txt');c=await api('/api/conversations',{});}
const start=Date.now();
try{
  if(resume)await api('/api/workflow-control',{id,operation:'resume'});
  else{
    const events=(await(await request('/api/chat',{id:c.id,message:goalFor(path),mode:'act'})).text()).trim().split('\n').map(JSON.parse);
    id=events.find(e=>e.type==='workflow')?.workflow.id;assert(id,JSON.stringify(events));assert.equal(events.at(-1).type,'done');
  }
  let previous='';
  while(Date.now()-start<900000){
    record=await api('/api/workflow?id='+id);const progress=JSON.stringify([record.status,record.current,record.calls,record.operations.at(-1)?.name]);if(progress!==previous){console.log(progress);previous=progress;}
    if(['completed','paused','needs_verification','cancelled'].includes(record.status))break;
    for(const op of record.operations.filter(o=>o.action&&o.status==='waiting_approval')){
      const a=await api('/api/action?id='+op.action);if(a.status!=='pending')continue;
      assert.equal(a.kind,'write','Only the exact disposable file edit may be approved');assert.equal(a.payload.path,path);assert.equal(a.payload.content.trim(),'Example Domain');assert.equal(a.workflow.id,id);
      await api('/api/action-decide',{id:a.id,decision:'approve',digest:a.digest});approved++;
    }
    await new Promise(r=>setTimeout(r,500));
  }
  assert.equal(record.status,'completed',record.error||'Task timed out');assert.equal((await readFile(path,'utf8')).trim(),'Example Domain');
  // open_url already returns a freshly read DOM snapshot. Requiring an additional
  // browser_read would reject correct execution that uses that same evidence.
  const observed=record.operations.findIndex(o=>o.name==='computer_action'&&['open_url','browser_read'].includes(o.arguments.operation)&&o.status==='completed'&&o.result?.url==='https://example.com/'&&o.result?.title==='Example Domain'&&typeof o.result?.text==='string'&&o.result?.revision);
  const edited=record.operations.findIndex(o=>o.name==='propose_file_edit'&&o.arguments.path===path&&o.status==='completed');
  assert(observed>=0&&edited>observed,'Read actual browser evidence before saving the file');
  assert(record.operations.slice(edited+1).some(o=>o.name==='read_system_file'&&o.result?.path===path&&o.result?.content==='Example Domain\n'&&o.result?.revision===sha('Example Domain\n')&&o.status==='completed'));
  const result={ok:true,version:boot.version,model:boot.model,resumed:!!resume,seconds:Math.round((Date.now()-start)/1000),approvals:approved,record};await writeFile(new URL('../artifacts/laptop-task-live-results.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:true,seconds:result.seconds,approvals:approved}));
}catch(e){await writeFile(new URL('../artifacts/laptop-task-live-results.json',import.meta.url),JSON.stringify({ok:false,error:e.message,record},null,2));throw e;}
finally{
  if(id){const w=await api('/api/workflow?id='+id).catch(()=>null);if(w&&!['completed','cancelled'].includes(w.status))await api('/api/workflow-control',{id,operation:'cancel'});await new Promise(r=>setTimeout(r,1000));}
  // Remove only records made by this test. Preserve all pre-existing user data.
  for(const kind of ['actions','proposals'])for(const name of await readdir(join(config.data,kind))){if(!name.endsWith('.json'))continue;const file=join(config.data,kind,name),r=JSON.parse(await readFile(file,'utf8'));if(r.conversation===c.id||id&&r.workflow?.id===id)await rm(file);}
  if(id)await rm(join(config.data,'workflows',id+'.json'),{force:true});
  const journal=`90 Journal/${c.created.slice(0,10)} ${c.id}.md`;await rm(join(config.data,'conversations',c.id+'.json'),{force:true});await rm(join(config.vault,journal),{force:true});await rm(join(config.vault,'.aster/history',sha(journal)),{recursive:true,force:true});await rm(dir,{recursive:true,force:true});
}
