import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {sha} from '../src/vault.mjs';
import {recordRepairPlan,repairPlanContext,proposeRepair,checkRepairExpression} from '../src/workflow-repair-plan.mjs';
import {prepareTestCopy,cleanupInterruptedCopy,supportsCopyCheck,bindCopyRequirement,requireTestedCopy,copyOutcome,guardCopyControl,copyReadinessResolved,guardTestCopy} from '../src/workflow-test-copy.mjs';
import {requirementStatus} from '../src/workflow-requirements.mjs';
import {verifyOutcome} from '../src/workflow-evidence.mjs';
import {focusedTools} from '../src/workflow-project-context.mjs';
import {projectProgress} from '../src/workflow-project-progress.mjs';

const until=async fn=>{const end=Date.now()+15000;while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,10));}throw Error('Copy fixture timed out');};
async function reconcileCopy(f,a){await f.app.actions.decide(a.id,'approve',a.digest);await f.done(a);const w=await f.app.store.get('workflows',f.w.id);await f.app.workflows.reconcile(w);await f.app.workflows.save(w);return w;}
async function stageWrite(f,w,content,repair){
  const op={id:randomUUID(),step:'step',revision:w.revision,name:'propose_file_edit',status:'started',...repair?{repair,expected:{path:f.path,revision:sha(content)}}:{}};w.operations.push(op);await f.app.workflows.save(w);
  const a=await f.app.actions.propose('write',{path:f.path,content},null,null,{id:w.id,operation:op.id,step:'step',revision:w.revision});
  op.status='waiting_approval';op.action=a.id;w.status='waiting_approval';await f.app.workflows.save(w);return a;
}
async function fixture(t,{slow=false,after='Math.min(width,area)',gated=false,multi=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'aurora-copy-action-')),root=join(dir,'project'),path=join(root,'fit.mjs');await mkdir(root);
  const content='export const fit=(width,area)=>Math.max(width,area);\n'+(multi?'export const duration=(start,end)=>end-start||1;\n':'');
  const text={
    'fit.mjs':content,'package.json':'{"type":"module"}\n','support.mjs':'export const label="fixture";\n',
    'fit.test.mjs':`import test from 'node:test';import assert from 'node:assert/strict';import {fit${multi?',duration':''}} from './fit.mjs';import {label} from './support.mjs';
test('small width stays small',async()=>{${slow?'await new Promise(r=>setTimeout(r,3000));':''}assert.equal(fit(700,1280),700);assert.equal(label,'fixture');});
test('large width fits area',()=>assert.equal(fit(460,320),320));
${multi?"test('zero duration remains zero',()=>assert.equal(duration(9,9),0));":''}\n`
  };
  for(const [p,c] of Object.entries(text))await writeFile(join(root,p),c);
  const model={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[]}),chat:async()=>{throw Error('This deterministic fixture should not call a model.');}};
  const config={vault:join(dir,'vault'),data:join(dir,'state'),backups:join(dir,'backups'),desktopProfile:join(dir,'profile'),projects:[],embedding:'',ollamaClient:model,workflowOptions:{pollMs:100000}};
  let app=await createApp(config);clearInterval(app.workflows.timer);
  t.after(async()=>{await app.workflows.close();app.server.emit('close');while(app.actions.running.size)await new Promise(r=>setTimeout(r,10));await rm(dir,{recursive:true,force:true});});
  const notePath='20 Projects/Copy fixture.md';await app.vault.save(notePath,'# Copy fixture\n',null);
  const project=await app.projectWorkspaces.save({name:'Copy fixture',notePath,folders:[root],checks:[{name:'Window tests',program:'node',args:['--test','fit.test.mjs'],cwd:root,outputIncludes:multi?'pass 3':'pass 2'}]});
  const w={id:randomUUID(),version:12,revision:1,status:'running',created:new Date().toISOString(),updated:new Date().toISOString(),goal:'Repair width clamping, test the candidate in a copy before applying it, then run the saved checks.',scope:'Only fit.mjs',project,requirements:{files:[{path,lineEndings:'lf',finalNewline:'required'}],commands:project.checks.map(({name,...c})=>c)},model:app.assistant.ollama.model,generation:{...app.assistant.ollama.generationOptions},steps:[{id:'step',status:'running',title:'Repair',check:'Saved tests and readback'}],current:0,operations:[],calls:0,activeMs:0,skills:[],directives:[]};
  if(gated){w.version=13;w.copyBeforeEdit=bindCopyRequirement('Window tests',project,w.requirements);}
  for(const p of Object.keys(text)){const target=join(root,p);w.operations.push({id:randomUUID(),revision:1,name:'read_system_file',status:'completed',arguments:{path:target},result:await app.system.read(target)});}
  const op={id:randomUUID(),name:'record_repair_plan',revision:1,status:'started'};w.operations.push(op);op.result=recordRepairPlan(w,{repairs:[{file:path,line:1,before:'Math.max(width,area)',after,reason:'Keep both widths within the requested area.'},...multi?[{file:path,line:2,before:'end-start||1',after:'end-start',reason:'Keep zero duration at zero.'}]:[]]});op.status='completed';await app.workflows.save(w);
  const args={repair:op.result.repairs[0].id,check:'C1'};
  const secondArgs=multi?{repair:op.result.repairs[1].id,check:'C1'}:null;
  const stage=async(selected=args)=>{
    const state=await app.store.get('workflows',w.id),operation={id:randomUUID(),step:'step',revision:state.revision,name:'propose_test_copy',arguments:selected,status:'started'};
    state.operations.push(operation);await app.workflows.save(state);
    const action=await app.actions.propose('test_copy',selected,null,null,{id:w.id,operation:operation.id,step:'step',revision:state.revision});
    operation.action=action.id;operation.status='waiting_approval';state.status='waiting_approval';await app.workflows.save(state);return action;
  };
  const done=async a=>until(async()=>{const x=await app.store.get('actions',a.id);return !app.actions.running.has(a.id)&&x.status!=='running'?x:null;});
  const restart=async()=>{await app.workflows.close();app.server.emit('close');app=await createApp(config);clearInterval(app.workflows.timer);return app;};
  return {get app(){return app;},w,args,secondArgs,root,path,content,text,stage,done,restart};
}

