import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Vault} from '../src/vault.mjs';
import {Store} from '../src/store.mjs';
import {Ollama} from '../src/ollama.mjs';
import {Assistant} from '../src/assistant.mjs';
const dir=await mkdtemp(join(tmpdir(),'aurora-task-live-'));
try{
 const vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data'));await vault.init();await store.init();
 const installed=await(await fetch('http://127.0.0.1:4717/api/local-model')).json();
 const ollama=new Ollama('http://127.0.0.1:11434',installed.model);ollama.generationOptions=installed.generation;
 const assistant=new Assistant({vault,store,ollama,projects:{items:[]}});
 await vault.addTask('Practice Linux networking',{planDate:'2026-10-19',startTime:'10:00',due:'2026-10-22',duration:30});
 const c=await store.conversation(),events=[],started=Date.now();
 await assistant.chat({id:c.id,message:'Move my personal task Practice Linux networking to 13:00 on 2026-10-20, for 45 minutes. Keep its deadline. Prepare the change for me to review.'},AbortSignal.timeout(360000),e=>{events.push(e);if(e.type==='tool')console.log(JSON.stringify(e));});
 console.log(JSON.stringify({answer:events.filter(e=>e.type==='chunk').map(e=>e.text).join('')}));
 const p=(await store.list('proposals')).find(p=>p.kind==='task_update');assert(p,'Model must propose an existing-task update');
 assert.equal(p.review.after.startTime,'13:00');assert.equal(p.review.after.planDate,'2026-10-20');assert.equal(p.review.after.duration,45);assert.equal(p.review.after.due,'2026-10-22');assert.equal((await vault.tasks())[0].startTime,'10:00');
 await assistant.acceptProposal(p.id,'accept');assert.equal((await vault.tasks())[0].startTime,'13:00');
 const result={passed:true,model:installed.model,generation:installed.generation,seconds:Math.round((Date.now()-started)/1000),tools:events.filter(e=>e.type==='tool').map(e=>({name:e.name,status:e.status})),answer:events.filter(e=>e.type==='chunk').map(e=>e.text).join('')};
 await writeFile(new URL('../artifacts/task-proposals-live.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await rm(dir,{recursive:true,force:true});}
