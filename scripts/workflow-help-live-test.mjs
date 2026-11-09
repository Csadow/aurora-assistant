// Real local reasoning + an explicitly simulated online adviser. No provider
// credentials, external requests, user files, or installed workflow records.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';
const model=process.argv[2]||'qwen3.5:9b',dir=await mkdtemp(join(tmpdir(),'aurora-help-live-')),path=join(dir,'observation.txt');
await writeFile(path,'Aurora handoff fixture: cobalt-84\n');await mkdir(join(dir,'data'));
await writeFile(join(dir,'data/models.json'),JSON.stringify({model,thinking:true}));
let cloudCalls=0,w,app;const start=Date.now(),report={model,thinking:true,cloud:'SIMULATED provider; no real account request',ok:false};
const wait=async fn=>{const end=Date.now()+900000;while(Date.now()<end){const x=await fn();if(x)return x;await new Promise(r=>setTimeout(r,250));}throw Error('Timed out waiting for workflow state');};
try{
 app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],ollamaClient:new Ollama('http://127.0.0.1:11434',model),cloudFetch:async(_url,options)=>{cloudCalls++;report.outgoing=JSON.parse(options.body);return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'For this read-only task, read the supplied local file with read_system_file. Its observed contents, not this advice, are the evidence. Report the marker you actually observe.'}]}],usage:{input_tokens:30,output_tokens:40}});}});
 await app.settings.save({cloud:{provider:'openai',model:'simulated-consultant',apiKey:'fixture-only',enabled:true}});
 w=await app.workflows.start({goal:`Test the consultation flow. First call request_help with the question "How should I verify a local text file?" and pause for my review. Once reviewed advice arrives, read ${path} using read_system_file, report the exact marker from the file, then finish with its observation evidence. This is read-only: do not edit files, run commands, browse, or request a second consultation.`,scope:dir});
 await wait(async()=>{const current=await app.store.get('workflows',w.id);if(current.status==='needs_help'&&!app.workflows.running.has(w.id))return current;if(['completed','cancelled','paused','needs_verification','waiting_approval'].includes(current.status)&&!app.workflows.running.has(w.id))throw Error('Unexpected pre-consultation state: '+current.status+' '+current.error);});
 assert.equal(cloudCalls,0);const {action}=await app.workflows.help(w.id,{revision:1,question:'How should I verify a local text file?',context:'A read-only task needs evidence from a local text file. Give advice only.'});
 assert.equal(cloudCalls,0);await app.actions.decide(action.id,'approve',action.digest);
 const done=await wait(async()=>{const current=await app.store.get('workflows',w.id);if(current.status==='completed'&&!app.workflows.running.has(w.id))return current;if(['needs_help','paused','needs_verification','waiting_input'].includes(current.status)&&!app.workflows.running.has(w.id))throw Error('Task stopped: '+current.status+' '+current.error);});
 assert.equal(cloudCalls,1);assert.match(done.result,/cobalt-84/);assert(done.operations.some(o=>o.name==='read_system_file'&&o.status==='completed'&&o.result?.content?.includes('cobalt-84')));assert.equal(await readFile(path,'utf8'),'Aurora handoff fixture: cobalt-84\n');assert.equal((await app.store.list('actions')).length,1);
 report.ok=true;report.workflow=done;
}catch(e){report.error=e.message;if(app&&w)report.workflow=await app.store.get('workflows',w.id);}finally{
 report.seconds=Math.round((Date.now()-start)/100)/10;report.cloudCalls=cloudCalls;
 if(app){await app.workflows.close();app.actions.stopAll();app.backups.stop();app.reminders?.stop?.();}
 await writeFile(new URL('../artifacts/workflow-help-live-results.json',import.meta.url),JSON.stringify(report,null,2));await rm(dir,{recursive:true,force:true});
 console.log(JSON.stringify({ok:report.ok,error:report.error,seconds:report.seconds,cloudCalls,model,cloud:report.cloud}));
}
if(!report.ok)process.exitCode=1;
