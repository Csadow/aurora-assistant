import {mkdir,writeFile} from 'node:fs/promises';
import {Ollama} from '../src/ollama.mjs';
const models=process.argv.slice(2).filter(a=>!a.startsWith('--')),thinking=!process.argv.includes('--direct');if(!models.length)throw new Error('Pass one or more installed Ollama model IDs.');
const tuned=process.argv.includes('--tuned');
const budget=Number(process.argv.find(a=>a.startsWith('--tokens='))?.slice(9)||(thinking?3072:768)),caseId=process.argv.find(a=>a.startsWith('--case='))?.slice(7);
if(!Number.isInteger(budget)||budget<128||budget>16384)throw new Error('Use a token budget between 128 and 16384.');
// Accept an unambiguous Python tuple key; merely mentioning both IDs is not enough.
const safeKey=v=>typeof v==='string'&&/^\(\s*(?:user_id\s*,\s*project_id|project_id\s*,\s*user_id)\s*,?\s*\)$/.test(v.trim());
const cases=[
 {id:'parallel-dependencies',prompt:'Two workers can work simultaneously. Task A takes 6 minutes. B takes 9 minutes and requires A. C takes 5 minutes and requires A. D takes 7 minutes and requires B and C. A task cannot be split between workers. What is the earliest completion time for all tasks? Return JSON {"minutes":number,"explanation":string}.',format:{type:'object',properties:{minutes:{type:'integer'},explanation:{type:'string'}},required:['minutes','explanation']},check:v=>v.minutes===22},
 {id:'separate-evidence',prompt:'Use only these notes. [N1] Project Birch release review is Thursday at 14:00. [N2] Project Cedar release review is Wednesday at 10:00. [N3] Birch needs a QA signoff before review; QA date is not recorded. When is Birch review, and when is its QA? Return JSON {"review":string,"qa":string,"source":string}. Never transfer dates from another project.',format:{type:'object',properties:{review:{type:'string'},qa:{type:'string'},source:{type:'string'}},required:['review','qa','source']},check:v=>/Thursday/i.test(v.review)&&/14:00|2\s*p\.?m/i.test(v.review)&&/unknown|not (recorded|specified|provided|known)|unspecified/i.test(v.qa)&&/N1/.test(v.source)},
 {id:'account-isolation',prompt:'A server caches private per-project reports: def get_report(user_id, project_id): key = project_id; if key in cache: return cache[key]; report = build_report(user_id, project_id); cache[key] = report; return report. Users may reuse project IDs. Identify the privacy bug and give the corrected Python key expression. Return JSON {"bug":string,"key":string}.',format:{type:'object',properties:{bug:{type:'string'},key:{type:'string'}},required:['bug','key']},check:v=>safeKey(v.key)&&/user|account/i.test(v.bug)}
];
if(caseId&&!cases.some(c=>c.id===caseId))throw new Error('Unknown benchmark case.');
await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
for(const model of models){
 const ollama=new Ollama('http://127.0.0.1:11434',model);await ollama.check();const report={model,at:new Date().toISOString(),thinking,tokenBudget:budget,sampling:tuned?'Qwen recommended, seed 42':'temperature 0',checks:[]};
 for(const test of cases.filter(c=>!caseId||c.id===caseId)){const started=Date.now();try{const answer=await ollama.chat([{role:'system',content:'Solve the task carefully and return the requested JSON. Be concise.'},{role:'user',content:test.prompt}],undefined,AbortSignal.timeout(900000),undefined,{think:thinking,num_predict:budget,num_ctx:8192,...(tuned?{seed:42}:{temperature:0}),format:test.format});let parsed;try{parsed=JSON.parse(answer.content);}catch{}const check={id:test.id,ok:!!parsed&&test.check(parsed),answer:answer.content,metrics:answer.metrics,wallSeconds:Math.round((Date.now()-started)/100)/10};report.checks.push(check);console.log(JSON.stringify({model,thinking,...check}));}catch(e){report.checks.push({id:test.id,ok:false,error:e.message,wallSeconds:Math.round((Date.now()-started)/100)/10});console.log(model,test.id,e.message);}
 await writeFile(new URL('../artifacts/benchmark-'+model.replace(/[^a-z0-9-]/gi,'_')+(thinking?'':'-direct')+(process.argv.some(a=>a.startsWith('--tokens='))?'-budget'+budget:'')+(caseId?'-'+caseId:'')+(tuned?'-tuned':'')+'.json',import.meta.url),JSON.stringify(report,null,2));
 }
}
