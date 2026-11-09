import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';
import {beforeCheckpoint} from '../src/workflow-checkpoint.mjs';
import {evidenceHandle,missingOutcomes} from '../src/workflow-evidence.mjs';
import {requirementStatus} from '../src/workflow-requirements.mjs';
import {sha} from '../src/vault.mjs';

const call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});
const until=async(fn,label,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,80));}throw Error('Timed out: '+label);};
export async function smoke({win,backend,desktopComputer,computerLink}){
 const live=process.env.AURORA_RECOVERY_LIVE==='1',selected=JSON.parse(process.env.AURORA_RECOVERY_MODEL),title='Aurora research fixture',content=title+'\n';
 const report={ok:false,protocol:'native-laptop-recovery-v2',live,model:selected,cases:[],notice:'Disposable browser, files and editor. Pending-review case restarts the backend. Lost-reply case deliberately disconnects after the editor launch and supplies a separately labelled simulated user observation before resume; it is assisted recovery, not autonomous uncertainty resolution.'};
 const save=()=>writeFile(process.env.AURORA_TEST_REPORT,JSON.stringify(report,null,2));
 const fixture=http.createServer((_q,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>${title}</title><h1>${title}</h1><p>A disposable reference page for saving its title.</p>`);});
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+fixture.address().port+'/';desktopComputer.browser.testOrigin=new URL(url).origin;
 const dir=join(backend.config.data,'..','fixture');await mkdir(dir,{recursive:true});
 const realHandle=desktopComputer.handle.bind(desktopComputer);let target,activeRun,id;
 const windows=async()=>({...(await realHandle('execute',{operation:'windows'},new AbortController().signal)),});
 const fixtureWindows=async()=>((await windows()).windows||[]).filter(w=>w.title.includes(basename(target)));
 desktopComputer.handle=async(method,input,signal)=>{
  const permitted=input.operation==='open_url'?input.url===url:input.operation==='open_path'?input.path===target:['browser_read','windows'].includes(input.operation);
  assert(permitted,'Unapproved fixture computer operation: '+input.operation);
  const result=await realHandle(method,input,signal);
  if(method==='execute'){
   activeRun.effects??=[];activeRun.effects.push({operation:input.operation});
   if(input.operation==='open_path'&&activeRun.id==='lost'&&!activeRun.disconnected){
    activeRun.disconnected=true;computerLink.stop();backend.computer.stop();
   }
   if(input.operation==='windows')return {...result,windows:result.windows.filter(w=>w.title.includes(basename(target)))};
  }
  return result;
 };
 const scripted=async()=>{
  const w=await backend.store.get('workflows',id),done=name=>w.operations.some(o=>o.status==='completed'&&o.name==='computer_action'&&o.arguments.operation===name),fresh=(name,operation)=>w.operations.findLast(o=>o.status==='completed'&&o.name===name&&(!operation||o.arguments?.operation===operation)&&!beforeCheckpoint(w,o));
  if(!done('open_url'))return call('computer_action',{operation:'open_url',url,reason:'Read fixture source'});
  const browser=w.operations.findLast(o=>o.status==='completed'&&o.name==='computer_action'&&['browser_read','open_url'].includes(o.arguments.operation)&&!beforeCheckpoint(w,o));
  if(!browser)return call('computer_action',{operation:'browser_read',reason:'Refresh after interruption'});
  const needs=missingOutcomes(w);if(needs.some(x=>x.group==='browser'))return call('verify_outcome',{evidence:evidenceHandle(w,browser.id),kind:'browser_title',expected:browser.result.title});
  if(!w.operations.some(o=>o.expected))return call('propose_file_edit',{path:target,content:browser.result.title+'\n',reason:'Save the actual observed title'});
  if(!fresh('read_system_file'))return call('read_system_file',{path:target});
  if(!done('open_path')&&!activeRun.disconnected)return call('computer_action',{operation:'open_path',path:target,reason:'Open the saved file'});
  const observation=fresh('computer_action','windows');if(!observation)return call('computer_action',{operation:'windows',reason:'Check existing editor, without reopening'});
  if(needs.some(x=>x.group==='window'))return call('verify_outcome',{evidence:evidenceHandle(w,observation.id),kind:'window_title',expected:basename(target)});
  if(requirementStatus(w).some(s=>s.kind==='browser'&&!s.passed))return call('computer_action',{operation:'browser_read',reason:'Check the saved page after the editor launch'});
  return call('finish_step',{summary:'Observed title saved, read back and confirmed in the existing editor.',evidence:[evidenceHandle(w,observation.id),evidenceHandle(w,fresh('read_system_file').id)]});
 };
 const configure=async()=>{
  backend.memory.model='';const model=new Ollama('http://127.0.0.1:11434',selected.model),original=backend.assistant.ollama;
  original.status=async()=>({online:true,models:[{name:selected.model}]});original.check=async()=>{};
  await backend.models.save({model:selected.model,thinking:selected.thinking});assert.deepEqual(original.generationOptions,selected.generation);
  original.chat=async(...args)=>{
   if(!live&&args[4]?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Observe, save and open the source title',check:'Verify the current browser, saved file and visible editor.'}]})};
   if(!live)return scripted();
   const request={messages:args[0],tools:args[1],options:args[4],at:new Date().toISOString()};activeRun.calls.push(request);await save();model.generationOptions=original.generationOptions;
   try{return request.reply=await model.chat(...args);}catch(e){request.error=e.message;throw e;}finally{await save();}
  };
  const allowed=backend.system.allowed.bind(backend.system);backend.system.allowed=path=>{assert(path===dir||path.startsWith(dir+'/'),'Disposable files only');return allowed(path);};
  const propose=backend.actions.propose.bind(backend.actions);backend.actions.propose=async(kind,input,...rest)=>{
   // Scope restrictions protect the disposable workspace. The private expected
   // bytes are checked only by the outer approval loop, never sent as tool error
   // feedback that could coach the model toward the reference answer.
   assert(['write','computer'].includes(kind),'Commands/cloud are outside this fixture');if(kind==='write')assert.equal(input.path,target);return propose(kind,input,...rest);
  };
 };
 const restart=async()=>{
  await backend.workflows.control(id,'pause');const before=await backend.workflows.read(id),actions=await backend.store.list('actions'),config=backend.config,port=backend.server.address().port;
  computerLink.stop();await backend.workflows.close();backend.server.closeAllConnections();await new Promise(r=>backend.server.close(r));
  backend=await createApp({...config,embedding:'',projects:[],ollamaClient:{model:selected.model,status:async()=>({online:true,models:[{name:selected.model}]}),check:async()=>{},chat:async()=>{throw Error('Not configured');}}});await configure();
  await new Promise(r=>backend.server.listen(port,'127.0.0.1',r));await computerLink.start();
  await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload();});
  await until(()=>win.webContents.executeJavaScript('document.body.dataset.ready==="true"'),'reloaded workspace');
  const after=await backend.workflows.read(id);assert.equal(after.status,before.status);assert.equal(after.calls,before.calls);assert.deepEqual(after.requirements,before.requirements);assert.deepEqual(after.operations,before.operations);assert.deepEqual(await backend.store.list('actions'),actions);assert.equal(after.projectRecovery.kind,'desktop');
  activeRun.restart={before,after,kind:'new backend instance on same port; native desktop retained'};await save();
  win.webContents.send('aster:command',{type:'workspace',view:'workflows',workflow:id});
  await until(()=>win.webContents.executeJavaScript('!!document.querySelector("[data-desktop-checkpoint]")'),'native checkpoint review');
  assert(await win.webContents.executeJavaScript('document.querySelector("[data-desktop-checkpoint]").textContent.includes("Historical")'));activeRun.checkpointVisible=true;
 };
 try{
  await configure();
  for(const name of ['pending','lost'].filter(x=>!process.env.AURORA_RECOVERY_CASE||x===process.env.AURORA_RECOVERY_CASE)){
   target=join(dir,'aurora-'+name+'-'+process.pid+'.txt');activeRun={id:name,calls:[],approvals:[],ok:false,started:new Date().toISOString()};report.cases.push(activeRun);const start=Date.now();let previous='';
   try{
    const w=await backend.workflows.start({goal:`Read ${url} in Aurora Browser and verify its actual title. Save that observed title followed by exactly one LF to ${target}. Read the saved file, open it in the default application, list windows and verify that its filename is visible before finishing. If interrupted, preserve completed effects; inspect the current browser, file and windows. Do not repeat a saved write or reopen an already opened document.`,scope:`Only ${target} and ${url}. No commands, cloud requests, messages or keyboard input.`,requirements:{files:[{path:target,lineEndings:'lf',finalNewline:'required'}],commands:[],browser:{url,title},window:{title:basename(target),app:'aurora-document'}}});id=w.id;
    while(Date.now()-start<(live?720000:60000)){
     const state=await backend.workflows.read(id);activeRun.record=state;const progress=JSON.stringify([state.status,state.calls,state.operations.at(-1)?.name]);if(progress!==previous){console.log(name+': '+progress);previous=progress;await save();}
     if(state.status==='plan_review'&&!backend.workflows.running.has(id)){await backend.workflows.control(id,'approve_plan','',state.revision);continue;}
     if(state.status==='needs_verification'&&!backend.workflows.running.has(id)&&name==='lost'&&!activeRun.restarted){
      assert(activeRun.disconnected,'Unexpected uncertain action');await until(()=>!computerLink.running.size,'disconnected request settles');await until(async()=>(await fixtureWindows()).length===1,'editor really opened');
      await restart();activeRun.restarted=true;await assert.rejects(backend.workflows.control(id,'resume'),/uncertain result/);
      const observation=`I checked ${basename(target)}: the file is saved and already open in its editor. Do not rewrite or reopen it; verify the current browser, file and window.`;
      activeRun.assistance={kind:'simulated user observation after checking actual fixture window and bytes',observation};assert.equal(await readFile(target,'utf8'),content);await backend.workflows.control(id,'resolve',observation);await backend.workflows.control(id,'resume');continue;
     }
     if(['completed','paused','needs_verification','needs_help','waiting_input','cancelled'].includes(state.status)&&!backend.workflows.running.has(id))break;
     for(const action of await backend.store.list('actions'))if(action.workflow?.id===id&&action.kind==='write'&&action.status==='pending'){
      assert.equal(action.payload.path,target);assert.equal(action.payload.content,content);
      if(name==='pending'&&!activeRun.restarted){await restart();activeRun.restarted=true;await assert.rejects(backend.actions.decide(action.id,'approve',action.digest),/Resume/);await backend.workflows.control(id,'resume');}
      await backend.actions.decide(action.id,'approve',action.digest);activeRun.approvals.push(action.id);
     }
     await new Promise(r=>setTimeout(r,100));
    }
    const done=await backend.workflows.read(id);activeRun.record=done;assert.equal(done.status,'completed',done.error||done.question||'Task deadline reached');assert(activeRun.restarted);assert.equal(await readFile(target,'utf8'),content);assert(done.requirementChecks.every(c=>c.passed));assert.deepEqual(missingOutcomes(done),[]);assert.equal(done.completionReview.mode,'recorded');assert(done.completionReview.checks.every(c=>c.passed));assert.deepEqual(done.completionReview.checks.map(c=>c.kind),['file','browser','window']);for(const c of done.completionReview.checks){const ref=c.references.find(r=>['Observation','Readback'].includes(r.role));assert(ref&&done.operations.some(o=>o.id===ref.id&&!beforeCheckpoint(done,o)));}activeRun.completionReceipt=done.completionReview;
    assert.equal(activeRun.approvals.length,1);assert.equal(activeRun.effects.filter(e=>e.operation==='open_url').length,1);assert.equal(activeRun.effects.filter(e=>e.operation==='open_path').length,1);assert((await fixtureWindows()).length===1);
    assert(done.operations.some(o=>o.name==='verify_outcome'&&o.status==='completed'&&o.result.kind==='window_title'&&!beforeCheckpoint(done,o)));assert(done.operations.some(o=>o.name==='verify_outcome'&&o.status==='completed'&&o.result.kind==='browser_title'&&!beforeCheckpoint(done,o)));activeRun.ok=true;activeRun.finalRevision=sha(await readFile(target));
   }catch(e){activeRun.error=e.message;console.error(name+': '+e.message);}
   finally{
    if(id){const w=await backend.workflows.read(id);if(!['completed','cancelled'].includes(w.status))await backend.workflows.control(id,'cancel');activeRun.record=await backend.workflows.read(id);}
    for(const w of await fixtureWindows()){const payload=await realHandle('prepare',{operation:'close_window',windowId:w.id},new AbortController().signal);assert(payload.target.title.includes(basename(target)));await realHandle('execute',payload,new AbortController().signal);await until(async()=>!(await fixtureWindows()).some(x=>x.id===w.id),'close fixture editor');}
    activeRun.seconds=Math.round((Date.now()-start)/1000);await save();id=null;
   }
  }
  report.ok=report.cases.length>0&&report.cases.every(c=>c.ok);await save();
 }finally{
  computerLink.stop();await backend.workflows.close();backend.actions.stopAll();backend.server.closeAllConnections();if(backend.server.listening)await new Promise(r=>backend.server.close(r));await new Promise(r=>fixture.close(r));desktopComputer.handle=realHandle;
 }
}