test('copy preparation shows exact saved command, all observed sources and one diff without execution',async t=>{
  const f=await fixture(t),p=await prepareTestCopy(f.app.workflows,f.w,f.args);
  assert.equal(p.files.length,4);assert.equal(p.candidate.content,f.content.replace('Math.max','Math.min'));assert(p.candidate.patch.diff.includes('Math.min'));
  assert.deepEqual(p.commands.map(c=>c.variant),['baseline','candidate']);assert(p.commands.every(c=>c.args.slice(-3).join(' ')==='/usr/bin/node --test fit.test.mjs'));
  assert.equal(await readFile(f.path,'utf8'),f.content);await assert.rejects(lstat(p.directory),{code:'ENOENT'});
  assert(focusedTools(f.w,[]).some(t=>t.function.name==='propose_test_copy'));
  assert(!focusedTools({...f.w,version:11},[]).some(t=>t.function.name==='propose_test_copy'));
  assert(!supportsCopyCheck({...p.check,args:['--eval','1']}));
});

test('malformed local copy requests explain the saved repair and C-number contract',async t=>{
 const f=await fixture(t),w=f.w;w.version=28;w.engine='local';
 const invalid={check:'C1',before:'old',after:'new',filePath:f.path,reason:'Try this patch'};
 await assert.rejects(prepareTestCopy(f.app.workflows,w,invalid),/First save an observed correction with record_repair_plan.*ONLY its returned repair R-number/);
 assert.equal((await f.app.store.list('actions')).length,0);
 const old={...w,version:27};await assert.rejects(prepareTestCopy(f.app.workflows,old,invalid),/Use repair and check in a new project task/);
});

test('resolved manifest requests leave active history only after a complete fresh read; approval still revalidates source',async t=>{
 const f=await fixture(t,{gated:true}),w=f.w;w.version=14;
 const path=join(f.root,'package.json');w.operations=w.operations.filter(o=>o.result?.path!==path);
 let error;try{await prepareTestCopy(f.app.workflows,w,f.args);}catch(e){error=e;}
 assert.deepEqual(error.copyReadiness.neededReads,[path]);
 const op={id:randomUUID(),name:'propose_test_copy',revision:w.revision,status:'failed',arguments:f.args,result:{error:error.message,copyReadiness:error.copyReadiness}};w.operations.push(op);
 assert.equal(copyReadinessResolved(w,op),false);assert.equal(projectProgress(w).next.arguments.path,path);
 const source=await f.app.system.read(path),read={id:randomUUID(),revision:w.revision,name:'read_system_file',arguments:{path},status:'completed',result:source};w.operations.push(read);
 assert.equal(copyReadinessResolved(w,op),true);assert.equal(projectProgress(w).next.tool,'propose_test_copy');
 const journal=JSON.stringify(w);assert(!f.app.workflows.executionHistory(w).some(m=>m.tool_name==='propose_test_copy'));assert.equal(JSON.stringify(w),journal);
 assert.equal((await f.app.store.list('actions')).length,0,'resolving a read request cannot create a test result or approval');
 const payload=await prepareTestCopy(f.app.workflows,w,f.args);assert(payload.files.some(f=>f.path===path));
 for(const patch of [{truncated:true},{offset:1},{revision:'wrong'}]){read.result={...source,...patch};assert.equal(copyReadinessResolved(w,op),false);}
 read.result=source;op.action='actual-copy';assert.equal(copyReadinessResolved(w,op),false,'executed results never disappear as resolved reads');delete op.action;
 w.operations.push({id:randomUUID(),action:'command',name:'propose_command',status:'completed'});assert.equal(copyReadinessResolved(w,op),false,'commands invalidate prior observations');w.operations.pop();
 await writeFile(path,'{"type":"module","changed":true}\n');await assert.rejects(guardTestCopy(f.app.workflows,w,payload),/changed/);
});

test('unrelated failed probes do not block an observed copy snapshot',async t=>{
  const f=await fixture(t),path=join(f.root,'checks','C1.mjs');
  f.w.version=13;
  f.w.operations.push({id:randomUUID(),revision:1,name:'read_system_file',status:'failed',arguments:{path},result:{error:'Path not found.'}});
  const payload=await prepareTestCopy(f.app.workflows,f.w,f.args);
  assert.equal(payload.files.length,4);assert(!payload.files.some(f=>f.path===path));
  assert.equal((await f.app.store.list('actions')).length,0);assert.equal(await readFile(f.path,'utf8'),f.content);
});

test('failed required dependency observations request inspection or help without creating a copy',async t=>{
  const f=await fixture(t),path=join(f.root,'missing.mjs');
  f.w.version=13;
  const testPath=join(f.root,'fit.test.mjs'),testSource=f.text['fit.test.mjs']+"import './missing.mjs';\n";
  await writeFile(testPath,testSource);
  f.w.operations.push({id:randomUUID(),revision:1,name:'read_system_file',status:'completed',arguments:{path:testPath},result:await f.app.system.read(testPath)});
  f.w.operations.push({id:randomUUID(),revision:1,name:'read_system_file',status:'failed',arguments:{path},result:{error:'Path not found.'}});
  await assert.rejects(prepareTestCopy(f.app.workflows,f.w,f.args),e=>e.message.includes(path)&&e.message.includes('request_help')&&e.copyReadiness.missing.includes(path));
  assert.equal((await f.app.store.list('actions')).length,0);assert.equal(await readFile(f.path,'utf8'),f.content);
});

