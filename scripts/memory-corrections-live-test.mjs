import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Vault} from '../src/vault.mjs';
import {Store} from '../src/store.mjs';
import {Ollama} from '../src/ollama.mjs';
import {Assistant} from '../src/assistant.mjs';
import {Projects} from '../src/projects.mjs';
import {config} from '../src/config.mjs';
const installed=await(await fetch('http://127.0.0.1:4717/api/local-model')).json();
const dir=await mkdtemp(join(tmpdir(),'aurora-memory-corrections-live-')),vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data'));
await vault.init();await store.init();
const model=installed.model||installed.selected||'qwen3.5:9b',ollama=new Ollama(config.ollama,model);ollama.generationOptions={think:true,num_predict:6144,num_ctx:12288};
const assistant=new Assistant({vault,store,ollama,projects:new Projects([])}),start=Date.now(),events=[];
try{
 const path='10 Profile/Meeting.md',before='My weekly study meeting is on Thursday.',after='My weekly study meeting is on Friday.';
 const n=await vault.save(path,'# Meeting\n\n'+before+'\n',null),conversation=await store.conversation();
 await assistant.chat({id:conversation.id,message:'My weekly study meeting has changed from Thursday to Friday. Correct the existing Meeting memory, preserving everything else. Prepare the correction for review.',mode:'general'},AbortSignal.timeout(240000),e=>{events.push(e);if(e.type==='tool')console.log(JSON.stringify({name:e.name,status:e.status}));});
 const proposals=await store.list('proposals');assert.equal(proposals.length,1);const p=proposals[0];assert.equal(p.kind,'memory_correction');assert.equal(p.path,path);assert.equal(p.status,'pending');assert(p.before.includes('Thursday'));assert(p.after.includes('Friday'));assert(!p.after.includes('Thursday'));assert.equal((await vault.read(path)).revision,n.revision);
 const report={ok:true,model,seconds:Math.round((Date.now()-start)/1000),tools:events.filter(e=>e.type==='tool'&&e.status==='done').map(e=>e.name),draftOnly:true,sourceUnchanged:true};await writeFile(new URL('../artifacts/memory-corrections-live.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await rm(dir,{recursive:true,force:true});}
