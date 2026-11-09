// Read-only local-model execution in a disposable workspace, followed by an
// explicit fixture-only planner completion decision. Personal tasks are untouched.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';
const dir=await mkdtemp(join(tmpdir(),'aurora-planner-workflow-live-')),data=join(dir,'data'),workspace=join(dir,'workspace'),file=join(workspace,'current.txt');
const report={date:new Date().toISOString(),ok:false},started=Date.now();let app;
const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
try{
 const model=await get('local-model');assert.equal((await get('embodiment')).phase,'idle');assert(!(await get('workflows')).some(w=>['running','planning','queued'].includes(w.status)));assert(!(await get('actions')).some(a=>a.status==='running'));assert(!(await get('agents')).runs.some(a=>['running','queued'].includes(a.status)));
 report.model=model.model;report.generation=model.generation;await mkdir(data);await mkdir(workspace);await writeFile(file,'Current value: maple-527\n');await writeFile(join(data,'models.json'),JSON.stringify({model:model.model,thinking:model.thinking}));
 app=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),embedding:'',projects:[],ollamaClient:new Ollama('http://127.0.0.1:11434',model.model)});
 const allowed=app.system.allowed.bind(app.system);app.system.allowed=path=>{assert(path===workspace||path.startsWith(workspace+'/'),'Only the temporary workspace may be accessed');return allowed(path);};app.actions.propose=async()=>{throw Error('This read-only trial cannot propose actions.');};
 await app.vault.addTask('Read and verify the current saved value',{planDate:'2026-10-26',startTime:'10:00',duration:30,due:'2026-10-30'});const task=(await app.vault.tasks()).find(t=>t.text==='Read and verify the current saved value'),d=await app.taskWorkflows.draft({task});
 const {id}=await app.taskWorkflows.start({id:d.id,revision:d.revision,goal:`Read only ${file} and report its current complete value. Verify the saved file conditions from that fresh read. Do not edit files, run commands or use applications. Leave the planner checkbox unchanged for my later review.`,scope:`Read only ${workspace}.`,requirements:{files:[{path:file,finalNewline:'required',lineEndings:'lf',requiredText:['Current value: maple-527']}],commands:[]},acknowledge:true});let reviewed=false,last='';
 while(Date.now()-started<360000){const current=await app.store.get('workflows',id);report.workflow=current;const status=JSON.stringify([current.status,current.calls,current.operations.at(-1)?.name]);if(status!==last){console.log(status);last=status;}
  if(current.status==='plan_review'&&!app.workflows.running.has(id)){assert.deepEqual(current.operations,[]);assert.equal((await app.vault.tasks()).find(t=>t.id===task.id).done,false);await app.workflows.control(id,'approve_plan','',current.revision);reviewed=true;}
  if(!app.workflows.running.has(id)&&['completed','paused','needs_help','needs_verification','waiting_input','cancelled'].includes(current.status))break;await new Promise(r=>setTimeout(r,500));
 }
 assert(reviewed);assert.equal(report.workflow.status,'completed');assert(report.workflow.operations.some(o=>o.name==='read_system_file'&&o.status==='completed'&&o.result.content==='Current value: maple-527\n'));assert(report.workflow.result.includes('maple-527'));assert.equal((await app.store.list('actions')).length,0);assert.equal(await readFile(file,'utf8'),'Current value: maple-527\n');
 assert.equal((await app.vault.tasks()).find(t=>t.id===task.id).done,false);report.openAfterWorkflow=true;const r=await app.taskWorkflows.preview({id:d.id});assert.equal((await app.vault.tasks()).find(t=>t.id===task.id).done,false);
 const result=await app.taskWorkflows.decide({id:d.id,reviewId:r.review.id,action:'complete',acknowledge:true});report.completionDecision=result.review.status;const after=(await app.vault.tasks()).find(t=>t.id===task.id);assert(after.done);assert.deepEqual({...after,done:false,revision:task.revision},task);report.ok=true;
}catch(e){report.error=e.message;console.error(e.stack);process.exitCode=1;}
finally{if(app){await app.workflows.close();app.calendar.close();app.recurring.stop();app.backups.stop();app.actions.stopAll();}report.seconds=Math.round((Date.now()-started)/1000);await writeFile(new URL('../artifacts/planner-workflows-live-results.json',import.meta.url),JSON.stringify(report,null,2));await rm(dir,{recursive:true,force:true});console.log(JSON.stringify({ok:report.ok,seconds:report.seconds,error:report.error}));}
