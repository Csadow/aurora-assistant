// Real-model follow-up attached to a disposable planner task. The parent
// reports an old value; only a fresh read in the new attempt can verify it.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';
const dir=await mkdtemp(join(tmpdir(),'aurora-planner-attempt-live-')),data=join(dir,'data'),workspace=join(dir,'workspace'),file=join(workspace,'result.txt');
const report={date:new Date().toISOString(),ok:false},started=Date.now();let app;
const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
try{
 const model=await get('local-model');assert.equal((await get('embodiment')).phase,'idle');assert(!(await get('workflows')).some(w=>['running','planning','queued'].includes(w.status)));assert(!(await get('actions')).some(a=>a.status==='running'));assert(!(await get('agents')).runs.some(a=>['running','queued'].includes(a.status)));
 report.model=model.model;report.generation=model.generation;
 await mkdir(data);await mkdir(workspace);await writeFile(file,'Current value: birch-619\n');await writeFile(join(data,'models.json'),JSON.stringify({model:model.model,thinking:model.thinking}));
 app=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),embedding:'',projects:[],ollamaClient:new Ollama('http://127.0.0.1:11434',model.model)});
 const allowed=app.system.allowed.bind(app.system);app.system.allowed=path=>{assert(path===workspace||path.startsWith(workspace+'/'),'Only the disposable workspace may be accessed');return allowed(path);};
 app.actions.propose=async()=>{throw Error('This read-only follow-up trial cannot create an action.');};
 await app.vault.addTask('Verify the remaining saved result',{planDate:'2026-10-26',startTime:'10:00',duration:30});const task=(await app.vault.tasks()).find(t=>t.text==='Verify the remaining saved result'),link=await app.taskWorkflows.draft({task});
 const at=new Date().toISOString(),source={id:link.childId,version:19,revision:1,goal:'Save and verify a result file',scope:workspace,status:'needs_help',question:'Does the saved value still match?',created:at,updated:at,model:model.model,skills:[],calls:48,activeMs:0,current:1,operations:[],steps:[{id:randomUUID(),title:'Initial file preparation',status:'completed',summary:'An earlier report said the value was cedar-204.',evidence:[]},{id:randomUUID(),title:'Inspect the current saved value',status:'planned',check:'Read the current file'}],requirements:{files:[{path:file,finalNewline:'required',lineEndings:'lf',requiredText:['Current value: birch-619']}],commands:[]}};
 await app.store.put('workflows',source);await app.store.put('task-workflows',{...link,status:'linked'});const parent=await readFile(app.store.file('workflows',source.id),'utf8'),choices=await app.workflows.followups.choices(source.id),d=await app.workflows.followups.preview({sourceId:source.id,sourceFingerprint:choices.fingerprint,selected:['check:0','question']});
 const w=await app.workflows.followups.start({id:d.id,revision:d.revision,goal:`Read only ${file} and report its current complete value. It may differ from the historical summary. Do not edit anything, run commands or use applications. Verify the saved file requirements from the new read and finish.`,scope:`Read only ${workspace}.`,requirements:d.requirements,acknowledge:true});let reviewed=false,last='';
 while(Date.now()-started<360000){
  const current=await app.store.get('workflows',w.id);report.task=current;
  const status=JSON.stringify([current.status,current.calls,current.operations.at(-1)?.name]);if(status!==last){console.log(status);last=status;}
  if(current.status==='plan_review'&&!app.workflows.running.has(w.id)){assert.deepEqual(current.operations,[]);const preview=await app.taskWorkflows.previewAttachment({id:link.id,revision:link.revision,targetId:w.id});assert.equal(preview.childId,source.id);const attached=await app.taskWorkflows.decideAttachment({id:link.id,reviewId:preview.attachment.id,action:'attach',acknowledge:true});assert.equal(attached.childId,w.id);assert.equal(attached.attempts.length,2);assert.equal((await app.vault.tasks()).find(t=>t.id===task.id).done,false);report.attachedWithoutExecution=true;await app.workflows.control(w.id,'approve_plan','',current.revision);reviewed=true;}
  if(!app.workflows.running.has(w.id)&&['completed','paused','needs_help','needs_verification','waiting_input','cancelled'].includes(current.status))break;
  await new Promise(r=>setTimeout(r,500));
 }
 assert(reviewed);assert.equal(report.task.status,'completed');assert(report.task.operations.some(o=>o.name==='read_system_file'&&o.status==='completed'&&o.result.content==='Current value: birch-619\n'));assert(report.task.result.includes('birch-619'));assert(!report.task.operations.some(o=>o.action));assert.equal((await app.store.list('actions')).length,0);assert.equal(await readFile(file,'utf8'),'Current value: birch-619\n');assert.equal(await readFile(app.store.file('workflows',source.id),'utf8'),parent);assert.equal((await app.vault.tasks()).find(t=>t.id===task.id).done,false);const completion=await app.taskWorkflows.preview({id:link.id});assert.equal(completion.review.workflowId,w.id);assert.equal(completion.review.linkRevision,2);await app.taskWorkflows.decide({id:link.id,reviewId:completion.review.id,action:'complete',acknowledge:true});const after=(await app.vault.tasks()).find(t=>t.id===task.id);assert(after.done);assert.deepEqual({...after,done:false,revision:task.revision},task);report.currentAttemptCompletedOnlyAfterReview=true;report.ok=true;
}catch(e){report.error=e.message;console.error(e.stack);process.exitCode=1;}
finally{if(app){await app.workflows.close();app.calendar.close();app.recurring.stop();app.backups.stop();app.actions.stopAll();}report.seconds=Math.round((Date.now()-started)/1000);await writeFile(new URL('../artifacts/planner-attempts-live-results.json',import.meta.url),JSON.stringify(report,null,2));await rm(dir,{recursive:true,force:true});console.log(JSON.stringify({ok:report.ok,seconds:report.seconds,error:report.error}));}
