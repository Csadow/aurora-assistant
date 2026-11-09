// Disposable local-model repair trial outside Aurora's personal source/data.
// The planted defect is in a copy; approval review is simulated only for that copy.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';

if(process.argv.length!==2)throw Error('This trial takes no arguments.');
const directory=await mkdtemp(join(tmpdir(),'aurora-capacity-live-'));
const root=join(directory,'project'),data=join(directory,'data');
const target=join(root,'src/planning-capacity.mjs'),testPath=join(root,'tests/capacity.test.mjs');
const original=await readFile(new URL('../src/planning-capacity.mjs',import.meta.url),'utf8');
const before='const occupied=merge(busy.map(([s,e])=>[s,e]))';
const after='const occupied=busy.map(([s,e])=>[s,e])';
assert.equal(original.split(before).length,2);
const planted=original.replace(before,after);
const report={date:new Date().toISOString(),kind:'independent disposable planning-capacity repair',model:'qwen3.5:9b',thinking:true,sourceSha256:createHash('sha256').update(original).digest('hex'),ok:false,approvals:0,copyApprovals:0,writeApprovals:0,checkApprovals:0};
await mkdir(dirname(target),{recursive:true});await mkdir(dirname(testPath),{recursive:true});await mkdir(data);
await mkdir(join(root,'mobile/web'),{recursive:true});
await writeFile(target,planted);
await writeFile(join(root,'package.json'),'{"type":"module"}\n');
// planningCapacity uses only these two exported planner helpers. Keep their
// definitions identical to the current production source for this trial.
const core=await readFile(new URL('../mobile/web/planner-core.js',import.meta.url),'utf8');
const helpers=core.split('\n').filter(line=>line.startsWith('export const localDay=')||line.startsWith('export const minutes='));
assert.equal(helpers.length,2);await writeFile(join(root,'mobile/web/planner-core.js'),helpers.join('\n')+'\n');
await writeFile(join(data,'models.json'),JSON.stringify({model:report.model,thinking:true}));
await writeFile(testPath,`import test from 'node:test';
import assert from 'node:assert/strict';
import {planningCapacity} from '../src/planning-capacity.mjs';
import {localDay} from '../mobile/web/planner-core.js';
const base={date:'2099-01-02',now:new Date('2099-01-01T00:00:00Z'),start:'09:00',end:'13:00',gap:0,busy:[]};
test('an empty future work window stays fully available',()=>{const r=planningCapacity(base);assert.equal(r.windowMinutes,240);assert.equal(r.busyMinutes,0);assert.equal(r.availableMinutes,240);});
test('out-of-order overlapping busy intervals count their union once',()=>{const r=planningCapacity({...base,busy:[[660,720],[600,690]]});assert.equal(r.busyMinutes,120);assert.equal(r.availableMinutes,120);assert.equal(r.largestSlotMinutes,60);});
test('buffers and placed work preserve the remaining free minutes',()=>{const r=planningCapacity({...base,gap:10,busy:[[660,720],[600,690]],placed:[[540,570]]});assert.equal(r.busyMinutes,120);assert.equal(r.bufferMinutes,20);assert.equal(r.availableMinutes,100);assert.equal(r.remainingMinutes,60);});
test('the current-day five-minute floor and explicit day off remain intact',()=>{const now=new Date(2026,9,12,10,10),date=localDay(now),r=planningCapacity({...base,date,now,start:'09:00',end:'12:00'});assert.equal(r.availableMinutes,105);assert.equal(planningCapacity({...base,date,now,windows:[]}).availableMinutes,0);});
`);
const execute=promisify(execFile),check=()=>execute(process.execPath,['--test','tests/capacity.test.mjs'],{cwd:root});
let app;
async function boot(){
 const a=await createApp({vault:join(directory,'vault'),data,backups:join(directory,'backups'),embedding:'',projects:[],ollamaClient:new Ollama('http://127.0.0.1:11434',report.model)});
 const allowed=a.system.allowed.bind(a.system);a.system.allowed=path=>{assert(path===root||path.startsWith(root+'/'),'Only the copied planning project is accessible');return allowed(path);};return a;
}
async function close(){if(!app)return;await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,30));}
try{
 try{await check();throw Error('Planted capacity fixture unexpectedly passed');}catch(e){if(e.message==='Planted capacity fixture unexpectedly passed')throw e;assert.match(e.stdout||'',/fail [1-9]/);report.baselineFailed=true;}
 await writeFile(target,original);const pristine=await check();assert.match(pristine.stdout,/pass 4/);report.pristinePassed=true;await writeFile(target,planted);
 const get=async path=>{const r=await fetch('http://127.0.0.1:4717'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
 const selected=await get('/api/local-model');assert.equal(selected.model,report.model);assert.equal(selected.thinking,true);
 assert.equal((await get('/api/embodiment')).phase,'idle');assert(!(await get('/api/workflows')).some(w=>['planning','running','queued'].includes(w.status)));
 app=await boot();await app.vault.save('20 Projects/Capacity trial.md','# Capacity trial\n',null);
 const profile=await app.projectWorkspaces.save({name:'Copied planning capacity',notePath:'20 Projects/Capacity trial.md',folders:[root],checks:[{name:'Capacity tests',program:'node',args:['--test','tests/capacity.test.mjs'],cwd:root,outputIncludes:'pass 4'}]});
 const started=Date.now(),w=await app.workflows.start({goal:'Repair the copied planning-capacity calculation so the saved tests pass for out-of-order overlapping busy intervals, buffer time, placed work and the current-day start floor. Inspect the source and tests, test each exact candidate in a temporary copy before editing, use the saved Capacity tests on the original copied project, verify the actual pass marker, and read the final source after testing.',scope:`Only the disposable project at ${root}. Only src/planning-capacity.mjs may be edited. Preserve unrelated capacity behavior.`,projectId:profile.id,projectRevision:profile.revision,projectCheckNames:['Capacity tests'],copyBeforeEditCheck:'Capacity tests',requirements:{files:[{path:target,lineEndings:'lf',finalNewline:'required'}],commands:[]}});
 let previous='';
 while(Date.now()-started<600000){
  const state=await app.store.get('workflows',w.id);report.record=state;
  const progress=JSON.stringify([state.status,state.current,state.calls,state.operations.at(-1)?.requestedTool||state.operations.at(-1)?.name]);if(progress!==previous){console.log(progress);previous=progress;}
  if(['completed','paused','needs_help','needs_verification','waiting_input','cancelled'].includes(state.status)&&!app.workflows.running.has(w.id))break;
  if(state.status==='plan_review'&&!app.workflows.running.has(w.id)){assert.equal(state.operations.length,0);await app.workflows.control(w.id,'approve_plan','',state.revision);report.planReviews=(report.planReviews||0)+1;}
  if(state.status==='waiting_approval')for(const op of state.operations.filter(o=>o.status==='waiting_approval'&&o.action)){
   const action=await app.store.get('actions',op.action);if(action.status!=='pending')continue;
   if(action.kind==='write'){
    const current=await readFile(target,'utf8');assert.equal(action.payload.path,target);assert.equal(action.payload.before,current);assert(Buffer.byteLength(action.payload.content)<64000);report.writeApprovals++;
   }else if(action.kind==='test_copy'){
    const p=action.payload,current=await readFile(target,'utf8');assert.equal(p.root,root);assert.equal(p.candidate.path,target);assert.equal(p.candidate.before,current);assert.equal(p.check.program,'/usr/bin/node');assert.deepEqual(p.check.args,['--test','tests/capacity.test.mjs']);assert.equal(p.check.cwd,root);assert.equal(p.check.outputIncludes,'pass 4');for(const f of p.files){assert(f.path.startsWith(root+'/'));assert.equal(f.content,await readFile(f.path,'utf8'));}report.copyApprovals++;
   }else{assert.equal(action.kind,'command');assert.equal(action.payload.program,'/usr/bin/node');assert.deepEqual(action.payload.args,['--test','tests/capacity.test.mjs']);assert.equal(action.payload.cwd,root);report.checkApprovals++;}
   await app.actions.decide(action.id,'approve',action.digest);report.approvals++;
  }
  await new Promise(r=>setTimeout(r,200));
 }
 assert.equal(report.record.status,'completed',report.record.error||'Capacity workflow did not complete');
 const checks=(await app.workflows.read(w.id)).requirementChecks;assert(checks.length>=2&&checks.every(c=>c.passed));
 assert(report.copyApprovals>=1&&report.writeApprovals>=1&&report.checkApprovals>=1);
 const final=await check();assert.match(final.stdout,/pass 4/);report.finalMatchOriginal=(await readFile(target,'utf8'))===original;report.ok=true;
}catch(e){report.error=e.message;console.error(e.message);process.exitCode=1;}
finally{await close();report.seconds=report.record?Math.round((Date.now()-Date.parse(report.record.created))/1000):undefined;report.calls=report.record?.calls;report.toolFailures=report.record?.operations.filter(o=>o.status==='failed').length;await writeFile(new URL('../artifacts/planning-capacity-project-live-results.json',import.meta.url),JSON.stringify(report,null,2));await rm(directory,{recursive:true,force:true});}
