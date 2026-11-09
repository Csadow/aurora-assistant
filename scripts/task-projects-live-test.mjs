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
const dir=await mkdtemp(join(tmpdir(),'aurora-project-tasks-live-')),vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data'));
await vault.init();await store.init();
const model=installed.model||installed.selected||'qwen3.5:9b',ollama=new Ollama(config.ollama,model);ollama.generationOptions={think:true,num_predict:6144,num_ctx:12288};
const assistant=new Assistant({vault,store,ollama,projects:new Projects([])}),start=Date.now(),events=[];
try{
 const project='20 Projects/Research.md';await vault.save(project,'# Research\n\nPrepare a report using the field notes.',null);await vault.addTask('Prepare research',{project});const parent=(await vault.tasks())[0],conversation=await store.conversation();
 await assistant.chat({id:conversation.id,message:'Using my saved Research project note, propose one subtask of Prepare research named "Outline report". Link it to that project and make it depend on Prepare research. Do not schedule it or change any existing task.',mode:'plan'},AbortSignal.timeout(240000),e=>{events.push(e);if(e.type==='tool')console.log(JSON.stringify({name:e.name,status:e.status}));});
 const proposals=await store.list('proposals');await writeFile(new URL('../artifacts/project-tasks-live-drafts.json',import.meta.url),JSON.stringify(proposals,null,2));
 const draft=proposals.find(p=>p.kind==='task'&&p.review?.after.text==='Outline report');assert(draft,'The local model must create a real review draft');assert.equal(proposals.length,1,'No unrelated review drafts');assert.equal(draft.status,'pending');assert.equal(draft.review.after.planDate,null);assert.equal(draft.review.after.startTime,null);assert.equal(draft.review.after.parent,parent.id);assert.equal(draft.review.after.project,project);assert.deepEqual(draft.review.after.dependsOn,[parent.id]);assert.equal((await vault.tasks()).length,1);
 const report={ok:true,model,seconds:Math.round((Date.now()-start)/1000),tools:events.filter(e=>e.type==='tool'&&e.status==='done').map(e=>e.name),draftOnly:true,relationshipsCorrect:true,existingTasksUnchanged:true};await writeFile(new URL('../artifacts/project-tasks-live.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await rm(dir,{recursive:true,force:true});}