test('new local copy preparation names bounded transitive reads and manifests at once but copies only observed files',async t=>{
  const f=await fixture(t),support=join(f.root,'support.mjs'),nested=join(f.root,'nested.mjs'),leaf=join(f.root,'leaf.mjs'),manifest=join(f.root,'package.json');
  f.w.version=22;f.w.engine='ollama';
  await writeFile(support,"import './nested.mjs'; export const label='fixture';\n");
  await writeFile(nested,"import './leaf.mjs'; export const nested=true;\n");
  await writeFile(leaf,'export const leaf=true;\n');
  f.w.operations=f.w.operations.filter(o=>![support,manifest].includes(o.result?.path));
  const old=structuredClone(f.w);old.version=21;
  await assert.rejects(prepareTestCopy(f.app.workflows,old,f.args),e=>e.copyReadiness?.neededReads?.length===1&&e.copyReadiness.neededReads[0]===support);
  const cloud=structuredClone(f.w);cloud.engine='chatgpt';
  await assert.rejects(prepareTestCopy(f.app.workflows,cloud,f.args),e=>e.copyReadiness?.neededReads?.length===1&&e.copyReadiness.neededReads[0]===support);
  let readiness;
  await assert.rejects(prepareTestCopy(f.app.workflows,f.w,f.args),e=>{
    readiness=e.copyReadiness;assert.deepEqual(readiness.neededReads,[leaf,nested,support,manifest].sort());assert.deepEqual(readiness.missing,[]);return true;
  });
  assert.equal((await f.app.store.list('actions')).length,0);
  const failed={id:randomUUID(),name:'propose_test_copy',revision:1,status:'failed',arguments:f.args,result:{copyReadiness:readiness}};f.w.operations.push(failed);
  const readTool={function:{name:'read_system_file',description:'Fixture',parameters:{type:'object',properties:{path:{type:'string'}}}}};
  assert.deepEqual(projectProgress(f.w).copyNeededReads,readiness.neededReads);
  assert.deepEqual(focusedTools(f.w,[readTool]).find(t=>t.function.name==='read_system_file').function.parameters.properties.path.enum,readiness.neededReads);
  assert(!focusedTools(f.w,[readTool]).some(t=>t.function.name==='propose_test_copy'));
  for(const path of [support,nested,leaf,manifest]){
    f.w.operations.push({id:randomUUID(),revision:1,name:'read_system_file',status:'completed',arguments:{path},result:await f.app.system.read(path)});
    assert(!projectProgress(f.w).copyNeededReads?.includes(path));
  }
  assert.equal(copyReadinessResolved(f.w,failed),true);
  const payload=await prepareTestCopy(f.app.workflows,f.w,f.args);
  assert(payload.files.some(x=>x.path===leaf));assert.equal(payload.dependencies.neededReads.length,0);
});

test('a failed latest read cannot reuse an older required file or imported dependency',async t=>{
  const f=await fixture(t);f.w.version=14;
  for(const path of [join(f.root,'fit.test.mjs'),join(f.root,'support.mjs')]){
    const w=structuredClone(f.w);
    w.operations.push({id:randomUUID(),revision:1,name:'read_system_file',status:'failed',arguments:{path},result:{error:'Probe failed.'}});
    await assert.rejects(prepareTestCopy(f.app.workflows,w,f.args),e=>e.copyReadiness?.neededReads?.includes(path));
  }
  assert.equal((await f.app.store.list('actions')).length,0);
});

test('renaming an unchanged repair cannot bypass duplicate-copy rejection; changed dependencies can be retested',async t=>{
  const f=await fixture(t),first=await prepareTestCopy(f.app.workflows,f.w,f.args);
  f.w.operations.push({id:randomUUID(),revision:1,name:'propose_test_copy',arguments:f.args,status:'completed',result:{kind:'test_copy',fingerprint:first.fingerprint}});
  const op={id:randomUUID(),revision:1,name:'record_repair_plan',status:'started'};f.w.operations.push(op);
  op.result=recordRepairPlan(f.w,{repairs:[{file:f.path,line:1,before:'Math.max(width,area)',after:'Math.min(width,area)',reason:'Same correction saved again.'}]});op.status='completed';
  const args={repair:op.result.repairs[0].id,check:'C1'};assert.notEqual(args.repair,f.args.repair);
  await assert.rejects(prepareTestCopy(f.app.workflows,f.w,args),/already have a copy-test result/);
  const receipt=f.w.operations.find(o=>o.name==='propose_test_copy');receipt.action=randomUUID();receipt.result.fingerprint=sha(JSON.stringify({snapshot:first.snapshot,candidate:sha(first.candidate.content),check:first.check,repair:first.repair}));
  await f.app.store.put('actions',{id:receipt.action,kind:'test_copy',status:'completed',created:new Date().toISOString(),payload:first,workflow:{id:f.w.id,operation:receipt.id}});
  await assert.rejects(prepareTestCopy(f.app.workflows,f.w,args),/already have a copy-test result/,'legacy receipts also prevent renamed repeats');
  const path=join(f.root,'support.mjs');await writeFile(path,f.text['support.mjs']+'// changed dependency\n');
  f.w.operations.push({id:randomUUID(),revision:1,name:'read_system_file',status:'completed',arguments:{path},result:await f.app.system.read(path)});
  const next=await prepareTestCopy(f.app.workflows,f.w,args);assert.notEqual(next.fingerprint,first.fingerprint);assert.equal(next.repair.id,args.repair);assert.equal(next.candidate.content,first.candidate.content);
});

