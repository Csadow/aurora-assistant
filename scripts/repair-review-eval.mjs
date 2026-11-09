// Offline evaluation only. No workflow/action imports, cloud, personal source,
// setting changes or execution of reviewer output. Calls are strictly serial.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,open,rm} from 'node:fs/promises';
import {Ollama} from '../src/ollama.mjs';
import {sha,atomic} from '../src/vault.mjs';
import {repairReviewCases} from './repair-review-corpus.mjs';
import {repairReviewRequest,repairReviewReceipt} from './repair-review-protocol.mjs';
import {reviewOracle} from './repair-review-oracle.mjs';
import {scoreRepairReviews} from './repair-review-score.mjs';
const root=new URL('../',import.meta.url),args=process.argv.slice(2),partition=args.find(a=>a.startsWith('--partition='))?.split('=')[1]||'all',live=args.includes('--live'),reviewThinking=!args.includes('--review-thinking=off');
if(args.some(a=>a!=='--live'&&a!=='--preflight'&&!/^--partition=(all|development|evaluation)$/.test(a)&&!/^--review-thinking=(on|off)$/.test(a))||args.includes('--live')&&args.includes('--preflight')||args.includes('--review-thinking=on')&&args.includes('--review-thinking=off'))throw Error('Use --preflight (default) or --live, optionally --partition=development|evaluation|all and --review-thinking=on|off.');
const all=await repairReviewCases(),corpus=all.filter(c=>partition==='all'||c.partition===partition),preflight=[];
for(const c of corpus){const request=repairReviewRequest(c.input),oracle=await reviewOracle(c.name,c.input);if(c.expected.behavior!=='unknown')assert.equal(oracle.passed,c.expected.behavior==='supported',c.name);preflight.push({name:c.name,partition:c.partition,inputBytes:request.inputBytes,expected:c.expected,expectedVerdict:c.expectedVerdict,oracle});}
if(!live){console.log(JSON.stringify({mode:'preflight',cases:preflight},null,2));process.exit(0);}
await mkdir(new URL('artifacts/',root),{recursive:true});
// Shared with the original diagnosis evaluator: a crashed owner leaves a lock
// for inspection, rather than silently allowing overlapping model runs.
const lock=new URL('artifacts/repair-diagnosis.lock',root),held=await open(lock,'wx',0o600);await held.writeFile(JSON.stringify({pid:process.pid,script:'repair-review-eval',partition}));await held.close();
try{
 const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
 const idle=async()=>{assert.equal((await get('embodiment')).phase,'idle','Personal assistant is busy');assert(!(await get('workflows')).some(w=>['planning','running','queued'].includes(w.status)),'Personal workflow is busy');assert(!(await get('actions')).some(a=>a.status==='running'),'Personal action is running');assert(!(await get('agents')).runs.some(r=>['running','queued'].includes(r.status)),'Personal agent is busy');};
 const selected=await get('local-model');assert.equal(selected.model,'qwen3.5:9b');assert.equal(selected.thinking,true);await idle();
 const client=new Ollama('http://127.0.0.1:11434',selected.model);client.generationOptions={...selected.generation,think:reviewThinking};await client.check();
 const paths=['scripts/repair-review-eval.mjs','scripts/repair-review-corpus.mjs','scripts/repair-review-protocol.mjs','scripts/repair-review-oracle.mjs','scripts/repair-review-score.mjs','scripts/repair-diagnosis-cases.mjs','src/repair-expression.mjs','src/ollama.mjs','src/vault.mjs','src/config.mjs','src/environment.mjs','src/task-meta.mjs','desktop/quick-window.mjs','desktop/placement.mjs','tests/quick-window.test.mjs'];
 const source=Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(new URL(p,root)))]))),started=new Date().toISOString(),file=new URL('artifacts/repair-review-'+partition+'-'+started.replaceAll(/[:.]/g,'-')+'.json',root);
 const report={started,partition,model:selected.model,generation:client.generationOptions,selectedGeneration:selected.generation,reviewThinking,source,planned:corpus.map(c=>c.name),preflight,results:[],notice:'One tool-free review per fixed candidate, all labels and rubrics withheld. No retry, repaired output, generated-code execution or action approval. Score axes and latency separately; correct labels alone do not validate causal reasons. Offline only.'};
 await writeFile(file,'{}',{flag:'wx',mode:0o600});const save=()=>atomic(file.pathname,JSON.stringify(report,null,2));await save();
 const controller=new AbortController(),stop=signal=>{report.interrupted={reason:signal,at:new Date().toISOString()};controller.abort(new Error('Evaluation interrupted: '+signal));};process.once('SIGTERM',()=>stop('SIGTERM'));process.once('SIGINT',()=>stop('SIGINT'));
 try{
  for(const c of corpus){
   if(controller.signal.aborted)break;await idle();
   const request=repairReviewRequest(c.input),at=Date.now(),result={name:c.name,expected:c.expected,expectedVerdict:c.expectedVerdict,rubric:c.rubric,input:c.input,request};let reply,partialContent='';
   try{
    reply=await client.chat(request.messages,[],AbortSignal.any([controller.signal,AbortSignal.timeout(300000)]),chunk=>partialContent+=chunk,{format:request.format});result.rawReply=reply;result.metrics=reply.metrics;result.receipt=repairReviewReceipt(c.input,reply);
   }catch(e){result.error=e.message;result.partialContent=partialContent;result.metrics=reply?.metrics||e.metrics;result.failureKind=controller.signal.aborted?'interrupted':e.code==='model_output_limit'?'output_limit':e.name==='TimeoutError'?'timeout':reply?'invalid_output':'request_failure';}
   result.seconds=Math.round((Date.now()-at)/1000);report.results.push(result);report.score=scoreRepairReviews(corpus,report.results);await save();console.log(JSON.stringify({case:c.name,expected:c.expectedVerdict,verdict:result.receipt?.verdict,axes:result.receipt?Object.fromEntries(Object.entries(result.receipt.assessment).map(([k,v])=>[k,v.status])):undefined,error:result.error,seconds:result.seconds}));
  }
 }catch(e){report.error=e.message;process.exitCode=1;}
 finally{
  report.changedDuringRun=[];for(const [p,h] of Object.entries(source))if(sha(await readFile(new URL(p,root)))!==h)report.changedDuringRun.push(p);
  report.score=scoreRepairReviews(corpus,report.results);report.finished=new Date().toISOString();const after=await get('local-model');report.modelSettingsUnchanged=after.model===selected.model&&after.thinking===selected.thinking&&JSON.stringify(after.generation)===JSON.stringify(selected.generation);await save();console.log(JSON.stringify({report:file.pathname,score:report.score,changedDuringRun:report.changedDuringRun}));
  if(report.changedDuringRun.length||!report.modelSettingsUnchanged||report.score.verdictAgreement.passed!==corpus.length)process.exitCode=1;
 }
}finally{await rm(lock);}
