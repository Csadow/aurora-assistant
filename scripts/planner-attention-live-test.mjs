// Real local-model question → reviewed answer → fresh plan → completion.
// Reads and explicit fixture decisions stay inside a disposable workspace.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';
const dir=await mkdtemp(join(tmpdir(),'aurora-attention-live-')),workspace=join(dir,'workspace'),data=join(dir,'data'),first=join(workspace,'first.txt'),second=join(workspace,'second.txt');
const report={date:new Date().toISOString(),ok:false},started=Date.now();let app;
const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
try{
 const model=await get('local-model');assert.equal((await get('embodiment')).phase,'idle');assert(!(await get('workflows')).some(w=>['running','planning','queued'].includes(w.status)));assert(!(await get('actions')).some(a=>a.status==='running'));assert(!(await get('agents')).runs.some(a=>['running','queued'].includes(a.status)));
 report.model=model.model;report.generation=model.generation;await mkdir(data);await mkdir(workspace);await writeFile(first,'First value: ash-248\n');await writeFile(second,'Second value: pine-793\n');await writeFile(join(data,'models.json'),JSON.stringify({model:model.model,thinking:model.thinking}));
 app=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),embedding:'',projects:[],ollamaClient:new Ollama('http://127.0.0.1:11434',model.model)});
 const allowed=app.system.allowed.bind(app.system);app.system.allowed=path=>{assert(path===workspace||path.startsWith(workspace+'/'));return allowed(path);};app.actions.propose=async()=>{throw Error('This read-only attention trial cannot propose actions.');};
 await app.vault.addTask('Choose a file and verify its saved contents',{planDate:'2026-10-26',startTime:'10:00',duration:30});const task=(await app.vault.tasks()).find(t=>t.text==='Choose a file and verify its saved contents'),d=await app.taskWorkflows.draft({task});
 const {id}=await app.taskWorkflows.start({...d,goal:`I need the complete current contents of one of two files: ${first} or ${second}. Before reading either file, ask me which one to use with ask_user, then wait for my answer. Do not guess. After I answer, read only the chosen file and report its exact value with fresh evidence. Do not edit files, run commands, use applications or cloud services. Leave the planner checkbox for my later review.`,scope:`Read only ${workspace}.`,acknowledge:true});
 let answered=false,approvals=0,last='';
 while(Date.now()-started<360000){
  const w=await app.store.get('workflows',id);report.workflow=w;const progress=JSON.stringify([w.status,w.revision,w.calls,w.operations.at(-1)?.name]);if(progress!==last){console.log(progress);last=progress;}
  if(!app.workflows.running.has(id)){
   if(w.status==='plan_review'){assert.equal((await app.taskWorkflows.attention(d.id)).attention.kind,'plan');await app.workflows.control(id,'approve_plan','',w.revision);approvals++;}
   else if(w.status==='waiting_input'&&!answered){
    assert(w.question);assert(!w.operations.some(o=>o.name==='read_system_file'));const item=await app.taskWorkflows.attention(d.id);assert.equal(item.attention.kind,'question');assert.equal(item.workflowId,id);assert.equal((await app.store.list('actions')).length,0);
    const before=await readFile(app.store.file('workflows',id),'utf8');await app.dayPlanning.briefing();assert.equal(await readFile(app.store.file('workflows',id),'utf8'),before);report.question=w.question;
    await app.workflows.steer(id,`Use only ${second}. Read its current complete contents and report the exact value. Do not read the other file, change anything or ask again.`,w.revision);answered=true;await app.workflows.control(id,'resume');
   }else if(['completed','paused','needs_help','needs_verification','waiting_input','cancelled'].includes(w.status))break;
  }
  await new Promise(r=>setTimeout(r,500));
 }
 assert(answered);assert.equal(approvals,2);assert.equal(report.workflow.status,'completed',report.workflow.error);assert(report.workflow.operations.some(o=>o.name==='read_system_file'&&o.status==='completed'&&o.result.path===second&&o.result.content==='Second value: pine-793\n'));assert(report.workflow.result.includes('pine-793'));assert.equal((await app.store.list('actions')).length,0);assert.equal(await readFile(first,'utf8'),'First value: ash-248\n');assert.equal(await readFile(second,'utf8'),'Second value: pine-793\n');
 assert.equal((await app.taskWorkflows.attention(d.id)).attention.kind,'completion');assert.equal((await app.vault.tasks()).find(t=>t.id===task.id).done,false);const review=await app.taskWorkflows.preview({id:d.id});await app.taskWorkflows.decide({id:d.id,reviewId:review.review.id,action:'complete',acknowledge:true});assert.equal((await app.taskWorkflows.attention(d.id)).attention,null);report.approvals=approvals;report.ok=true;
}catch(e){report.error=e.message;console.error(e.stack);process.exitCode=1;}
finally{if(app){await app.workflows.close();app.calendar.close();app.recurring.stop();app.backups.stop();app.actions.stopAll();}report.seconds=Math.round((Date.now()-started)/1000);await writeFile(new URL('../artifacts/planner-attention-live-results.json',import.meta.url),JSON.stringify(report,null,2));await rm(dir,{recursive:true,force:true});console.log(JSON.stringify({ok:report.ok,seconds:report.seconds,error:report.error}));}