test('unsupported commands, direct action requests, changed packets, unread dependencies and redacted sources fail closed',async t=>{
  const f=await fixture(t),service=f.app.workflows;
  await assert.rejects(f.app.actions.propose('test_copy',f.args),/workflow/);
  for(const input of [{...f.args,program:'sh'},{...f.args,files:[]},{...f.args,repair:'R99'},{...f.args,check:'C9'}])await assert.rejects(prepareTestCopy(service,f.w,input));
  await assert.rejects(prepareTestCopy(service,{...f.w,version:11},f.args),/new project/);
  const changed=structuredClone(f.w);changed.requirements.commands[0].args=['--version'];await assert.rejects(prepareTestCopy(service,changed,f.args),/saved Node/);
  const unread=structuredClone(f.w);unread.operations=unread.operations.filter(o=>!o.result?.path?.endsWith('fit.test.mjs'));await assert.rejects(prepareTestCopy(service,unread,f.args),/Read this required/);
  const partial=structuredClone(f.w);partial.operations.find(o=>o.result?.path?.endsWith('support.mjs')).result.truncated=true;await assert.rejects(prepareTestCopy(service,partial,f.args),/completely again/);
  await writeFile(join(f.root,'support.mjs'),'const password = "fixture credential";\n');await assert.rejects(prepareTestCopy(service,f.w,f.args),/unredacted/);
});

test('every included dependency and absent package manifest is rechecked before approval',async t=>{
  const f=await fixture(t),a=await f.stage();await writeFile(join(f.root,'support.mjs'),'export const label="changed";\n');
  await assert.rejects(f.app.actions.decide(a.id,'approve',a.digest),/source changed/i);await assert.rejects(lstat(a.payload.directory),{code:'ENOENT'});
  await writeFile(join(f.root,'support.mjs'),f.text['support.mjs']);
  await assert.rejects(f.app.actions.decide(a.id,'approve','wrong'),/action changed/i);
  const original=await f.app.store.get('actions',a.id);original.payload.candidate.content+='// tamper\n';await f.app.store.put('actions',original);
  await assert.rejects(f.app.actions.decide(a.id,'approve',a.digest),/action changed/i);
  const b=await fixture(t);await rm(join(b.root,'package.json'));b.w.operations=b.w.operations.filter(o=>!o.result?.path?.endsWith('package.json'));await b.app.workflows.save(b.w);const pending=await b.stage();
  await writeFile(join(b.root,'package.json'),'{}');await assert.rejects(b.app.actions.decide(pending.id,'approve',pending.digest),/manifest appeared/);
});

test('approval runs actual baseline/candidate tests, preserves original bytes and grants no completion or apply permission',async t=>{
  const f=await fixture(t),a=await f.stage();await f.app.actions.decide(a.id,'approve',a.digest);const done=await f.done(a);
  assert.equal(done.status,'completed');assert.equal(done.result.runs[0].passed,false);assert.equal(done.result.runs[1].passed,true);assert.equal(done.result.runs[1].code,0);assert(done.result.cleanedUp);assert(done.result.originalSourcesCurrent);
  assert.equal(await readFile(f.path,'utf8'),f.content);await assert.rejects(lstat(a.payload.directory),{code:'ENOENT'});
  const w=await f.app.store.get('workflows',f.w.id);await f.app.workflows.reconcile(w);await f.app.workflows.save(w);
  assert(!requirementStatus(w).find(r=>r.kind==='command').passed);assert(!f.app.workflows.completionRefs(w).items.enum.includes('E'+w.operations.length));
  assert.throws(()=>verifyOutcome(w,{evidence:w.operations.at(-1).id,kind:'command_output',expected:'pass 2'}),/completed command/);
  assert.equal(repairPlanContext(w).repairs[0].state,'remaining');assert(proposeRepair(w,{repair:f.args.repair}));
  await assert.rejects(prepareTestCopy(f.app.workflows,w,f.args),/already have/);
  await assert.rejects(f.app.actions.decide(a.id,'approve',a.digest),/already/);
});

test('a failing candidate keeps the actual assertion output without marking the original check passed',async t=>{
  const f=await fixture(t,{after:'area'}),a=await f.stage();await f.app.actions.decide(a.id,'approve',a.digest);const done=await f.done(a);
  assert.equal(done.status,'completed','the diagnostic action finished, but its candidate did not pass');
  assert(done.result.runs.every(r=>!r.passed));assert.match(done.result.runs[1].content,/AssertionError|ERR_ASSERTION/);assert.equal(await readFile(f.path,'utf8'),f.content);
});

test('denial, expiration, paused access and legacy tasks cannot execute a copy',async t=>{
  const f=await fixture(t),a=await f.stage();await f.app.settings.save({systemEnabled:false});await assert.rejects(f.app.actions.decide(a.id,'approve',a.digest),/paused/);await f.app.settings.save({systemEnabled:true});
  a.expires='2000-01-01';await f.app.store.put('actions',a);await assert.rejects(f.app.actions.decide(a.id,'approve',a.digest),/expired/);
  await f.app.actions.decide(a.id,'dismiss');assert.equal((await f.done(a)).status,'dismissed');await assert.rejects(lstat(a.payload.directory),{code:'ENOENT'});
});

test('stopping during a copy test retains partial evidence, removes copies and never applies or retries',async t=>{
  const f=await fixture(t,{slow:true}),a=await f.stage();await f.app.actions.decide(a.id,'approve',a.digest);
  await until(()=>lstat(join(a.payload.directory,'baseline','fit.test.mjs')).then(()=>true,()=>false));f.app.actions.stop(a.id);const done=await f.done(a);
  assert.equal(done.status,'stopped');assert(done.result.cleanedUp);assert(done.result.runs.length<=1);assert.equal(await readFile(f.path,'utf8'),f.content);await assert.rejects(lstat(a.payload.directory),{code:'ENOENT'});
});

test('pending approval survives restart, requires resume, and still checks every source',async t=>{
  const f=await fixture(t),a=await f.stage();await f.restart();assert.equal((await f.app.store.get('actions',a.id)).status,'pending');
  await assert.rejects(f.app.actions.decide(a.id,'approve',a.digest),/Resume/);await f.app.workflows.control(f.w.id,'resume');
  await f.app.actions.decide(a.id,'approve',a.digest);assert.equal((await f.done(a)).status,'completed');assert.equal(await readFile(f.path,'utf8'),f.content);
});

