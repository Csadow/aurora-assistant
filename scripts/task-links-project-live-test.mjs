// Independent local project diagnosis in an isolated copy of shared task-link code.
// The goal names behavior, while fixture review allows only the original source.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';

const dir=await mkdtemp(join(tmpdir(),'aurora-task-links-live-')),root=join(dir,'project'),data=join(dir,'data');
const target=join(root,'mobile/web/task-links.js'),testPath=join(root,'tests/prerequisite.test.mjs');
const original=await readFile(new URL('../mobile/web/task-links.js',import.meta.url),'utf8');
const old="else if(!d.done)reasons.push('Waiting for '+d.text);",defect="else if(d.done)reasons.push('Waiting for '+d.text);";
assert(original.includes(old));assert.equal(original.split(old).length,2);
const report={date:new Date().toISOString(),model:'qwen3.5:9b',thinking:true,sourceSha256:createHash('sha256').update(original).digest('hex'),ok:false,approvals:0,restarts:0};
await mkdir(dirname(target),{recursive:true});await mkdir(dirname(testPath),{recursive:true});await mkdir(data);
await writeFile(target,original.replace(old,defect));await writeFile(join(root,'package.json'),'{"type":"module"}\n');
await writeFile(join(data,'models.json'),JSON.stringify({model:report.model,thinking:true}));
await writeFile(testPath,`import test from 'node:test';
import assert from 'node:assert/strict';
import {taskGraph,taskRef,validateTaskLinks} from '../mobile/web/task-links.js';
const prerequisite='11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222';
const rows=done=>[{id:prerequisite,path:'40 Tasks/Fixture.md',line:0,text:'Prerequisite',done},{id:child,path:'40 Tasks/Fixture.md',line:1,text:'Follow-up',done:false,dependsOn:[prerequisite]}];
test('an unfinished prerequisite blocks follow-up work',()=>{const tasks=rows(false);assert.equal(taskGraph(tasks).states.get(taskRef(tasks[1])).blocked,true);});
test('a completed prerequisite allows follow-up work',()=>{const tasks=rows(true);assert.equal(taskGraph(tasks).states.get(taskRef(tasks[1])).blocked,false);});
test('ready-task validation follows the same prerequisite state',()=>{assert.throws(()=>validateTaskLinks(rows(false),rows(false)[1],[],{requireReady:true,changed:false}));const tasks=rows(true);assert.equal(validateTaskLinks(tasks,tasks[1],[],{requireReady:true,changed:false}).blocked,false);});
`);
let app;
async function boot(){
 const a=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),embedding:'',projects:[],ollamaClient:new Ollama('http://127.0.0.1:11434',report.model)});
 const allowed=a.system.allowed.bind(a.system);a.system.allowed=path=>{assert(path===root||path.startsWith(root+'/'),'Only the copied project is accessible');return allowed(path);};return a;
}
async function close(){if(!app)return;await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,30));}
try{
 const get=async path=>{const r=await fetch('http://127.0.0.1:4717'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
 const selected=await get('/api/local-model');assert.equal(selected.model,report.model);assert.equal(selected.thinking,true);
 assert.equal((await get('/api/embodiment')).phase,'idle');assert(!(await get('/api/workflows')).some(w=>['planning','running','queued'].includes(w.status)));assert(!(await get('/api/actions')).some(a=>a.status==='running'));assert(!(await get('/api/agents')).runs.some(r=>['running','queued'].includes(r.status)));
 app=await boot();const profile=await app.projectWorkspaces.save({name:'Copied shared task links',notePath:'20 Projects/Example Project.md',folders:[root],checks:[{name:'Prerequisite state tests',program:'node',args:['--test','tests/prerequisite.test.mjs'],cwd:root,outputIncludes:'pass 3'}]});
 const started=Date.now(),w=await app.workflows.start({goal:'Repair the shared task-link logic so a follow-up task stays blocked while its prerequisite is unfinished and becomes ready after that prerequisite is completed. Inspect the current source and tests, change only the task-link module, run the saved prerequisite tests, verify their actual pass marker, and read the final module after testing.',scope:`Only the copied project at ${root}. Only mobile/web/task-links.js may be edited. Preserve unrelated task-link behavior and the existing tests.`,projectId:profile.id,projectRevision:profile.revision,projectCheckNames:['Prerequisite state tests'],requirements:{files:[{path:target,lineEndings:'lf',finalNewline:'required'}],commands:[]}});
 let previous='';
 while(Date.now()-started<600000){
  const state=await app.store.get('workflows',w.id);report.record=state;const progress=JSON.stringify([state.status,state.current,state.calls,state.operations.at(-1)?.requestedTool||state.operations.at(-1)?.name]);if(progress!==previous){console.log(progress);previous=progress;}
  if(['completed','paused','needs_help','needs_verification','waiting_input','cancelled'].includes(state.status)&&!app.workflows.running.has(w.id))break;
  if(state.status==='plan_review'&&!app.workflows.running.has(w.id)){assert.equal(state.operations.length,0);await app.workflows.control(w.id,'approve_plan','',state.revision);report.planReviews=(report.planReviews||0)+1;}
  if(state.status==='waiting_approval')for(const op of state.operations.filter(o=>o.status==='waiting_approval'&&o.action)){
   const action=await app.store.get('actions',op.action);if(action.status!=='pending')continue;
   if(action.kind==='write'){
    assert.equal(action.payload.path,target);assert.equal(action.payload.content,original,'Only the known original task-link source may be approved');
    if(!report.restarts){await app.workflows.control(w.id,'pause');await close();app=await boot();assert.equal((await app.workflows.read(w.id)).status,'paused');assert.equal((await app.store.get('actions',action.id)).status,'pending');await assert.rejects(app.actions.decide(action.id,'approve',action.digest),/Resume/);await app.workflows.control(w.id,'resume');report.restarts++;}
   }else if(action.kind==='test_copy'){
    const p=action.payload;assert.equal(p.root,root);assert.equal(p.candidate.path,target);assert.equal(p.candidate.before,await readFile(target,'utf8'));assert.equal(p.candidate.content,original);assert.equal(p.check.program,'/usr/bin/node');assert.deepEqual(p.check.args,['--test','tests/prerequisite.test.mjs']);assert.equal(p.check.cwd,root);assert.equal(p.check.outputIncludes,'pass 3');for(const f of p.files){assert(f.path.startsWith(root+'/'));assert.equal(f.content,await readFile(f.path,'utf8'));}
   }else{assert.equal(action.kind,'command');assert.equal(action.payload.program,'/usr/bin/node');assert.deepEqual(action.payload.args,['--test','tests/prerequisite.test.mjs']);assert.equal(action.payload.cwd,root);}
   await app.actions.decide(action.id,'approve',action.digest);report.approvals++;
  }
  await new Promise(r=>setTimeout(r,200));
 }
 assert.equal(report.record.status,'completed',report.record.error||'Task timed out');const checks=(await app.workflows.read(w.id)).requirementChecks;assert(checks.length>=2&&checks.every(c=>c.passed));assert.equal(await readFile(target,'utf8'),original);assert.equal(report.restarts,1);assert.equal(report.record.operations.filter(o=>o.name==='propose_file_edit'&&o.status==='completed').length,1);
 report.ok=true;
}catch(e){report.error=e.message;console.error(e.message);process.exitCode=1;}
finally{await close();report.seconds=report.record?Math.round((Date.now()-Date.parse(report.record.created))/1000):undefined;report.calls=report.record?.calls;report.toolFailures=report.record?.operations.filter(o=>o.status==='failed').length;await writeFile(new URL('../artifacts/task-links-project-live-results.json',import.meta.url),JSON.stringify(report,null,2));await rm(dir,{recursive:true,force:true});}
