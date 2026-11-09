import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {homedir} from 'node:os';
import {config} from '../src/config.mjs';
const base=`http://127.0.0.1:${config.port}`,boot=await(await fetch(base+'/api/bootstrap')).json();
const api=async(path,data)=>{const r=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-Aster-Token':boot.token},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(await r.text());return r.json();};
const until=async fn=>{const end=Date.now()+15000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for the fixture editor');};
const dir=await mkdtemp(join(homedir(),'.cache/aurora-document-check-')),path=join(dir,basename(dir)+'.txt'),c=await api('/api/conversations',{});let target;
const windows=async()=>(await api('/api/computer/action',{conversation:c.id,input:{operation:'windows',reason:'Check only the disposable editor fixture'}})).result.windows;
const close=async()=>{
  if(!target)return;const action=await api('/api/action-propose',{kind:'computer',conversation:c.id,input:{operation:'close_window',windowId:target.id,reason:'Close only the disposable editor fixture'}});
  assert(action.payload.target.title.includes(basename(path)));await api('/api/action-decide',{id:action.id,decision:'approve',digest:action.digest});
  const result=await until(async()=>{const r=await api('/api/action?id='+action.id);return r.status==='running'?null:r;});assert.equal(result.status,'completed');
  await until(async()=>!(await windows()).some(w=>w.id===target.id));target=null;
};
try{
  await writeFile(path,'Aurora disposable document opening check.\n');
  const opened=await api('/api/computer/action',{conversation:c.id,input:{operation:'open_path',path,reason:'Verify the configured default editor opens a visible terminal'}});assert.equal(opened.status,'completed');
  const action=await api('/api/action?id='+opened.id);assert.equal(action.payload.opener.kind,'terminal');
  target=await until(async()=>(await windows()).find(w=>w.title.includes(basename(path))));assert(target);
  const result={ok:true,version:boot.version,handler:action.payload.opener.handler,terminal:action.payload.opener.command,visibleWindow:true};
  await close();result.closedFixture=true;await writeFile(new URL('../artifacts/document-open-live-results.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
  if(target)await close().catch(e=>console.error('Fixture cleanup:',e.message));
  for(const name of await readdir(join(config.data,'actions'))){if(!name.endsWith('.json'))continue;const file=join(config.data,'actions',name);if(JSON.parse(await readFile(file,'utf8')).conversation===c.id)await rm(file);}
  await rm(join(config.data,'conversations',c.id+'.json'),{force:true});await rm(dir,{recursive:true,force:true});
}
