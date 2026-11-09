import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';
import {sha} from '../src/vault.mjs';

// Deliberate failure drill: fixture plan, real source reads and one rejected
// fixture draft. Only recovery selection and subsequent work use the real model.
const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path);assert(r.ok);return r.json();};
const installed=await get('local-model');assert.equal(installed.model,'qwen3.5:9b');assert(installed.thinking);
assert(!(await get('workflows')).some(w=>['running','planning','queued'].includes(w.status)));
assert(!(await get('actions')).some(a=>a.status==='running'));assert(!(await get('agents')).runs.some(a=>['running','queued'].includes(a.status)));assert.equal((await get('embodiment')).phase,'idle');
const dir=await mkdtemp(join(tmpdir(),'aurora-repair-drill-')),data=join(dir,'data'),path=join(dir,'note.md'),budget=join(dir,'requirements.md'),offers=join(dir,'offers.md');
await mkdir(data);await writeFile(join(data,'models.json'),JSON.stringify({model:'qwen3.5:9b',thinking:true}));
const quotes=['The ceiling is 120 credits.','The quote is 140 credits.','The catalog is 110 credits.'];await writeFile(budget,quotes[0]);await writeFile(offers,quotes.slice(1).join('\n')+'\nThe prices conflict; neither is established as current.');
const draft='The vendor prices conflict (offers.md). Compare them with the stated ceiling (requirements.md).',required=[...quotes,'](offers.md)','](requirements.md)'];
const client=new Ollama('http://127.0.0.1:11434','qwen3.5:9b'),chat=client.chat.bind(client);let seeded=false,realCalls=0;
const call=(name,args)=>({content:'',tool_calls:[{function:{name,arguments:args}}]});
client.chat=async(m,tools,signal,chunk,options)=>{
 if(options?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Repair the supplied draft',check:'Read the approved note with the original body, required quotations and source links.'}]})};
 if(!seeded){const c=JSON.parse(m.at(-1).content),last=c.recentEvidence.map(JSON.parse).at(-1);if(!last)return call('read_system_file',{path:budget});if(last.result?.path===budget)return call('read_system_file',{path:offers});seeded=true;return call('propose_file_edit',{path,content:draft,reason:'Deliberately incomplete fixture draft'});}
 realCalls++;return chat(m,tools,signal,chunk,options);
};
const fingerprintFiles=['src/workflows.mjs','src/workflow-tools.mjs','src/workflow-prompt.mjs','src/workflow-calculations.mjs','src/workflow-arithmetic.mjs','src/workflow-citations.mjs','src/workflow-source-quotes.mjs'];
const fingerprint=Object.fromEntries(await Promise.all(fingerprintFiles.map(async f=>[f,sha(await readFile(new URL('../'+f,import.meta.url),'utf8'))])));
const app=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:client,workflowOptions:{segmentMs:240000}});
const allowed=app.system.allowed.bind(app.system);app.system.allowed=target=>{assert([budget,offers,path].includes(target));return allowed(target);};
let record,report,approvals=0;const started=Date.now();
try{
 const w=await app.workflows.start({goal:`Repair the supplied draft and save it to ${path}. Keep its existing sentences and unresolved price conflict. Restore all exact required quotations and local source links. Read the saved file back before finishing.`,scope:`Use only ${budget}, ${offers} and ${path}. No commands, browser or cloud.`,requirements:{files:[{path,requiredText:required,finalNewline:'required',lineEndings:'lf'}],commands:[]}});
 let reviewed=false;
 while(Date.now()-started<240000){record=await app.workflows.read(w.id);if(record.status==='plan_review'&&!app.workflows.running.has(w.id)){assert(!reviewed);await app.workflows.control(w.id,'approve_plan','',w.revision);reviewed=true;}
  for(const o of record.operations.filter(o=>o.status==='waiting_approval'&&o.action)){const a=await app.store.get('actions',o.action);if(a.status!=='pending')continue;assert.equal(a.kind,'write');assert.equal(a.payload.path,path);assert(approvals<1,'The drill expects a single corrected write');await app.actions.decide(a.id,'approve',a.digest);approvals++;}
  if(['completed','paused','needs_help','waiting_input','needs_verification','cancelled','failed'].includes(record.status)&&!app.workflows.running.has(w.id))break;
  await new Promise(r=>setTimeout(r,200));
 }
 const output=await readFile(path,'utf8').catch(()=>''),checks={completed:record.status==='completed',usedCombinedRepair:record.operations.some(o=>o.requestedTool==='propose_draft_repair'&&o.status==='completed'),oneApproval:approvals===1,preservedBody:output.startsWith('The vendor prices conflict [offers.md](offers.md). Compare them with the stated ceiling [requirements.md](requirements.md).'),requirements:required.every(t=>output.includes(t)),readback:record.operations.some(o=>o.name==='read_system_file'&&o.status==='completed'&&o.result?.path===path&&o.result?.content===output),sourcesUnchanged:await readFile(budget,'utf8')===quotes[0]&&await readFile(offers,'utf8')===quotes.slice(1).join('\n')+'\nThe prices conflict; neither is established as current.'};
 for(const [file,digest] of Object.entries(fingerprint))assert.equal(sha(await readFile(new URL('../'+file,import.meta.url),'utf8')),digest,'Source changed during the drill');
 report={ok:Object.values(checks).every(Boolean),scope:'Seeded failure drill; only recovery and subsequent work use the real model. Not a free-form research success rate.',seconds:Math.round((Date.now()-started)/1000),model:'qwen3.5:9b',realCalls,approvals,checks,fingerprint,output,record};
}catch(e){report={ok:false,error:e.message,realCalls,approvals,record};}
finally{await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,20));await rm(dir,{recursive:true,force:true});}
await writeFile(new URL('../artifacts/draft-repair-live-results.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,record:undefined,output:undefined,fingerprint:undefined}));if(!report.ok)process.exitCode=1;
