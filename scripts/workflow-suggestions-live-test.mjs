// Inert local-model evaluation: no workflow, desktop bridge or action executor.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,open,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sha} from '../src/vault.mjs';
import {Ollama} from '../src/ollama.mjs';
import {suggestRequirements} from '../src/workflow-suggestions.mjs';
const root=new URL('../',import.meta.url),stamp=new Date().toISOString().replaceAll(/[:.]/g,'-'),destination=new URL('artifacts/desktop-suggestions-live-'+stamp+'.json',root),lockPath=new URL('artifacts/repair-diagnosis.lock',root);
const chosen=process.argv[2]?.replace(/^--case=/,'');assert(process.argv.length<=3&&(!chosen||process.argv[2].startsWith('--case=')),'Use an optional --case=name.');
const get=async p=>{const r=await fetch('http://127.0.0.1:4717/api/'+p,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
const selection=m=>({model:m.model,thinking:m.thinking,generation:m.generation});
const sources=async()=>{const names=['scripts/workflow-suggestions-live-test.mjs','public/workflow-requirements.js','public/index.html',...(await readdir(new URL('src/',root))).filter(n=>n.endsWith('.mjs')).map(n=>'src/'+n)];return Object.fromEntries(await Promise.all(names.map(async n=>[n,sha(await readFile(new URL(n,root)))])));};
let lock,dir;const report={date:new Date().toISOString(),ok:false,cases:[]};
try{
 lock=await open(lockPath,'wx');report.model=selection(await get('local-model'));
 assert.equal((await get('embodiment')).phase,'idle');assert(!(await get('workflows')).some(w=>['planning','running','queued'].includes(w.status)));assert(!(await get('actions')).some(a=>a.status==='running'));assert(!(await get('agents')).runs.some(a=>['running','queued'].includes(a.status)));
 report.source=await sources();dir=await mkdtemp(join(tmpdir(),'aurora-suggestion-live-'));const path=join(dir,'report.md');await writeFile(path,'Unchanged fixture\n');
 const base={files:[],commands:[]},selected={...base,browser:{url:'https://example.com/selected',title:'My selected page'},window:{title:'My selected document',app:'Chosen.Editor'}};
 const cases=[
  {id:'file-only',goal:`Write a brief in ${path}. Include the exact headings "## Decision" and "## Unknowns". Use LF line endings and a final newline. Leave unsupported facts as unknown.`,scope:'Only this output file. Do not execute commands or use online services.',requirements:base,verify:r=>{assert.equal(r.files.length,1);assert.equal(r.files[0].path,path);assert.equal(r.files[0].lineEndings,'lf');assert.equal(r.files[0].finalNewline,'required');assert(r.files[0].requiredText.includes('## Decision')&&r.files[0].requiredText.includes('## Unknowns'));assert(!r.browser&&!r.window);}},
  {id:'sourced-note',goal:`Write a sourced note in ${path}. Read the local Markdown files requirements.md and vendor.md. Cite both using Markdown links to their exact filenames and review key claims against those sources.`,scope:'Use only those two local files as sources. Do not execute commands or use online services.',requirements:base,verify:r=>{assert.equal(r.files.length,1);assert.equal(r.files[0].path,path);assert.equal(r.files[0].sourceReview,true);assert(r.files[0].requiredText.some(x=>x.includes('](requirements.md)')));assert(r.files[0].requiredText.some(x=>x.includes('](vendor.md)')));assert(!r.browser&&!r.window);}},
  {id:'explicit-all',goal:`Write ${path} with the exact heading ## Decision and a final LF newline. Leave the final Aurora Browser page at https://example.com/report?view=final#summary with exact page title "Project summary". Leave the document window with exact title "report.md — Editor" open.`,scope:'The exact window app identifier is "org.example.Editor".',requirements:base,verify:r=>{assert.equal(r.files[0]?.path,path);assert(r.files[0].requiredText.includes('## Decision'));assert.equal(r.files[0].finalNewline,'required');assert.deepEqual(r.browser,{url:'https://example.com/report?view=final#summary',title:'Project summary'});assert.deepEqual(r.window,{title:'report.md — Editor',app:'org.example.Editor'});}},
  {id:'url-only',goal:'Leave the final Aurora Browser page at https://example.com/guide open. I do not know its exact page title.',scope:'',requirements:base,verify:r=>{assert.deepEqual(r.browser,{url:'https://example.com/guide'});assert(!r.window);assert.equal(r.files.length,0);}},
  {id:'unknown-window',goal:'Open my report in a text editor and help me with it. I do not know the document window title or app identifier.',scope:'',requirements:base,verify:r=>assert.deepEqual(r,base)},
  {id:'research-source',goal:'Read https://example.com/source as a research source and explain its main points. I am not asking to leave a final page or app open.',scope:'',requirements:base,verify:r=>assert.deepEqual(r,base)},
  {id:'ambiguous-pages',goal:'Leave a final Aurora Browser page open, either https://example.com/one or https://example.com/two; I have not chosen which.',scope:'',requirements:base,verify:r=>assert.deepEqual(r,base)},
  {id:'selected-preserved',goal:`Write ${path} with the heading ## Decision. Keep my selected page and window checks exactly as they are.`,scope:'',requirements:selected,verify:r=>{assert.deepEqual(r.browser,selected.browser);assert.deepEqual(r.window,selected.window);assert.equal(r.files[0]?.path,path);}},
  {id:'unsupported-page',goal:'Leave the final browser page at file:///tmp/report.html open. I have no HTTP URL for it.',scope:'',requirements:base,verify:r=>assert.deepEqual(r,base)}
 ];
 assert(!chosen||cases.some(c=>c.id===chosen),'Unknown case');
 const ollama=new Ollama('http://127.0.0.1:11434',report.model.model);ollama.generationOptions=report.model.generation;const chat=ollama.chat.bind(ollama);let active;
 ollama.chat=async(...args)=>{assert.equal(args[1],undefined);active.options=args[4];const reply=await chat(...args);active.raw=reply.content;active.metrics=reply.metrics;return reply;};
 const app={assistant:{busy:new Set(),ollama},actions:{system:{path:async p=>{assert.equal(p,path,'Only the disposable output path may be resolved');return p;}}}};
 for(const c of cases.filter(c=>!chosen||c.id===chosen)){
  active={id:c.id,ok:false,input:{goal:c.goal,scope:c.scope,requirements:structuredClone(c.requirements)}};report.cases.push(active);const started=Date.now();console.log('Running '+c.id);
  try{active.result=await suggestRequirements(app,active.input);c.verify(active.result.requirements);assert.equal(app.assistant.busy.size,0);assert.equal(await readFile(path,'utf8'),'Unchanged fixture\n');active.ok=true;}
  catch(e){active.error=e.message;}
  active.seconds=Math.round((Date.now()-started)/100)/10;console.log(JSON.stringify({id:c.id,ok:active.ok,seconds:active.seconds,error:active.error}));await writeFile(destination,JSON.stringify(report,null,2));
 }
 const after=await sources();report.changedSources=Object.keys(report.source).filter(n=>report.source[n]!==after[n]);report.modelSettingsUnchanged=JSON.stringify(report.model)===JSON.stringify(selection(await get('local-model')));report.ok=report.cases.every(c=>c.ok)&&!report.changedSources.length&&report.modelSettingsUnchanged;
}finally{
 if(dir){await rm(dir,{recursive:true,force:true});report.cleanedUp=true;}
 if(lock){await lock.close();await rm(lockPath);await writeFile(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,report:destination.pathname}));}
}
if(!report.ok)process.exitCode=1;
