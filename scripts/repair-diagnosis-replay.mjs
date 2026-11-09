// Deliberately outside the assistant execution path. No personal source, actions,
// cloud requests, setting changes or automatic acceptance of reviewer advice.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,open,rm} from 'node:fs/promises';
import {Ollama} from '../src/ollama.mjs';
import {sha} from '../src/vault.mjs';
import {diagnosisCases,diagnosisMessages,diagnosisFormat,diagnosisReceipt} from './repair-diagnosis-cases.mjs';
const root=new URL('../',import.meta.url),get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
// Refuse simultaneous copies. A hard-killed run leaves a lock for explicit
// inspection/removal rather than guessing that another evaluator is idle.
const lock=new URL('artifacts/repair-diagnosis.lock',root);await mkdir(new URL('artifacts/',root),{recursive:true});
const held=await open(lock,'wx',0o600);await held.writeFile(String(process.pid));await held.close();
try{
const model=await get('local-model');assert.equal(model.model,'qwen3.5:9b');assert(model.thinking);
assert.equal((await get('embodiment')).phase,'idle');assert(!(await get('workflows')).some(w=>['planning','running','queued'].includes(w.status)));assert(!(await get('actions')).some(a=>a.status==='running'));assert(!(await get('agents')).runs.some(r=>['running','queued'].includes(r.status)));
const client=new Ollama('http://127.0.0.1:11434',model.model);client.generationOptions=model.generation;await client.check();
const paths=['scripts/repair-diagnosis-cases.mjs','scripts/repair-diagnosis-replay.mjs','src/ollama.mjs','src/vault.mjs','src/config.mjs','desktop/quick-window.mjs','desktop/placement.mjs','tests/quick-window.test.mjs'];
const source=Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(new URL(p,root)))])));
const started=new Date().toISOString(),report={started,model:model.model,generation:model.generation,source,scope:'Eight fixed synthetic candidate reviews. Independent labels withheld. No actions or personal data. Verdict agreement and quotation validity do not establish semantic reliability.',cases:[]},file=new URL('artifacts/repair-diagnosis-'+started.replaceAll(/[:.]/g,'-')+'.json',root);
const controller=new AbortController();
const stop=signal=>{report.interrupted={at:new Date().toISOString(),reason:signal};controller.abort(new Error('Evaluation interrupted: '+signal));};
process.once('SIGTERM',()=>stop('SIGTERM'));process.once('SIGINT',()=>stop('SIGINT'));
await mkdir(new URL('artifacts/',root),{recursive:true});const save=()=>writeFile(file,JSON.stringify(report,null,2));await save();
try{for(const c of await diagnosisCases()){
 if(controller.signal.aborted)break;
 const at=Date.now(),messages=diagnosisMessages(c.input);let reply;
 try{reply=await client.chat(messages,[],AbortSignal.any([controller.signal,AbortSignal.timeout(300000)]),undefined,{format:diagnosisFormat});const receipt=diagnosisReceipt(c.input,reply);report.cases.push({name:c.name,expected:c.expected,rubric:c.rubric,receipt,verdictAgreement:receipt.verdict===c.expected,metrics:reply.metrics,seconds:Math.round((Date.now()-at)/1000),input:c.input,inputBytes:Buffer.byteLength(JSON.stringify({messages,format:diagnosisFormat}))});}
 catch(e){report.cases.push({name:c.name,expected:c.expected,rubric:c.rubric,verdictAgreement:false,error:e.message,rawReply:reply,seconds:Math.round((Date.now()-at)/1000)});}
 await save();const r=report.cases.at(-1);console.log(JSON.stringify({case:r.name,verdict:r.receipt?.verdict,error:r.error,agrees:r.verdictAgreement,seconds:r.seconds}));
}}finally{
 report.changedDuringRun=[];for(const [p,digest] of Object.entries(source))if(sha(await readFile(new URL(p,root)))!==digest)report.changedDuringRun.push(p);
 report.finished=new Date().toISOString();report.agreements=report.cases.filter(c=>c.verdictAgreement).length;await save();console.log(JSON.stringify({report:file.pathname,agreements:report.agreements,total:report.cases.length}));if(report.changedDuringRun.length||report.agreements!==8)process.exitCode=1;
}
}finally{await rm(lock);}
