import assert from 'node:assert/strict';
import {rm,writeFile,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {config} from '../src/config.mjs';
import {sha} from '../src/vault.mjs';
const base=`http://127.0.0.1:${config.port}`,bootstrap=await(await fetch(base+'/api/bootstrap')).json();
const post=async(path,data)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':bootstrap.token},body:JSON.stringify(data),signal:AbortSignal.timeout(300000)});if(!r.ok)throw new Error(await r.text());return r;};
assert((await(await fetch(base+'/api/computer')).json()).online,'Desktop must be connected');
const c=await(await post('/api/conversations',{})).json(),start=Date.now();
try{
 const r=await post('/api/chat',{id:c.id,message:'Open https://example.com in Aurora Browser, read the page, and tell me its heading in one sentence. Use your browser tool. Do not create memories or tasks.'});
 const events=[];let buffer='';const decoder=new TextDecoder();for await(const value of r.body){buffer+=decoder.decode(value,{stream:true});let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!line)continue;const e=JSON.parse(line);events.push(e);if(e.type==='tool'||e.type==='thinking')console.log(JSON.stringify(e));}}
 const done=events.find(e=>e.type==='done');assert(done,JSON.stringify(events.filter(e=>e.type==='error')));const answer=done.conversation.messages.at(-1).content;
 const actions=(await(await fetch(base+'/api/actions')).json()).filter(a=>a.conversation===c.id);assert(actions.some(a=>a.kind==='computer'&&a.status==='completed'&&a.payload.operation==='open_url'&&new URL(a.payload.url).hostname==='example.com'),JSON.stringify(actions));assert.match(answer,/Example Domain/i);
 const result={passed:true,version:bootstrap.version,model:bootstrap.model,seconds:Math.round((Date.now()-start)/100)/10,answer,actions:actions.map(a=>({operation:a.payload.operation,status:a.status}))};await writeFile(new URL('../artifacts/installed-computer-smoke.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
 const journal=`90 Journal/${c.created.slice(0,10)} ${c.id}.md`;await rm(join(config.data,'conversations',c.id+'.json'),{force:true});await rm(join(config.vault,journal),{force:true});await rm(join(config.vault,'.aster/history',sha(journal)),{recursive:true,force:true});
 for(const folder of ['actions','proposals'])for(const name of await readdir(join(config.data,folder))){if(!name.endsWith('.json'))continue;const file=join(config.data,folder,name);const record=JSON.parse(await readFile(file,'utf8'));if(record.conversation===c.id)await rm(file);}
}
