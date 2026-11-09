// Independent local diagnosis in copied calendar-block code. No Google account,
// personal event, or original source is used as an action target.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';

const reportArgument=process.argv.slice(2).find(arg=>arg.startsWith('--report='));
if(process.argv.slice(2).some(arg=>arg!=='--copy-first'&&arg!==reportArgument))throw Error('Use --copy-first and an optional --report=filename.json.');
const copyFirst=process.argv.includes('--copy-first');
const reportName=reportArgument?.slice('--report='.length)||(copyFirst?'calendar-blocks-copy-first-results.json':'calendar-blocks-project-live-results.json');
if(!/^[a-z0-9][a-z0-9.-]*\.json$/.test(reportName))throw Error('The report must be one JSON filename under artifacts.');
const dir=await mkdtemp(join(tmpdir(),'aurora-calendar-blocks-live-')),root=join(dir,'project'),data=join(dir,'data');
const target=join(root,'src/calendar-time.mjs'),testPath=join(root,'tests/calendar-blocks.test.mjs');
const original=await readFile(new URL('../src/calendar-time.mjs',import.meta.url),'utf8');
const changes=[["e.transparency==='transparent'","e.transparency==='opaque'"],['if(end<=start)continue;','if(end<start)continue;']];
let planted=original;for(const [before,after] of changes){assert.equal(planted.split(before).length,2);planted=planted.replace(before,after);}
const correctCandidates=current=>{
 const candidates=changes.filter(([,wrong])=>current.includes(wrong)).map(([right,wrong])=>current.replace(wrong,right));
 const both=changes.reduce((text,[right,wrong])=>text.replace(wrong,right),current);if(both!==current)candidates.push(both);
 return candidates;
};
const copyCandidates=current=>[
 ...correctCandidates(current),
 current.replace("||e.transparency==='opaque'",''),
 current.replace('if(end<start)continue;','if(end<start&&e.start.dateTime!==e.end.dateTime)continue;')
].filter(candidate=>candidate!==current);
const report={date:new Date().toISOString(),mode:copyFirst?'copy-first':'ordinary',model:'qwen3.5:9b',thinking:true,sourceSha256:createHash('sha256').update(original).digest('hex'),ok:false,approvals:0,restarts:0};
const copied=['src/vault.mjs','src/read-view.mjs','src/task-meta.mjs','mobile/web/tasks.js','mobile/web/task-links.js'];
for(const name of copied){const path=join(root,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,await readFile(new URL('../'+name,import.meta.url)));}
await mkdir(dirname(target),{recursive:true});await mkdir(dirname(testPath),{recursive:true});await mkdir(data);
await writeFile(target,planted);await writeFile(join(root,'package.json'),'{"type":"module"}\n');await writeFile(join(data,'models.json'),JSON.stringify({model:report.model,thinking:true}));
await writeFile(testPath,`import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarBlocks} from '../src/calendar-time.mjs';
const day='2026-10-12',at=time=>day+'T'+time+':00Z';
const event=(id,start='09:00',end='10:00',transparency='opaque')=>({id,summary:id,transparency,start:{dateTime:at(start)},end:{dateTime:at(end)}});
test('opaque timed event blocks its actual minutes',()=>{const blocks=calendarBlocks([event('busy')],day,'UTC');assert.equal(blocks.length,1);assert.equal(blocks[0].start,540);assert.equal(blocks[0].end,600);});
test('transparent event leaves the day free',()=>{assert.deepEqual(calendarBlocks([event('free','09:00','10:00','transparent')],day,'UTC'),[]);});
test('zero-length event cannot reserve time',()=>{assert.deepEqual(calendarBlocks([event('zero','09:00','09:00')],day,'UTC'),[]);});
test('single-day all-day event remains visible',()=>{const blocks=calendarBlocks([{id:'all',summary:'All day',start:{date:day},end:{date:'2026-10-13'}}],day,'UTC');assert.equal(blocks.length,1);assert.deepEqual([blocks[0].start,blocks[0].end,blocks[0].allDay],[0,1440,true]);});
`);
const execute=promisify(execFile),check=()=>execute(process.execPath,['--test','tests/calendar-blocks.test.mjs'],{cwd:root});
let app;
async function boot(){const a=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),embedding:'',projects:[],ollamaClient:new Ollama('http://127.0.0.1:11434',report.model)});const allowed=a.system.allowed.bind(a.system);a.system.allowed=path=>{assert(path===root||path.startsWith(root+'/'),'Only the copied project is accessible');return allowed(path);};return a;}
async function close(){if(!app)return;await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,30));}
try{
 try{await check();throw Error('Planted fixture unexpectedly passed');}catch(e){if(e.message==='Planted fixture unexpectedly passed')throw e;assert.match(e.stdout||'',/fail [1-9]/);report.baselineFailed=true;}
 await writeFile(target,original);const pristine=await check();assert.match(pristine.stdout,/pass 4/);report.pristinePassed=true;await writeFile(target,planted);
 const get=async path=>{const r=await fetch('http://127.0.0.1:4717'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
 const selected=await get('/api/local-model');assert.equal(selected.model,report.model);assert.equal(selected.thinking,true);
 assert.equal((await get('/api/embodiment')).phase,'idle');assert(!(await get('/api/workflows')).some(w=>['planning','running','queued'].includes(w.status)));assert(!(await get('/api/actions')).some(a=>a.status==='running'));assert(!(await get('/api/agents')).runs.some(r=>['running','queued'].includes(r.status)));
 app=await boot();const profile=await app.projectWorkspaces.save({name:'Copied calendar blocks',notePath:'20 Projects/Example Project.md',folders:[root],checks:[{name:'Calendar block tests',program:'node',args:['--test','tests/calendar-blocks.test.mjs'],cwd:root,outputIncludes:'pass 4'}]});
 const started=Date.now(),w=await app.workflows.start({goal:'Repair the calendar block view so ordinary opaque timed events reserve their true interval, transparent events reserve nothing, and zero-length events reserve nothing. Single-day all-day events must still fill the day. Inspect the module and tests, change only the calendar-time module, run the saved Calendar block tests, verify their actual pass marker, and read the final module after testing.'+(copyFirst?' Test each exact candidate in a temporary copy before requesting an edit; review the baseline and candidate results.':''),scope:`Only the copied project at ${root}. Only src/calendar-time.mjs may be edited. Preserve unrelated event and task behavior.`,projectId:profile.id,projectRevision:profile.revision,projectCheckNames:['Calendar block tests'],...(copyFirst?{copyBeforeEditCheck:'Calendar block tests'}:{}),requirements:{files:[{path:target,lineEndings:'lf',finalNewline:'required'}],commands:[]}});
 let previous='';
 while(Date.now()-started<600000){
  const state=await app.store.get('workflows',w.id);report.record=state;const progress=JSON.stringify([state.status,state.current,state.calls,state.operations.at(-1)?.requestedTool||state.operations.at(-1)?.name]);if(progress!==previous){console.log(progress);previous=progress;}
  if(['completed','paused','needs_help','needs_verification','waiting_input','cancelled'].includes(state.status)&&!app.workflows.running.has(w.id))break;
  if(state.status==='plan_review'&&!app.workflows.running.has(w.id)){assert.equal(state.operations.length,0);await app.workflows.control(w.id,'approve_plan','',state.revision);report.planReviews=(report.planReviews||0)+1;}
  if(state.status==='waiting_approval')for(const op of state.operations.filter(o=>o.status==='waiting_approval'&&o.action)){
   const action=await app.store.get('actions',op.action);if(action.status!=='pending')continue;
   if(action.kind==='write'){
    const current=await readFile(target,'utf8');assert.equal(action.payload.path,target);assert.equal(action.payload.before,current);assert(correctCandidates(current).includes(action.payload.content),'Only exact known corrections may be approved');
    if(!report.restarts){await app.workflows.control(w.id,'pause');await close();app=await boot();assert.equal((await app.workflows.read(w.id)).status,'paused');assert.equal((await app.store.get('actions',action.id)).status,'pending');await assert.rejects(app.actions.decide(action.id,'approve',action.digest),/Resume/);await app.workflows.control(w.id,'resume');report.restarts++;}
   }else if(action.kind==='test_copy'){
    const p=action.payload,current=await readFile(target,'utf8');assert.equal(p.root,root);assert.equal(p.candidate.path,target);assert.equal(p.candidate.before,current);assert(copyCandidates(current).includes(p.candidate.content),'Only listed one-fragment candidates may be tested');assert.equal(p.check.program,'/usr/bin/node');assert.deepEqual(p.check.args,['--test','tests/calendar-blocks.test.mjs']);assert.equal(p.check.cwd,root);assert.equal(p.check.outputIncludes,'pass 4');for(const f of p.files){assert(f.path.startsWith(root+'/'));assert.equal(f.content,await readFile(f.path,'utf8'));}
   }else{assert.equal(action.kind,'command');assert.equal(action.payload.program,'/usr/bin/node');assert.deepEqual(action.payload.args,['--test','tests/calendar-blocks.test.mjs']);assert.equal(action.payload.cwd,root);}
   await app.actions.decide(action.id,'approve',action.digest);report.approvals++;
  }
  await new Promise(r=>setTimeout(r,200));
 }
 assert.equal(report.record.status,'completed',report.record.error||'Task timed out');const checks=(await app.workflows.read(w.id)).requirementChecks;assert(checks.length>=2&&checks.every(c=>c.passed));assert.equal(await readFile(target,'utf8'),original);assert.equal(report.restarts,1);assert([1,2].includes(report.record.operations.filter(o=>o.name==='propose_file_edit'&&o.status==='completed').length));
 report.ok=true;
}catch(e){report.error=e.message;console.error(e.message);process.exitCode=1;}
finally{await close();report.seconds=report.record?Math.round((Date.now()-Date.parse(report.record.created))/1000):undefined;report.calls=report.record?.calls;report.toolFailures=report.record?.operations.filter(o=>o.status==='failed').length;await writeFile(new URL('../artifacts/'+reportName,import.meta.url),JSON.stringify(report,null,2));await rm(dir,{recursive:true,force:true});}
