// Real local-model trial; only disposable files can be read or approved.
// Structural checks deliberately do not pretend to judge factual entailment.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';
import {sha} from '../src/vault.mjs';

const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
const draftCritique=process.env.AURORA_DRAFT_CRITIQUE==='1';
const model=await get('local-model');assert.equal(model.model,'qwen3.5:9b');assert(model.thinking);
assert(!(await get('workflows')).some(w=>['running','planning','queued'].includes(w.status)));
assert(!(await get('actions')).some(a=>a.status==='running'));
assert(!(await get('agents')).runs.some(a=>['running','queued'].includes(a.status)));
assert.equal((await get('embodiment')).phase,'idle');
const files=['src/workflows.mjs','src/workflow-critique.mjs','src/workflow-delivery.mjs','src/workflow-claims.mjs','src/workflow-claim-note.mjs','src/workflow-source-links.mjs','src/workflow-requirements.mjs','src/workflow-prompt.mjs','src/workflow-tools.mjs','src/workflow-calculations.mjs','src/workflow-arithmetic.mjs','scripts/source-scope-live-test.mjs'];
const fingerprints=Object.fromEntries(await Promise.all(files.map(async file=>[file,sha(await readFile(new URL('../'+file,import.meta.url)))])));
const dir=await mkdtemp(join(tmpdir(),'aurora-source-scope-')),project=join(dir,'sources'),data=join(dir,'data');await mkdir(project);await mkdir(data);await writeFile(join(data,'models.json'),JSON.stringify({model:'qwen3.5:9b',thinking:true}));
const sources=[
 {name:'needs.md',quote:'The 2026 budget is 100 credits per month.',text:'The 2026 budget is 100 credits per month. Offline editing and Markdown export must both be available now.'},
 {name:'archived.md',quote:'Lumen costs 960 credits per year.',text:'Archived 2025 offer: Lumen costs 960 credits per year. This offer expired on 31 December 2025. It included offline editing and Markdown export.'},
 {name:'current.md',quote:'Lumen costs 90 credits per month.',text:'Current 2026 offer: Lumen costs 90 credits per month. Offline editing is included. Markdown export is planned, but is not available in this offer. No launch date is provided.'}
];
for(const s of sources)await writeFile(join(project,s.name),s.text+'\n');
const path=join(project,'decision.md'),app=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:new Ollama('http://127.0.0.1:11434','qwen3.5:9b')});
const allowed=app.system.allowed.bind(app.system);app.system.allowed=p=>{assert(p===project||p.startsWith(project+'/'),'Only the disposable source directory is available');return allowed(p);};
let record,result,approvals=0,planReviews=0;const started=Date.now(),id=new Date().toISOString().replaceAll(/[:.]/g,'-');
try{
 const task=await app.workflows.start({goal:`Read all three local sources and save a concise decision note to ${path}. Explain whether the current Lumen offer satisfies the budget and both required capabilities. Compare it with the archived offer, preserving billing periods and validity dates. Different units or periods alone are not an unresolved price conflict. Do not carry expired features into the current offer or invent an export launch date. Cite each source with a Markdown link to its filename and include each required quotation. Review key claims and read the saved note back.`,scope:`Read only ${sources.map(s=>join(project,s.name)).join(', ')} and ${path}. Write only ${path}. No commands, browser, cloud or other actions.`,requirements:{files:[{path,sourceReview:true,...(draftCritique?{draftCritique:true}:{}),finalNewline:'required',lineEndings:'lf',requiredText:sources.flatMap(s=>[s.quote,']('+s.name+')'])}],commands:[]}});
 let previous='';
 while(Date.now()-started<600000){
  record=await app.store.get('workflows',task.id);const status=JSON.stringify([record.status,record.calls,record.operations.at(-1)?.name]);if(status!==previous){console.log(status);previous=status;}
  if(['completed','paused','failed','cancelled','needs_help','needs_verification','waiting_input'].includes(record.status)&&!app.workflows.running.has(task.id))break;
  if(record.status==='plan_review'&&!app.workflows.running.has(task.id)){assert.equal(planReviews,0);assert.equal(record.operations.length,0);await app.workflows.control(task.id,'approve_plan','',record.revision);planReviews++;}
  for(const o of record.operations.filter(o=>o.action&&o.status==='waiting_approval')){const a=await app.store.get('actions',o.action);if(a.status!=='pending')continue;assert.equal(a.kind,'write');assert.equal(a.payload.path,path);assert(a.payload.content.length<16000);assert(a.payload.requirementsCheck?.sourceReview);await app.actions.decide(a.id,'approve',a.digest);approvals++;}
  await new Promise(r=>setTimeout(r,400));
 }
 const output=await readFile(path,'utf8').catch(()=>''),checks={completed:record.status==='completed',oneWrite:approvals===1,planReview:planReviews===1,exactQuotes:sources.every(s=>output.includes(s.quote)),links:sources.every(s=>output.includes(']('+s.name+')')||output.includes(']('+join(project,s.name)+')')),claimReview:record.operations.some(o=>o.action&&o.sourceReview?.draftRevision===sha(output)&&o.sourceReview.sources.length===3),readback:!app.workflows.unverifiedWrites(record).length&&record.operations.some(o=>o.name==='read_system_file'&&o.result?.path===path&&o.result.content===output),sourcesUnchanged:(await Promise.all(sources.map(s=>readFile(join(project,s.name),'utf8')))).every((s,i)=>s===sources[i].text+'\n')};
 result={ok:Object.values(checks).every(Boolean),draftCritique,checks,seconds:Math.round((Date.now()-started)/1000),approvals,planReviews,model:model.model,manualReviewRequired:true,semanticQuestions:['Does the note keep annual 2025 and monthly 2026 prices distinct?','Does it treat expired terms as historical rather than a current unresolved conflict?','Does it identify Markdown export as unavailable now, rather than unknown or included?','Does it keep the launch date unknown and reject current suitability despite the budget fit?'],output,record};
}catch(e){result={ok:false,error:e.message,seconds:Math.round((Date.now()-started)/1000),record};}
finally{
 await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,30));
 const changed=[];for(const [file,hash] of Object.entries(fingerprints))if(sha(await readFile(new URL('../'+file,import.meta.url)))!==hash)changed.push(file);
 if(changed.length){result.ok=false;result.changedDuringRun=changed;}result.source=fingerprints;
 await writeFile(new URL('../artifacts/source-scope-live-'+id+'.json',import.meta.url),JSON.stringify(result,null,2));await writeFile(new URL('../artifacts/source-scope-live-results.json',import.meta.url),JSON.stringify(result,null,2));await rm(dir,{recursive:true,force:true});
 console.log(JSON.stringify({...result,record:undefined,output:undefined,source:undefined}));
}
if(!result.ok)process.exitCode=1;