test('interrupted action keeps partial receipts after restart and cleans only a verified owned directory',async t=>{
  const f=await fixture(t),a=await f.stage();await mkdir(a.payload.directory,{mode:0o700});await writeFile(join(a.payload.directory,'.aurora-copy-owner'),a.payload.fingerprint);
  a.status='running';a.result={kind:'test_copy',runs:[{variant:'baseline',code:1,passed:false,content:'retained assertion failure'}]};await f.app.store.put('actions',a);await f.restart();
  const restored=await f.app.store.get('actions',a.id);assert.equal(restored.status,'interrupted');assert.equal(restored.result.runs[0].content,'retained assertion failure');assert(restored.result.cleanedUp);assert.equal((await f.app.workflows.read(f.w.id)).status,'needs_verification');
  await assert.rejects(f.app.actions.decide(a.id,'approve',a.digest),/already/);await assert.rejects(lstat(a.payload.directory),{code:'ENOENT'});
  const unowned='/tmp/aurora-task-copy-'+randomUUID();await mkdir(unowned,{mode:0o700});t.after(()=>rm(unowned,{recursive:true,force:true}));assert.equal(await cleanupInterruptedCopy({...a.payload,directory:unowned}),false);assert(await lstat(unowned));
});

test('symlinks, outside targets and module manifests cannot silently change copied execution',async t=>{
  const f=await fixture(t);await rm(join(f.root,'support.mjs'));await symlink(join(f.root,'fit.mjs'),join(f.root,'support.mjs'));await assert.rejects(prepareTestCopy(f.app.workflows,f.w,f.args),/symlink|path changed/);
  await rm(join(f.root,'support.mjs'));await writeFile(join(f.root,'support.mjs'),f.text['support.mjs']);
  const omitted=structuredClone(f.w);omitted.operations=omitted.operations.filter(o=>!o.result?.path?.endsWith('package.json'));await assert.rejects(prepareTestCopy(f.app.workflows,omitted,f.args),/package manifest/);
  const outside=structuredClone(f.w);outside.requirements.commands[0].cwd=join(f.root,'nested');outside.project.checks[0].cwd=join(f.root,'nested');await assert.rejects(prepareTestCopy(f.app.workflows,outside,f.args),/inside/);
});

test('workflow tool executes copy review, separate edit approval, original check and final readback in order',async t=>{
  const f=await fixture(t);let n=0;
  f.app.assistant.ollama.chat=async messages=>{
    const c=JSON.parse(messages.at(-1).content),call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});n++;
    if(n===1)return call('propose_test_copy',f.args);
    if(n===2)return call('propose_repair',{repair:f.args.repair});
    if(n===3)return call('propose_check',{check:'C1',reason:'Check the actual edited project.'});
    if(n===4)return call('verify_outcome',{evidence:c.evidenceForCompletion.find(o=>o.name==='propose_command').id,kind:'command_output',expected:'pass 2'});
    if(n===5)return call('read_system_file',{path:f.path});
    return call('finish_step',{summary:'Applied the separately reviewed repair, checked the original project and read it back.',evidence:c.evidenceForCompletion.map(o=>o.id)});
  };
  for(const kind of ['test_copy','write','command']){
    const w=await f.app.store.get('workflows',f.w.id);await f.app.workflows.execute(w,new AbortController());
    const state=await f.app.workflows.read(f.w.id),a=await f.app.store.get('actions',state.operations.at(-1).action);assert.equal(a.kind,kind);
    if(kind!=='command')assert.equal(await readFile(f.path,'utf8'),f.content);
    await f.app.actions.decide(a.id,'approve',a.digest);assert.equal((await f.done(a)).status,'completed');
    const fresh=await f.app.store.get('workflows',f.w.id);await f.app.workflows.reconcile(fresh);await f.app.workflows.save(fresh);
  }
  await f.app.workflows.execute(await f.app.store.get('workflows',f.w.id),new AbortController());
  const result=await f.app.workflows.read(f.w.id);assert.equal(result.status,'completed',result.error);assert(result.requirementChecks.every(c=>c.passed));
  assert.equal(await readFile(f.path,'utf8'),f.content.replace('Math.max','Math.min'));assert.equal((await f.app.store.list('actions')).length,3);
  assert.equal(result.operations.filter(o=>o.expected).length,1);assert.equal(result.operations.filter(o=>o.command).length,1);
});

test('retained failed examples and changed task revisions cannot be bypassed with a copy test',async t=>{
  const f=await fixture(t);f.w.version=8;const args={repair:f.args.repair,before:'Math.max(width,area)',after:'Math.min(width,area)',cases:[{inputs:{width:700,area:1280},expected:900}]};
  f.w.operations.push({id:randomUUID(),revision:1,name:'check_repair_expression',status:'completed',arguments:args,result:checkRepairExpression(f.w,args)});
  f.w.version=12;await assert.rejects(prepareTestCopy(f.app.workflows,f.w,f.args),/failed an expression example/);
  const a=await f.stage(),w=await f.app.store.get('workflows',f.w.id);w.revision=2;await f.app.workflows.save(w);
  await assert.rejects(f.app.actions.decide(a.id,'approve',a.digest),/older plan/);await assert.rejects(lstat(a.payload.directory),{code:'ENOENT'});
});

test('external source changes during execution label the result historical while preserving the approved copies',async t=>{
  const f=await fixture(t,{slow:true}),a=await f.stage();await f.app.actions.decide(a.id,'approve',a.digest);
  await until(()=>lstat(join(a.payload.directory,'baseline','fit.test.mjs')).then(()=>true,()=>false));
  await writeFile(join(f.root,'support.mjs'),'export const label="external change";\n');
  const done=await f.done(a);assert.equal(done.status,'completed');assert.equal(done.result.originalSourcesCurrent,false);assert.match(done.result.sourceWarning,/source changed/i);
  assert.equal(done.result.runs[1].passed,true,'the approved snapshot stays intact');assert(done.result.cleanedUp);assert.equal(await readFile(f.path,'utf8'),f.content);
});

