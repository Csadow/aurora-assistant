// Guarded local-model repair trial against a disposable copy of Aurora source.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';

const reportName=process.argv.length===3?process.argv[2]:'focus-review-project-live-results.json';
if(process.argv.length>3||!/^[a-z0-9][a-z0-9.-]*\.json$/.test(reportName))throw Error('Supply one report filename under artifacts, or omit it for the default.');
const directory=await mkdtemp(join(tmpdir(),'aurora-focus-review-live-'));
const root=join(directory,'project'),data=join(directory,'data');
const target=join(root,'src/focus-review.mjs'),testPath=join(root,'tests/focus-review.test.mjs');
const original=await readFile(new URL('../src/focus-review.mjs',import.meta.url),'utf8');
const before="decisions[id]?.choiceRevision!==focusHash(c)",after="decisions[id]?.choiceRevision===focusHash(c)";
assert.equal(original.split(before).length,2);
const planted=original.replace(before,after),report={date:new Date().toISOString(),kind:'independent disposable focus-review repair',model:'qwen3.5:9b',thinking:true,sourceSha256:createHash('sha256').update(original).digest('hex'),ok:false,approvals:0,copyApprovals:0,writeApprovals:0,checkApprovals:0};
await mkdir(dirname(target),{recursive:true});await mkdir(dirname(testPath),{recursive:true});await mkdir(data);await mkdir(join(root,'mobile/web'),{recursive:true});
await writeFile(target,planted);await writeFile(join(root,'package.json'),JSON.stringify({type:'module'})+'\n');
const vault=await readFile(new URL('../src/vault.mjs',import.meta.url),'utf8');
const appError=vault.split('\n').find(line=>line.startsWith('export class AppError '));
const sha=vault.split('\n').find(line=>line.startsWith('export const sha ='));
assert(appError&&sha);await writeFile(join(root,'src/vault.mjs'),"import {createHash} from 'node:crypto';\n"+appError+'\n'+sha+"\nexport async function atomic(){throw Error('Atomic writes are outside this trial.');}\n");
const tasks=await readFile(new URL('../mobile/web/tasks.js',import.meta.url),'utf8');
const validDate=tasks.split('\n').find(line=>line.startsWith('export const validDate='));assert(validDate);await writeFile(join(root,'src/task-meta.mjs'),validDate+'\n');
const core=await readFile(new URL('../mobile/web/planner-core.js',import.meta.url),'utf8');
const localDay=core.split('\n').find(line=>line.startsWith('export const localDay='));assert(localDay);await writeFile(join(root,'mobile/web/planner-core.js'),localDay+'\n');
const links=await readFile(new URL('../mobile/web/task-links.js',import.meta.url),'utf8');assert(!/^import /m.test(links));await writeFile(join(root,'mobile/web/task-links.js'),links);
await writeFile(join(data,'models.json'),JSON.stringify({model:report.model,thinking:true}));
await writeFile(testPath,`import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewDays,focusHash,validFocusReviews} from '../src/focus-review.mjs';
const date='2099-01-02',zone='Asia/Atyrau',id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const choice={action:'focus',task:{text:'Finish report'}};
const state=(choices,decisions={})=>({days:{[zone+'|'+date]:{date,timezone:zone,choices}},reviews:{[zone+'|'+date]:{date,timezone:zone,decisions}}});
test('unreviewed focus choices are pending',()=>assert.deepEqual(reviewDays(state({[id]:choice,[other]:{...choice,task:{text:'Read'}}}),date,zone),[{date,total:2,pending:2}]));
test('a matching saved decision clears the pending count',()=>assert.deepEqual(reviewDays(state({[id]:choice},{[id]:{choiceRevision:focusHash(choice)}}),date,zone),[{date,total:1,pending:0}]));
test('a stale decision remains pending after the choice changes',()=>assert.deepEqual(reviewDays(state({[id]:choice},{[id]:{choiceRevision:focusHash({action:'focus',task:{text:'Old'}})}}),date,zone),[{date,total:1,pending:1}]));
test('only focus choices from the selected day and timezone count',()=>{const s=state({[id]:choice,[other]:{action:'later'}});s.days['Other|'+date]={date,timezone:'Other',choices:{[other]:choice}};s.days[zone+'|2099-01-03']={date:'2099-01-03',timezone:zone,choices:{[other]:choice}};assert.deepEqual(reviewDays(s,date,zone),[{date,total:1,pending:1}]);});
test('the saved review validator still rejects malformed decisions',()=>{const s=state({[id]:choice});assert.equal(validFocusReviews(s),true);s.reviews[zone+'|'+date].decisions[id]={action:'reviewed'};assert.equal(validFocusReviews(s),false);});
`);
const execute=promisify(execFile),check=()=>execute(process.execPath,['--test','tests/focus-review.test.mjs'],{cwd:root});
let app;
async function boot(){const a=await createApp({vault:join(directory,'vault'),data,backups:join(directory,'backups'),embedding:'',projects:[],ollamaClient:new Ollama('http://127.0.0.1:11434',report.model)});const allowed=a.system.allowed.bind(a.system);a.system.allowed=path=>{assert(path===root||path.startsWith(root+'/'),'Only the copied focus project is accessible');return allowed(path);};return a;}
async function close(){if(!app)return;await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,30));}
try{
 try{await check();throw Error('Planted focus fixture unexpectedly passed');}catch(e){if(e.message==='Planted focus fixture unexpectedly passed')throw e;assert.match(e.stdout||'',/fail [1-9]/);report.baselineFailed=true;}
 await writeFile(target,original);const pristine=await check();assert.match(pristine.stdout,/pass 5/);report.pristinePassed=true;await writeFile(target,planted);
 const get=async path=>{const r=await fetch('http://127.0.0.1:4717'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
 const selected=await get('/api/local-model');assert.equal(selected.model,report.model);assert.equal(selected.thinking,true);assert.equal((await get('/api/embodiment')).phase,'idle');assert(!(await get('/api/workflows')).some(w=>['planning','running','queued'].includes(w.status)));
 app=await boot();await app.vault.save('20 Projects/Focus review trial.md','# Focus review trial\n',null);
 const profile=await app.projectWorkspaces.save({name:'Copied focus review',notePath:'20 Projects/Focus review trial.md',folders:[root],checks:[{name:'Focus review tests',program:'node',args:['--test','tests/focus-review.test.mjs'],cwd:root,outputIncludes:'pass 5'}]});
 const started=Date.now(),w=await app.workflows.start({goal:'Repair the copied evening focus review pending count. An unreviewed focus choice and a stale decision should remain pending; an exact matching saved decision should clear it. Keep other dates, timezones, non-focus choices and saved-review validation intact. Inspect source and tests, test each exact candidate in a temporary copy before editing, run the saved Focus review tests on the original copied project, verify the actual pass marker, and read the final source.',scope:`Only the disposable project at ${root}. Only src/focus-review.mjs may be edited. Preserve unrelated review behavior.`,projectId:profile.id,projectRevision:profile.revision,projectCheckNames:['Focus review tests'],copyBeforeEditCheck:'Focus review tests',requirements:{files:[{path:target,lineEndings:'lf',finalNewline:'required'}],commands:[]}});
 let previous='';while(Date.now()-started<600000){const state=await app.store.get('workflows',w.id);report.record=state;const progress=JSON.stringify([state.status,state.current,state.calls,state.operations.at(-1)?.requestedTool||state.operations.at(-1)?.name]);if(progress!==previous){console.log(progress);previous=progress;}if(['completed','paused','needs_help','needs_verification','waiting_input','cancelled'].includes(state.status)&&!app.workflows.running.has(w.id))break;
  if(state.status==='plan_review'&&!app.workflows.running.has(w.id)){assert.equal(state.operations.length,0);await app.workflows.control(w.id,'approve_plan','',state.revision);report.planReviews=(report.planReviews||0)+1;}
  if(state.status==='waiting_approval')for(const op of state.operations.filter(o=>o.status==='waiting_approval'&&o.action)){const action=await app.store.get('actions',op.action);if(action.status!=='pending')continue;
   if(action.kind==='write'){const current=await readFile(target,'utf8');assert.equal(action.payload.path,target);assert.equal(action.payload.before,current);assert(Buffer.byteLength(action.payload.content)<64000);report.writeApprovals++;}
   else if(action.kind==='test_copy'){const p=action.payload,current=await readFile(target,'utf8');assert.equal(p.root,root);assert.equal(p.candidate.path,target);assert.equal(p.candidate.before,current);assert.equal(p.check.program,'/usr/bin/node');assert.deepEqual(p.check.args,['--test','tests/focus-review.test.mjs']);assert.equal(p.check.cwd,root);assert.equal(p.check.outputIncludes,'pass 5');for(const f of p.files){assert(f.path.startsWith(root+'/'));assert.equal(f.content,await readFile(f.path,'utf8'));}report.copyApprovals++;}
   else{assert.equal(action.kind,'command');assert.equal(action.payload.program,'/usr/bin/node');assert.deepEqual(action.payload.args,['--test','tests/focus-review.test.mjs']);assert.equal(action.payload.cwd,root);report.checkApprovals++;}
   await app.actions.decide(action.id,'approve',action.digest);report.approvals++;}
  await new Promise(r=>setTimeout(r,200));}
 assert.equal(report.record.status,'completed',report.record.error||'Focus workflow did not complete');const checks=(await app.workflows.read(w.id)).requirementChecks;assert(checks.length>=2&&checks.every(c=>c.passed));assert(report.copyApprovals>=1&&report.writeApprovals>=1&&report.checkApprovals>=1);const final=await check();assert.match(final.stdout,/pass 5/);report.finalMatchOriginal=(await readFile(target,'utf8'))===original;report.ok=true;
}catch(e){report.error=e.message;console.error(e.message);process.exitCode=1;}
finally{await close();report.seconds=report.record?Math.round((Date.now()-Date.parse(report.record.created))/1000):undefined;report.calls=report.record?.calls;report.toolFailures=report.record?.operations.filter(o=>o.status==='failed').length;await writeFile(new URL('../artifacts/'+reportName,import.meta.url),JSON.stringify(report,null,2));await rm(directory,{recursive:true,force:true});}
