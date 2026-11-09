// Paired reviewer probes with fixed synthetic observations. These measure the
// critique alone, not file execution or general research accuracy. No actions.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {Ollama} from '../src/ollama.mjs';
import {sha} from '../src/vault.mjs';
import {sourcedDraft} from '../src/workflow-claims.mjs';
import {critiqueInput,critiquePrompt,critiqueTool,critiqueReceipt} from '../src/workflow-critique.mjs';

const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
const model=await get('local-model');assert.equal(model.model,'qwen3.5:9b');assert(model.thinking);
assert(!(await get('workflows')).some(w=>['running','planning','queued'].includes(w.status)));
assert(!(await get('actions')).some(a=>a.status==='running'));
assert(!(await get('agents')).runs.some(a=>['running','queued'].includes(a.status)));
assert.equal((await get('embodiment')).phase,'idle');
const generation={think:true,num_predict:6144,num_ctx:12288},client=new Ollama('http://127.0.0.1:11434',model.model);client.generationOptions=generation;await client.check();
const files=['src/workflow-critique.mjs','src/workflow-substance.mjs','src/workflow-claims.mjs','src/workflow-claim-note.mjs','src/workflow-arithmetic.mjs','src/workflow-calculations.mjs','scripts/draft-critique-live-test.mjs'],source=Object.fromEntries(await Promise.all(files.map(async file=>[file,sha(await readFile(new URL('../'+file,import.meta.url)))])));
const texts=[['needs.md','The 2026 budget is 100 credits per month. Offline editing and Markdown export must both be available now.'],['archived.md','Archived 2025 offer: Lumen costs 960 credits per year. This offer expired on 31 December 2025. It included offline editing and Markdown export.'],['current.md','Current 2026 offer: Lumen costs 90 credits per month. Offline editing is included. Markdown export is planned, but is not available in this offer. No launch date is provided.']];
const claim=(text,evidence,kind='inference')=>({text,evidence,kind,limits:'The current and expired offers have different validity periods. Preserve the fixed requirement for both capabilities now.'});
const correct=[claim('The current 2026 offer meets the monthly budget (90 < 100) and supports offline editing, but fails the required Markdown export capability now. It does not satisfy all requirements.','E1 E3'),claim('The archived 2025 offer cost 960 credits per year and included both capabilities, but expired on 31 December 2025. Its features cannot be carried into the current offer, and its annual price is not a contradictory current monthly price.','E2 E3'),claim('The sources do not establish a launch date for Markdown export. No currently qualifying offer is established by this source set.','E1 E2 E3')];
const cases=[{name:'supported_decision',expected:'ready',claims:correct},{name:'negation_reversed',expected:'revise',claims:[...correct.slice(1),claim('The current 2026 offer meets all requirements: it supports offline editing and Markdown export now at 90 credits per month. Recommend choosing it.','E1 E3')]},{name:'fixed_requirement_dropped',expected:'revise',claims:[...correct,claim('Recommend choosing the current offer by deferring the Markdown export requirement until a later release.','E1 E3')]},{name:'expired_period_as_current_conflict',expected:'revise',claims:[correct[0],correct[2],claim('The sources report conflicting current monthly prices of 960 and 90 credits; both are active 2026 alternatives and the conflict is unresolved.','E2 E3','conflict')]}];
cases.push({name:'missing_budget_analysis',expected:'revise',claims:[claim('The current 2026 offer costs 90 credits per month and has offline editing, but does not have Markdown export now. The budget is 100 credits per month.','E1 E3'),correct[1],correct[2]]},{name:'incorrect_difference',expected:'revise',claims:[...correct,claim('The current offer is 40 credits per month below the 100-credit monthly ceiling.','E1 E3')]});
const selected=process.argv.find(a=>a.startsWith('--only='))?.slice(7),selectedCases=cases.filter(c=>!selected||c.name===selected);assert(selectedCases.length,'Unknown probe');
const report={selected:selected||'all',started:new Date().toISOString(),model:model.model,generation,scope:'Fixed synthetic-source critique probes; no tools, files or approvals are executed by the model. Human semantic review is still required.',source,cases:[]},id=report.started.replaceAll(/[:.]/g,'-');
try{
 for(const c of selectedCases){
  const started=Date.now(),w={version:5,revision:1,model:model.model,generation,goal:'Compare the current offer with the archived offer. Decide whether the current offer fits the budget and BOTH capabilities available now. Keep validity dates and billing periods distinct; do not invent a launch date or relax the fixed requirements.',scope:'Only these three synthetic source observations.',requirements:{files:[{path:'/fixture/decision.md',sourceReview:true,draftCritique:true,finalNewline:'required',lineEndings:'lf',requiredText:texts.map(([name])=>']('+name+')')}],commands:[]},operations:texts.map(([name,content],i)=>({id:'source-'+i,name:'read_system_file',status:'completed',revision:1,arguments:{path:'/fixture/'+name},result:{path:'/fixture/'+name,content,revision:sha(content)}}))};
  const draft=sourcedDraft(w,{path:'/fixture/decision.md',reason:'Fixed evaluation probe',claims:c.claims}),op={id:'draft',arguments:draft.arguments,sourceReview:draft.review};
  let reply;try{reply=await client.chat([{role:'system',content:critiquePrompt},{role:'user',content:JSON.stringify(critiqueInput(w,op))}],[critiqueTool],AbortSignal.timeout(300000));const receipt=critiqueReceipt(w,op,reply);report.cases.push({name:c.name,expected:c.expected,ok:receipt.verdict===c.expected,seconds:Math.round((Date.now()-started)/1000),receipt,claims:c.claims,metrics:reply.metrics});}
  catch(e){report.cases.push({name:c.name,expected:c.expected,ok:false,error:e.message,rawReply:reply,seconds:Math.round((Date.now()-started)/1000)});}
  console.log(JSON.stringify(report.cases.at(-1)));
 }
}finally{
 report.changedDuringRun=[];for(const [file,hash] of Object.entries(source))if(sha(await readFile(new URL('../'+file,import.meta.url)))!==hash)report.changedDuringRun.push(file);
 report.ok=report.cases.length===selectedCases.length&&report.cases.every(c=>c.ok)&&!report.changedDuringRun.length;report.finished=new Date().toISOString();await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});await writeFile(new URL('../artifacts/draft-critique-live-'+id+'.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,report:'artifacts/draft-critique-live-'+id+'.json'}));if(!report.ok)process.exitCode=1;
}