test('JavaScript module context must be bounded by an observed package inside the check folder',async t=>{
  const f=await fixture(t),manifest=join(f.root,'package.json'),js=join(f.root,'helper.js');
  await rm(manifest);f.w.operations=f.w.operations.filter(o=>o.result?.path!==manifest);
  await writeFile(js,'module.exports=1;\n');
  f.w.operations.push({id:randomUUID(),revision:1,name:'read_system_file',status:'completed',arguments:{path:js},result:await f.app.system.read(js)});
  await assert.rejects(prepareTestCopy(f.app.workflows,f.w,f.args),/preserve its module context/);
  await writeFile(manifest,'{"type":"commonjs"}\n');
  f.w.operations.push({id:randomUUID(),revision:1,name:'read_system_file',status:'completed',arguments:{path:manifest},result:await f.app.system.read(manifest)});
  const p=await prepareTestCopy(f.app.workflows,f.w,f.args);assert(p.files.some(x=>x.path===manifest));
});

test('approved copy tests cannot read a host sentinel or write their own source tree',async t=>{
  const f=await fixture(t),sentinel=join(dirname(f.root),'host-sentinel');await writeFile(sentinel,'host fixture');
  const testPath=join(f.root,'fit.test.mjs'),extra=`\nimport {readFileSync,writeFileSync} from 'node:fs';assert.throws(()=>readFileSync(${JSON.stringify(sentinel)}));assert.throws(()=>writeFileSync('./fit.mjs','overwrite'));assert.match(readFileSync('/proc/self/status','utf8'),/NoNewPrivs:\\s+1/);\n`;
  await writeFile(testPath,f.text['fit.test.mjs']+extra);const op=f.w.operations.find(o=>o.result?.path===testPath);op.result=await f.app.system.read(testPath);await f.app.workflows.save(f.w);
  const a=await f.stage();await f.app.actions.decide(a.id,'approve',a.digest);const done=await f.done(a);assert.equal(done.result.runs[1].passed,true);assert.equal(await readFile(sentinel,'utf8'),'host fixture');assert.equal(await readFile(f.path,'utf8'),f.content);
});

test('copy readiness names unread local imports and distinguishes missing files without reading or running them',async t=>{
  const f=await fixture(t,{gated:true}),helper=join(f.root,'support.mjs');f.w.operations=f.w.operations.filter(o=>o.result?.path!==helper);
  await assert.rejects(prepareTestCopy(f.app.workflows,f.w,f.args),e=>{assert.deepEqual(e.copyReadiness.neededReads,[helper]);assert.deepEqual(e.copyReadiness.missing,[]);return true;});
  assert.equal((await f.app.store.list('actions')).length,0);
  await rm(helper);
  await assert.rejects(prepareTestCopy(f.app.workflows,f.w,f.args),e=>{assert.deepEqual(e.copyReadiness.neededReads,[]);assert.deepEqual(e.copyReadiness.missing,[helper]);return true;});
  assert.equal(await readFile(f.path,'utf8'),f.content);
});

test('explicit policy rejects incompatible tasks and cannot be dropped by an output requirement update',async t=>{
  const f=await fixture(t,{gated:true});
  assert.throws(()=>guardCopyControl(f.w,'computer',{operation:'type_text'}),/Desktop control/);assert.doesNotThrow(()=>guardCopyControl(f.w,'computer',{operation:'windows'}));
  for(const [name,p,r] of [[true,f.w.project,f.w.requirements],['unknown',f.w.project,f.w.requirements],['Window tests',null,f.w.requirements],['Window tests',f.w.project,{...f.w.requirements,files:[]}],['Window tests',f.w.project,{...f.w.requirements,files:[{path:join(f.root,'fit.test.mjs')}]}]])assert.throws(()=>bindCopyRequirement(name,p,r));
  await assert.rejects(f.app.workflows.updateRequirements(f.w.id,{revision:1,requirements:{...f.w.requirements,commands:[]}}),/Keep the test-before-edit check/);
  assert.deepEqual((await f.app.store.get('workflows',f.w.id)).copyBeforeEdit,f.w.copyBeforeEdit);
});

test('all write formats require an exact current tested candidate, with results attached to its separate approval',async t=>{
  const f=await fixture(t,{gated:true}),content=f.content.replace('Math.max','Math.min');
  await assert.rejects(stageWrite(f,f.w,content),/Test before editing is required/);
  const a=await f.stage(),w=await reconcileCopy(f,a);
  await assert.rejects(stageWrite(f,w,content+'// different\n'),/Test before editing is required/);
  const edit=await stageWrite(f,w,content);assert.equal(edit.payload.requirementsCheck.copyReview.action,a.id);
  assert.deepEqual(edit.payload.requirementsCheck.copyReview.result.runs.map(r=>r.outcome),['assertion_failure','passed']);
  assert.equal(await readFile(f.path,'utf8'),f.content);
  await f.app.actions.decide(edit.id,'approve',edit.digest);assert.equal((await f.done(edit)).status,'completed');assert.equal(await readFile(f.path,'utf8'),content);
});

test('a completed failing assertion can be reviewed, but setup failure and task revision changes cannot authorize an edit',async t=>{
  const f=await fixture(t,{gated:true,after:'area'}),a=await f.stage(),w=await reconcileCopy(f,a),p=await f.app.system.prepareWrite(f.path,f.content.replace('Math.max(width,area)','area'));
  const review=await requireTestedCopy(f.app.workflows,w,p);assert.equal(review.result.runs[1].outcome,'assertion_failure');
  await assert.rejects(requireTestedCopy(f.app.workflows,{...w,revision:2},p),/Test before editing is required/);
  const done=await f.app.store.get('actions',a.id);done.result.runs[1].outcome='missing_dependency';await f.app.store.put('actions',done);
  await assert.rejects(requireTestedCopy(f.app.workflows,w,p),/two usable test results/);
  assert.equal(copyOutcome({code:1,content:'ERR_MODULE_NOT_FOUND AssertionError'},false),'missing_dependency');
  assert.equal(copyOutcome({code:1,content:'SyntaxError AssertionError'},false),'setup_failure');
  assert.equal(copyOutcome({code:1,content:'something failed'},false),'unclassified_failure');
});

