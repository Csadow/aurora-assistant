// Two bounded next-tool trials, not an end-to-end autonomous success benchmark.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';
import {sha,atomic} from '../src/vault.mjs';
import {recordRepairPlan} from '../src/workflow-repair-plan.mjs';
import {focusedRequest,focusedProjectPrompt} from '../src/workflow-project-context.mjs';
import {characterIdentity} from '../src/character.mjs';
const args=process.argv.slice(2);if(args.length>1||args.some(a=>!['--live','--preflight'].includes(a)))throw Error('Use --preflight (default) or --live.');
const live=args.includes('--live'),repo=new URL('../',import.meta.url),dir=await mkdtemp(join(tmpdir(),'aurora-copy-live-')),root=join(dir,'project');await mkdir(root);
const files={'fit.mjs':'export const fit=(width,area)=>Math.max(width,area);\n','package.json':'{"type":"module"}\n','fit.test.mjs':"import test from 'node:test';import assert from 'node:assert/strict';import {fit} from './fit.mjs';test('small',()=>assert.equal(fit(700,1280),700));test('large',()=>assert.equal(fit(460,320),320));\n"};
for(const [p,c] of Object.entries(files))await writeFile(join(root,p),c);
const stub={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[]}),chat:async()=>{throw Error('Only explicit external trial calls are allowed');}};
let app,locked=false;const lock=new URL('artifacts/repair-diagnosis.lock',repo);
try{
  app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),desktopProfile:join(dir,'profile'),projects:[],embedding:'',ollamaClient:stub,workflowOptions:{pollMs:100000}});clearInterval(app.workflows.timer);
  const notePath='20 Projects/Copy trial.md';await app.vault.save(notePath,'# Copy trial\n',null);
  const project=await app.projectWorkspaces.save({name:'Copy trial',notePath,folders:[root],checks:[{name:'Window tests',program:'node',args:['--test','fit.test.mjs'],cwd:root,outputIncludes:'pass 2'}]});
  const path=join(root,'fit.mjs'),goal='Repair fit.mjs so width 700 in area 1280 stays 700 and width 460 in area 320 becomes 320. Test the exact saved candidate in a temporary copy BEFORE editing the original. Then apply it through a separate approval, run the original saved tests and read the final file. Preserve tests and all other code.';
  const w={id:randomUUID(),version:12,revision:1,goal,scope:root,project,requirements:{files:[{path,finalNewline:'required',lineEndings:'lf'}],commands:project.checks.map(({name,...c})=>c)},created:new Date().toISOString(),status:'running',steps:[{id:'step',title:'Repair and verify width',check:goal,status:'running'}],current:0,operations:[],skills:[],directives:[],calls:0,activeMs:0};
  for(const p of Object.keys(files)){const file=join(root,p);w.operations.push({id:randomUUID(),revision:1,step:'step',name:'read_system_file',arguments:{path:file},status:'completed',result:await app.system.read(file)});}
  const repairOp={id:randomUUID(),revision:1,step:'step',name:'record_repair_plan',status:'started'};w.operations.push(repairOp);repairOp.result=recordRepairPlan(w,{repairs:[{file:path,line:1,before:'Math.max(width,area)',after:'Math.min(width,area)',reason:'Bound each width by the available area.'}]});repairOp.status='completed';
  const repair=repairOp.result.repairs[0].id,style=(await app.assistant.character.prompt()).slice(0,1800);
  const request=()=>focusedRequest(w,{system:characterIdentity+style+'\n'+focusedProjectPrompt+'\n'+app.workflows.skillPrompt(w),history:app.workflows.executionHistory(w),context:app.workflows.context(w),tools:app.workflows.toolsFor(w)});
  if(!live){console.log(JSON.stringify({mode:'preflight',inputBytes:request().inputBytes,executed:false,planned:['before copy approval','after reviewed copy result']}));}
  else{
    await mkdir(new URL('artifacts/',repo),{recursive:true});const h=await open(lock,'wx',0o600);locked=true;await h.writeFile(JSON.stringify({pid:process.pid,script:'test-copy-live'}));await h.close();
    const get=async p=>{const r=await fetch('http://127.0.0.1:4717/api/'+p,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
    const idle=async()=>{assert.equal((await get('embodiment')).phase,'idle');assert(!(await get('workflows')).some(w=>['running','planning','queued'].includes(w.status)));assert(!(await get('actions')).some(a=>a.status==='running'));assert(!(await get('agents')).runs.some(r=>['running','queued'].includes(r.status)));};
    const selected=await get('local-model');assert.equal(selected.model,'qwen3.5:9b');assert(selected.thinking);await idle();
    const client=new Ollama('http://127.0.0.1:11434',selected.model);client.generationOptions=selected.generation;await client.check();w.model=selected.model;w.generation=selected.generation;
    const paths=[...(await readdir(new URL('src/',repo))).filter(p=>p.endsWith('.mjs')).map(p=>'src/'+p),'scripts/test-copy-live.mjs'];
    const source=Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(new URL(p,repo)))])));
    const started=new Date().toISOString(),report={started,model:selected.model,generation:selected.generation,source,cases:[],notice:'Two fixed next-tool snapshots with real local inference. Known source and repair are supplied by the fixture. The harness separately approves the fixed copy action to produce real diagnostic evidence; model output never executes. No personal task, setting, source or cloud request is changed.'};
    const file=new URL('artifacts/test-copy-live-'+started.replaceAll(/[:.]/g,'-')+'.json',repo),save=()=>atomic(file.pathname,JSON.stringify(report,null,2));await save();
    const trial=async(name,expected,args)=>{
      await idle();const packet=request(),at=Date.now(),result={name,expected,expectedArguments:args,input:structuredClone(w),request:packet};
      try{result.reply=await client.chat(packet.messages,packet.tools,AbortSignal.timeout(300000));assert.equal(result.reply.tool_calls?.length,1);const call=result.reply.tool_calls[0].function;result.tool=call.name;assert.equal(call.name,expected);const received=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;assert.deepEqual(received,args);result.passed=true;}
      catch(e){result.passed=false;result.error=e.message;result.metrics=e.metrics;}
      result.seconds=Math.round((Date.now()-at)/1000);report.cases.push(result);await save();console.log(JSON.stringify({name,tool:result.tool,passed:result.passed,seconds:result.seconds,error:result.error}));
    };
    try{
      await trial('before copy approval','propose_test_copy',{repair,check:'C1'});
      const op={id:randomUUID(),revision:1,step:'step',name:'propose_test_copy',arguments:{repair,check:'C1'},status:'started'};w.operations.push(op);await app.workflows.save(w);
      const action=await app.actions.propose('test_copy',op.arguments,null,null,{id:w.id,operation:op.id,step:'step',revision:1});
      assert.equal(action.payload.candidate.content,files['fit.mjs'].replace('Math.max','Math.min'));assert.deepEqual(action.payload.check.args,['--test','fit.test.mjs']);
      op.action=action.id;op.status='waiting_approval';w.status='waiting_approval';await app.workflows.save(w);
      await app.actions.decide(action.id,'approve',action.digest);while(app.actions.running.has(action.id))await new Promise(r=>setTimeout(r,25));
      await app.workflows.reconcile(w);report.fixtureCopy=await app.store.get('actions',action.id);assert.deepEqual(report.fixtureCopy.result.runs.map(r=>r.passed),[false,true]);await save();
      await trial('after reviewed copy result','propose_repair',{repair});
    }catch(e){report.error=e.message;}
    finally{
      report.changedSources=[];for(const [p,h] of Object.entries(source))if(sha(await readFile(new URL(p,repo)))!==h)report.changedSources.push(p);
      const after=await get('local-model');report.modelSettingsUnchanged=after.model===selected.model&&after.thinking===selected.thinking&&JSON.stringify(after.generation)===JSON.stringify(selected.generation);
      report.originalSourceUnchanged=await readFile(path,'utf8')===files['fit.mjs'];report.finished=new Date().toISOString();await save();
      console.log(JSON.stringify({report:file.pathname,passed:report.cases.filter(c=>c.passed).length,total:2,changedSources:report.changedSources}));
      if(report.error||report.changedSources.length||!report.modelSettingsUnchanged||!report.originalSourceUnchanged||report.cases.length!==2||report.cases.some(c=>!c.passed))process.exitCode=1;
    }
  }
}finally{if(app){await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,25));app.server.emit('close');}if(locked)await rm(lock);await rm(dir,{recursive:true,force:true});}
