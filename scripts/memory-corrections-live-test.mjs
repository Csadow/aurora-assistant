// Cold local-model trials use a new conversation and vault for each synthetic fact.
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
const cases={
 meeting:{path:'10 Profile/Meeting.md',before:'My weekly study meeting is on Thursday.',after:'My weekly study meeting is on Friday.',message:'My weekly study meeting has changed from Thursday to Friday. Correct the existing Meeting memory, preserving everything else. Prepare the correction for review.'},
 tea:{path:'10 Profile/Tea.md',before:'I prefer peppermint tea in the evening.',after:'I prefer chamomile tea in the evening.',message:'My evening tea preference changed from peppermint to chamomile. Correct the existing Tea memory, leaving everything else as it is. Prepare the correction for review.'},
};
const name=process.argv[2]||'meeting',item=cases[name];if(!item)throw Error('Choose meeting or tea.');
const installed=await(await fetch('http://127.0.0.1:4717/api/local-model',{signal:AbortSignal.timeout(10000)})).json();
const dir=await mkdtemp(join(tmpdir(),'aurora-memory-corrections-live-')),vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data'));
const report={case:name,ok:false,model:installed.model,generation:installed.generation},started=Date.now(),events=[];
try{
 await vault.init();await store.init();const ollama=new Ollama(config.ollama,installed.model);ollama.generationOptions=installed.generation;
 const assistant=new Assistant({vault,store,ollama,projects:new Projects([])});
 const note=await vault.save(item.path,'# '+(name==='meeting'?'Meeting':'Tea')+'\n\n'+item.before+'\n',null),conversation=await store.conversation();
 await assistant.chat({id:conversation.id,message:item.message,mode:'general'},AbortSignal.timeout(240000),e=>{events.push(e);if(e.type==='tool')console.log(JSON.stringify({name:e.name,status:e.status}));});
 const proposals=await store.list('proposals'),matching=proposals.filter(p=>p.kind==='memory_correction'&&p.path===item.path);
 report.answer=events.filter(e=>e.type==='chunk').map(e=>e.text).join('');report.proposals=proposals.map(p=>({kind:p.kind,path:p.path,status:p.status}));
 assert.equal(matching.length,1,'The model must draft exactly one correction to the existing note.');
 const p=matching[0];assert.equal(p.status,'pending');assert.equal(p.before,item.before);assert.equal(p.after,item.after);assert.equal((await vault.read(item.path)).revision,note.revision);
 report.ok=true;report.draftOnly=true;report.sourceUnchanged=true;
}catch(e){report.error=e.message;console.error(e.stack);process.exitCode=1;}
finally{report.seconds=Math.round((Date.now()-started)/1000);report.tools=events.filter(e=>e.type==='tool'&&e.status==='done').map(e=>e.name);await writeFile(new URL(`../artifacts/memory-correction-${name}-live.json`,import.meta.url),JSON.stringify(report,null,2));await rm(dir,{recursive:true,force:true});console.log(JSON.stringify({case:name,ok:report.ok,seconds:report.seconds,tools:report.tools,error:report.error}));}