test('a new local task revises its sole partial repair before editing, while a second planned correction permits staged progress',async t=>{
  const f=await fixture(t,{gated:true,after:'area'});f.w.version=33;f.w.engine='local';await f.app.workflows.save(f.w);
  const a=await f.stage(),w=await reconcileCopy(f,a),copy=w.operations.find(o=>o.name==='propose_test_copy'&&o.status==='completed');
  assert.equal(copy.result.diagnosis.status,'compared');assert.equal(copy.result.diagnosis.candidate.counts.fail,1);
  const progress=projectProgress(w);assert.equal(progress.next.tool,'record_repair_plan');assert.equal(progress.copyDiagnosisReview.unresolved.count,1);assert.equal(progress.copyDiagnosisReview.candidateApplied,false);assert.equal(progress.copyDiagnosisReview.resolved.count,1);assert.match(progress.next.message,/REPLACES the previous list/);
  assert.match(progress.copyDiagnosisReview.unresolved.tests[0],/small width/);
  const tools=focusedTools(w,[]).map(t=>t.function.name);assert(tools.includes('record_repair_plan'));assert(!tools.includes('propose_repair'));
  assert.match(focusedTools(w,[]).find(t=>t.function.name==='record_repair_plan').function.description,/un-applied improvement/);
  const source=f.content.replace('Math.max(width,area)','area'),payload=await f.app.system.prepareWrite(f.path,source);
  await assert.rejects(requireTestedCopy(f.app.workflows,w,payload),/sole remaining repair still fails 1 saved test/);
  await assert.rejects(stageWrite(f,w,source),/sole remaining repair still fails 1 saved test/);
  assert.equal(await readFile(f.path,'utf8'),f.content);
  const previous=structuredClone(w);previous.version=32;assert((await requireTestedCopy(f.app.workflows,previous,payload)).result);
  const support=join(f.root,'support.mjs');w.requirements.files.push({path:support,lineEndings:'lf',finalNewline:'required'});
  w.goal+=' Update the separate support label too.';
  const op={id:randomUUID(),name:'record_repair_plan',revision:w.revision,status:'started'};w.operations.push(op);
  op.result=recordRepairPlan(w,{repairs:[
    {file:f.path,line:1,before:'Math.max(width,area)',after:'area',reason:'First staged correction.'},
    {file:support,line:1,before:'"fixture"',after:'"updated"',reason:'Separate required support label correction.'}
  ]});op.status='completed';await f.app.workflows.save(w);
  assert.equal(projectProgress(w).next.tool,'propose_repair');
  const edit=await stageWrite(f,w,source);assert.equal(edit.kind,'write');assert.equal(edit.status,'pending');
  assert.equal(await readFile(f.path,'utf8'),f.content);
});

test('two observed defects can use separate partial and passing copies, reviewed edits, and a final original check',async t=>{
  const f=await fixture(t,{gated:true,multi:true});f.w.version=33;f.w.engine='local';await f.app.workflows.save(f.w);
  const firstCopy=await f.stage(),first=await reconcileCopy(f,firstCopy);
  const firstDiagnosis=first.operations.findLast(o=>o.name==='propose_test_copy'&&o.status==='completed').result.diagnosis;
  assert.deepEqual([firstDiagnosis.baseline.counts.fail,firstDiagnosis.resolved,firstDiagnosis.stillFailing,firstDiagnosis.candidate.counts.pass],[3,2,1,2]);
  assert.equal(projectProgress(first).next.tool,'propose_repair','the second saved correction keeps partial progress reviewable');
  const firstContent=f.content.replace('Math.max(width,area)','Math.min(width,area)');
  const firstEdit=await stageWrite(f,first,firstContent,f.args.repair);await reconcileCopy(f,firstEdit);
  assert.equal(await readFile(f.path,'utf8'),firstContent);
  const current=await f.app.store.get('workflows',f.w.id);
  current.operations.push({id:randomUUID(),revision:current.revision,name:'read_system_file',status:'completed',arguments:{path:f.path},result:await f.app.system.read(f.path)});
  await f.app.workflows.save(current);
  assert.equal(repairPlanContext(current).repairs.find(r=>r.id===f.args.repair).state,'edit_applied');
  const secondCopy=await f.stage(f.secondArgs),second=await reconcileCopy(f,secondCopy);
  const secondDiagnosis=second.operations.findLast(o=>o.name==='propose_test_copy'&&o.status==='completed').result.diagnosis;
  assert.deepEqual([secondDiagnosis.resolved,secondDiagnosis.stillFailing,secondDiagnosis.candidate.counts.pass],[1,0,3]);
  const finalContent=firstContent.replace('end-start||1','end-start');
  const secondEdit=await stageWrite(f,second,finalContent,f.secondArgs.repair);const edited=await reconcileCopy(f,secondEdit);
  assert.equal(await readFile(f.path,'utf8'),finalContent);
  const checkOp={id:randomUUID(),step:'step',revision:edited.revision,name:'propose_command',status:'started'};edited.operations.push(checkOp);await f.app.workflows.save(edited);
  const checkAction=await f.app.actions.propose('command',{program:'node',args:['--test','fit.test.mjs'],cwd:f.root},null,null,{id:edited.id,operation:checkOp.id,step:'step',revision:edited.revision});
  checkOp.action=checkAction.id;checkOp.status='waiting_approval';await f.app.workflows.save(edited);
  await f.app.actions.decide(checkAction.id,'approve',checkAction.digest);const checked=await f.done(checkAction);
  assert.equal(checked.status,'completed');assert.match(checked.result.content,/pass 3/);
  assert.equal((await f.app.store.list('actions')).filter(a=>a.kind==='test_copy'&&a.status==='completed').length,2);
  assert.equal((await f.app.store.list('actions')).filter(a=>a.kind==='write'&&a.status==='completed').length,2);
});

