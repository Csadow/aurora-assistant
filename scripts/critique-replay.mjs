// Replay complete saved failing drafts, without execution tools or personal data.
// Verdict agreement is mechanical; defect identification and corrected meaning
// require the saved rubric and a separate human review, not the same model judge.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {Ollama} from '../src/ollama.mjs';
import {sha} from '../src/vault.mjs';
import {critiqueInput,critiquePrompt,critiqueTool,critiqueReceipt} from '../src/workflow-critique.mjs';
import {Workflows} from '../src/workflows.mjs';
import {unverifiedWrites} from '../src/workflow-health.mjs';
import {executionPrompt} from '../src/workflow-prompt.mjs';
import {sourcedFileTool,sourcedDraft} from '../src/workflow-claims.mjs';
import {proposalRequirements} from '../src/workflow-requirements.mjs';

const root=new URL('../',import.meta.url),fixtureDir=new URL('tests/fixtures/critique-replay/',root);
const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7),label=process.argv.find(a=>a.startsWith('--label='))?.slice(8)||'current',correct=process.argv.includes('--correct');
assert(/^[a-z0-9_-]{1,40}$/.test(label),'Use a short alphanumeric label');
const fixtureFiles=(await readdir(fixtureDir)).filter(f=>f.endsWith('.json')).sort();
const cases=(await Promise.all(fixtureFiles.map(async f=>JSON.parse(await readFile(new URL(f,fixtureDir),'utf8'))))).filter(c=>!only||c.name===only);assert(cases.length,'Unknown replay case');
const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
const model=await get('local-model');assert.equal(model.model,'qwen3.5:9b');assert(model.thinking);
assert(!(await get('workflows')).some(w=>['running','planning','queued'].includes(w.status)));
assert(!(await get('actions')).some(a=>a.status==='running'));
assert(!(await get('agents')).runs.some(a=>['running','queued'].includes(a.status)));
assert.equal((await get('embodiment')).phase,'idle');
const generation=model.generation,client=new Ollama('http://127.0.0.1:11434',model.model);client.generationOptions=generation;await client.check();
const files=[...(await readdir(new URL('src/',root))).filter(f=>f.endsWith('.mjs')).map(f=>'src/'+f),'scripts/critique-replay.mjs',...fixtureFiles.map(f=>'tests/fixtures/critique-replay/'+f)];
const source=Object.fromEntries(await Promise.all(files.map(async file=>[file,sha(await readFile(new URL(file,root)))])));
const report={label,correct,started:new Date().toISOString(),model:model.model,generation,source,scope:'Saved synthetic whole-workflow drafts; no action execution. Verdict agreement alone does not establish correct objections or successful correction.',manualReviewRequired:true,cases:[]};
const id=report.started.replaceAll(/[:.]/g,'-'),reportPath=`artifacts/critique-replay-${label}-${id}.json`;
await mkdir(new URL('artifacts/',root),{recursive:true});
const checkpoint=()=>writeFile(new URL(reportPath,root),JSON.stringify(report,null,2));
await checkpoint();
try{
 for(const c of cases){
  const w=structuredClone(c.workflow),op=w.operations.find(o=>o.id===c.operation);w.model=model.model;w.generation=generation;
  const started=Date.now();let reply;
  try{const input=critiqueInput(w,op);reply=await client.chat([{role:'system',content:critiquePrompt},{role:'user',content:JSON.stringify(input)}],[critiqueTool],AbortSignal.timeout(300000));const receipt=critiqueReceipt(w,op,reply);report.cases.push({name:c.name,expected:c.expected,verdictAgreement:receipt.verdict===c.expected,seconds:Math.round((Date.now()-started)/1000),inputCharacters:JSON.stringify(input).length,receipt,rubric:c.rubric,metrics:reply.metrics});}
  catch(e){report.cases.push({name:c.name,expected:c.expected,verdictAgreement:false,error:e.message,rawReply:reply,seconds:Math.round((Date.now()-started)/1000)});}
  const result=report.cases.at(-1);await checkpoint();
  if(correct&&result.receipt?.verdict==='revise'){
   const correctionStarted=Date.now();let correctionReply;
   try{
    op.status='failed';op.result={requirementFailures:result.receipt.issues,error:'Draft critique requests corrections. Nothing was saved.'};op.draftCritique=result.receipt;
    w.steps=[{id:'replay-step',title:'Write the sourced decision note',check:'Read the approved note back.',status:'running'}];w.current=0;
    const context=Workflows.prototype.context.call({unverifiedWrites,missingChecks:Workflows.prototype.missingChecks},w);
    correctionReply=await client.chat([{role:'system',content:executionPrompt},{role:'user',content:context}],sourcedFileTool(w),AbortSignal.timeout(300000));
    const calls=correctionReply.tool_calls;assert.equal(calls?.length,1,'Correction must propose one sourced note');assert.equal(calls[0].function.name,'propose_sourced_file','No other tools may execute');
    const args=typeof calls[0].function.arguments==='string'?JSON.parse(calls[0].function.arguments):calls[0].function.arguments;
    const draft=sourcedDraft(w,args);proposalRequirements(w,'write',draft.arguments);
    result.correction={structurallyValid:true,seconds:Math.round((Date.now()-correctionStarted)/1000),inputCharacters:context.length,claims:args.claims,draft:draft.arguments.content,sourceReview:draft.review,metrics:correctionReply.metrics,notice:'Rendered and checked in memory only. No action or approval. Semantic correction requires manual assessment.'};
   }catch(e){result.correction={structurallyValid:false,seconds:Math.round((Date.now()-correctionStarted)/1000),error:e.message,rawReply:correctionReply};}
  }
  await checkpoint();console.log(JSON.stringify(report.cases.at(-1)));
 }
}finally{
 report.changedDuringRun=[];for(const [file,hash] of Object.entries(source))if(sha(await readFile(new URL(file,root)))!==hash)report.changedDuringRun.push(file);
 report.verdictAgreement=report.cases.length===cases.length&&report.cases.every(c=>c.verdictAgreement)&&!report.changedDuringRun.length;
 report.finished=new Date().toISOString();await mkdir(new URL('artifacts/',root),{recursive:true});await checkpoint();console.log(JSON.stringify({verdictAgreement:report.verdictAgreement,report:reportPath}));if(!report.verdictAgreement)process.exitCode=1;
}