test('a pending tested edit survives restart but rechecks every dependency before approval',async t=>{
  const f=await fixture(t,{gated:true}),a=await f.stage(),w=await reconcileCopy(f,a),edit=await stageWrite(f,w,f.content.replace('Math.max','Math.min'));
  await f.restart();await assert.rejects(f.app.actions.decide(edit.id,'approve',edit.digest),/Resume/);await f.app.workflows.control(w.id,'resume');
  await writeFile(join(f.root,'support.mjs'),'export const label="external change";\n');
  await assert.rejects(f.app.actions.decide(edit.id,'approve',edit.digest),/source changed/i);assert.equal(await readFile(f.path,'utf8'),f.content);
  await writeFile(join(f.root,'support.mjs'),f.text['support.mjs']);await f.app.actions.decide(edit.id,'approve',edit.digest);assert.equal((await f.done(edit)).status,'completed');
});

test('an undiscovered computed import remains a real missing-dependency failure and cannot qualify an edit',async t=>{
  const f=await fixture(t,{gated:true}),path=join(f.root,'fit.test.mjs');await writeFile(path,"await import('./' + 'missing.mjs');\n"+f.text['fit.test.mjs']);
  f.w.operations.find(o=>o.result?.path===path).result=await f.app.system.read(path);await f.app.workflows.save(f.w);
  const a=await f.stage();assert(a.payload.dependencies.limitations.some(l=>l.includes('Computed')));
  const w=await reconcileCopy(f,a),done=await f.app.store.get('actions',a.id);assert.deepEqual(done.result.runs.map(r=>r.outcome),['missing_dependency','missing_dependency']);
  await assert.rejects(stageWrite(f,w,f.content.replace('Math.max','Math.min')),/two usable test results/);assert.equal(await readFile(f.path,'utf8'),f.content);
});

test('newly recorded failed examples remain a blocker even after a passing candidate copy',async t=>{
  const f=await fixture(t,{gated:true}),a=await f.stage(),w=await reconcileCopy(f,a);
  // Exercise the retained explicit-expression receipt supported by older plans.
  w.version=8;const result=checkRepairExpression(w,{repair:f.args.repair,before:'Math.max(width,area)',after:'Math.min(width,area)',cases:[{inputs:{width:700,area:1280},expected:900}]});
  w.operations.push({id:randomUUID(),name:'check_repair_expression',revision:w.revision,status:'completed',result});w.version=13;
  const payload=await f.app.system.prepareWrite(f.path,f.content.replace('Math.max','Math.min'));
  await assert.rejects(requireTestedCopy(f.app.workflows,w,payload),/unresolved failed examples/);
});

test('a regressing copy comparison focuses a new local plan without rereading unchanged source',async t=>{
  const f=await fixture(t,{gated:true}),a=await f.stage(),w=await reconcileCopy(f,a);
  w.version=21;w.engine='ollama';
  const copy=w.operations.find(o=>o.name==='propose_test_copy'&&o.status==='completed');
  copy.result.diagnosis={status:'compared',newlyFailing:1,stillFailing:0,resolved:1};
  const menuTools=['read_system_file','propose_check'].map(name=>({function:{name,description:'Fixture',parameters:{type:'object',properties:{}}}}));
  const progress=projectProgress(w),names=focusedTools(w,menuTools).map(t=>t.function.name);
  assert.equal(progress.next.tool,'record_repair_plan');assert.equal(progress.copyDiagnosisReview.repair,f.args.repair);
  assert(names.includes('record_repair_plan'));assert(names.includes('inspect_source_lines'));
  for(const name of ['read_system_file','propose_repair','propose_check','propose_test_copy'])assert(!names.includes(name));
  assert.match(focusedTools(w,[]).find(t=>t.function.name==='record_repair_plan').function.description,/revised correction list/);
  const cloud=structuredClone(w);cloud.engine='chatgpt';assert.equal(projectProgress(cloud).next.tool,undefined);assert(focusedTools(cloud,menuTools).some(t=>t.function.name==='read_system_file'));
});

test('copy progress and approval survive renamed repairs and equivalent fragment spelling, then invalidate on observed dependency changes',async t=>{
  const f=await fixture(t,{gated:true}),a=await f.stage(),w=await reconcileCopy(f,a);
  const op={id:randomUUID(),name:'record_repair_plan',revision:1,status:'started'};w.operations.push(op);
  op.result=recordRepairPlan(w,{repairs:[{file:f.path,line:1,before:f.content.trim(),after:f.content.replace('Math.max','Math.min').trim(),reason:'Same correction expressed as a whole line.'}]});op.status='completed';
  const p=projectProgress(w);assert.equal(p.next.tool,'propose_repair');assert.deepEqual(p.next.arguments,{repair:op.result.repairs[0].id});assert.notEqual(op.result.repairs[0].id,f.args.repair);
  await f.app.workflows.save(w);const edit=await stageWrite(f,w,f.content.replace('Math.max','Math.min'));assert.equal(edit.payload.requirementsCheck.copyReview.action,a.id);await f.app.actions.decide(edit.id,'dismiss');await f.app.workflows.reconcile(w);
  const path=join(f.root,'support.mjs');await writeFile(path,f.text['support.mjs']+'// changed\n');w.operations.push({id:randomUUID(),name:'read_system_file',revision:1,status:'completed',arguments:{path},result:await f.app.system.read(path)});
  assert.equal(projectProgress(w).next.tool,'propose_test_copy');
});
