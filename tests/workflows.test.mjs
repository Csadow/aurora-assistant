import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {Workflows} from '../src/workflows.mjs';

export const call=(name,args={})=>({role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]});
export async function until(fn,label='condition',timeout=4000){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,10));}throw new Error('Timeout: '+label);}
const evidence=messages=>JSON.parse(messages.at(-1).content).recentEvidence.map(JSON.parse);
async function fixture(t,respond,options={}){
  const dir=await mkdtemp(join(tmpdir(),'aurora-workflow-')),home=join(dir,'project');await mkdir(home);const path=join(home,'note.txt');await writeFile(path,'before');
  const ollama={model:'fixture',generationOptions:{think:false},check:async()=>{},status:async()=>({online:true,model:'fixture',models:[{name:'fixture'}]}),chat:async(messages,tools,signal,chunk,opts)=>{signal?.throwIfAborted();return opts?.format?.properties?.steps?{content:JSON.stringify({steps:[{title:'Improve the fixture',check:'Read the changed file and run its check.'}]})}:respond(messages,{path,home,signal,tools,opts});}};
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],ollamaClient:ollama,workflowOptions:{pollMs:10,segmentMs:5000},...options});
  t.after(async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);await rm(dir,{recursive:true,force:true});});
  return Object.assign(app,{dir,home,path,ollama});
}
const get=async(f,id)=>f.store.get('workflows',id);
async function waiting(f,id){return until(async()=>{const w=await get(f,id);return !f.workflows.running.has(id)&&w.status==='waiting_approval'?w:false;},'approval');}
async function approve(f,w){const a=await f.store.get('actions',w.operations.at(-1).action);await f.actions.decide(a.id,'approve',a.digest);return a;}

test('new nonproject workflows pause on an exact prose question without reading or changing files',async t=>{
  const question='Which of the two files should I read?';
  const f=await fixture(t,()=>({role:'assistant',content:question}));
  const started=await f.workflows.start({goal:'Ask which file to read before selecting one.'});
  const w=await until(async()=>{const current=await get(f,started.id);return current.status==='waiting_input'&&!f.workflows.running.has(started.id)?current:false;},'prose question pause');
  assert.equal(w.version,36);assert.equal(w.question,question);assert.equal(w.operations.length,1);
  assert.equal(w.operations[0].name,'ask_user');assert.equal(w.operations[0].questionSource,'model prose');
  assert.equal((await f.store.list('actions')).length,0);assert.equal(await readFile(f.path,'utf8'),'before');
  const answer='Use only the second file and do not ask again.',updated=await f.workflows.steer(w.id,answer,w.revision),context=JSON.parse(f.workflows.context(updated));
  assert.equal(context.answeredQuestions[0].question,question);assert.equal(context.answeredQuestions[0].answer,answer);
  assert(!context.recentEvidence.some(item=>item.includes(question)));assert.equal(updated.operations.length,1);
});

test('a missing approval choice remains a real question in a new workflow',async t=>{
  const question='Which approval record should I inspect?';
  const f=await fixture(t,()=>({role:'assistant',content:question}));
  const started=await f.workflows.start({goal:'Ask which approval record to inspect.'});
  const w=await until(async()=>{const current=await get(f,started.id);return current.status==='waiting_input'&&!f.workflows.running.has(started.id)?current:false;},'missing approval choice');
  assert.equal(w.question,question);assert.equal(w.operations[0].name,'ask_user');
});

test('workflow saves reviewed edits, reads them back, checks command output and completes with evidence',async t=>{
  let executions=0;
  const f=await fixture(t,(m,{path,home})=>{
    const ops=evidence(m),last=ops.at(-1);
    if(!last)return call('read_system_file',{path});
    if(last.name==='read_system_file'&&last.result.content==='before')return call('propose_file_edit',{path,content:'after',reason:'Requested fixture edit'});
    if(last.name==='propose_file_edit')return call('read_system_file',{path});
    if(last.name==='read_system_file'&&!ops.some(o=>o.name==='verify_outcome'))return call('propose_command',{program:'printf',args:['check passed'],cwd:home,reason:'Check fixture'});
    if(last.name==='verify_outcome')return call('read_system_file',{path});
    if(last.name==='propose_command')return call('verify_outcome',{evidence:last.id,kind:'command_output',expected:'check passed'});
    return call('finish_step',{summary:'Readback matches; check passed.',evidence:ops.filter(o=>o.status==='completed').map(o=>o.id)});
  },{executeCommand:async()=>{executions++;return {code:0,content:'check passed'};}});
  const w=await f.workflows.start({goal:'Update fixture and verify'});const pending=await waiting(f,w.id);
  assert.equal(await readFile(f.path,'utf8'),'before');assert.equal(pending.steps.length,1);assert(pending.operations[1].action);
  await approve(f,pending);const checking=await until(async()=>{const w=await get(f,pending.id);return w.status==='waiting_approval'&&w.operations.at(-1).name==='propose_command'?w:false;});
  assert.equal(await readFile(f.path,'utf8'),'after');await approve(f,checking);
  const done=await until(async()=>{const w=await get(f,pending.id);return w.status==='completed'?w:false;});assert.equal(executions,1);assert(done.steps[0].evidence.length>=3);assert.equal(f.workflows.unverifiedWrites(done).length,0);
});

test('Stop blocks approval; Resume keeps the exact pending action',async t=>{
  const f=await fixture(t,(_m,{path})=>call('propose_file_edit',{path,content:'after',reason:'Fixture'}));
  const w=await f.workflows.start({goal:'Edit fixture'}),pending=await waiting(f,w.id);const a=await f.store.get('actions',pending.operations[0].action);
  await f.workflows.control(w.id,'pause');await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/Resume/);
  await f.workflows.control(w.id,'resume');const resumed=await get(f,w.id);assert.equal(resumed.operations[0].action,a.id);assert.equal((await f.store.list('actions')).length,1);
  await f.workflows.control(w.id,'cancel');assert.equal((await f.store.get('actions',a.id)).status,'dismissed');assert.equal(await readFile(f.path,'utf8'),'before');
});

test('restart reconciles an orphaned completed action without replay and preserves unfinished plans',async t=>{
  let reads=0;const f=await fixture(t,(m,{path})=>{const ops=evidence(m);if(!ops.length)return call('propose_file_edit',{path,content:'after',reason:'Fixture'});reads++;if(ops.at(-1).name==='propose_file_edit')return call('read_system_file',{path});return call('finish_step',{summary:'Saved and verified.',evidence:ops.filter(o=>o.status==='completed').map(o=>o.id)});});
  const w=await f.workflows.start({goal:'Edit fixture'}),pending=await waiting(f,w.id);await f.workflows.close();await approve(f,pending);await until(()=>!f.actions.running.size);
  // Simulate the crash window after the action journal commit but before the
  // workflow journal knows the action ID or result.
  const stale=await get(f,w.id);delete stale.operations[0].action;stale.operations[0].status='started';stale.status='running';await f.store.put('workflows',stale);
  f.workflows=new Workflows({assistant:f.assistant,store:f.store,skills:f.skills,actions:f.actions,pollMs:10});await f.workflows.init();
  const recovered=await get(f,w.id);assert.equal(recovered.status,'paused');assert.equal(recovered.operations[0].status,'completed');assert(recovered.operations[0].action);assert.equal(reads,0);
  await f.workflows.control(w.id,'resume');await until(async()=>(await get(f,w.id)).status==='completed');assert.equal((await f.store.list('actions')).length,1);
});

test('uncertain, rejected and expired actions require an explicit observation before continuing',async t=>{
  for(const state of ['interrupted','dismissed','expired']){
    const f=await fixture(t,(_m,{path})=>call('propose_file_edit',{path,content:'after',reason:'Fixture'}));
    const w=await f.workflows.start({goal:'Edit fixture'}),pending=await waiting(f,w.id);await f.workflows.close();const a=await f.store.get('actions',pending.operations[0].action);
    if(state==='expired')a.expires='2000-01-01';else a.status=state;await f.store.put('actions',a);
    await f.workflows.init();assert.equal((await get(f,w.id)).status,'needs_verification');await assert.rejects(f.workflows.control(w.id,'resume'),/observation/);
    await f.workflows.control(w.id,'resolve','I checked the file. It is still unchanged.');assert.equal((await get(f,w.id)).status,'paused');assert.equal((await f.store.list('actions')).length,1);
  }
});

test('hallucinated evidence and missing write readback cannot complete a workflow',async t=>{
  const f=await fixture(t,(m,{path})=>{const ops=evidence(m);if(!ops.length)return call('propose_file_edit',{path,content:'after',reason:'Fixture'});return call('finish_step',{summary:'I finished everything.',evidence:ops.filter(o=>o.status==='completed').map(o=>o.id)});});
  const w=await f.workflows.start({goal:'Edit fixture'});await approve(f,await waiting(f,w.id));const paused=await until(async()=>{const current=await get(f,w.id);return current.status==='needs_help'?current:false;});assert(paused.operations.some(o=>o.result?.error?.includes('Read back')));assert(!paused.result);
  const g=await fixture(t,()=>call('finish_step',{summary:'Imaginary result',evidence:['made-up']}));const job=await g.workflows.start({goal:'Inspect fixture'});await until(async()=>(await get(g,job.id)).status==='needs_help');assert(!(await get(g,job.id)).result);
});

test('cancellation aborts local generation; budgets and model changes block unsafe resume',async t=>{
  const f=await fixture(t,async(_m,{signal})=>{await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
  const w=await f.workflows.start({goal:'Inspect fixture'});await until(async()=>(await get(f,w.id)).status==='running');await f.workflows.control(w.id,'pause');assert.equal(f.assistant.busy.size,0);
  f.ollama.model='different';await assert.rejects(f.workflows.control(w.id,'resume'),/Restore the model/);f.ollama.model='fixture';const saved=await get(f,w.id);saved.calls=48;await f.store.put('workflows',saved);await assert.rejects(f.workflows.control(w.id,'resume'),/limit/);
});

test('failed commands pause for verification and do not execute again on polling',async t=>{
  let count=0;const f=await fixture(t,(_m,{home})=>call('propose_command',{program:'printf',args:['fixture'],cwd:home,reason:'Fixture check'}),{executeCommand:async()=>{count++;return {code:1,content:'Check failed'};}});
  const w=await f.workflows.start({goal:'Check the fixture'});await approve(f,await waiting(f,w.id));
  await until(async()=>(await get(f,w.id)).status==='needs_verification');await f.workflows.tick();await f.workflows.tick();assert.equal(count,1);assert.match((await get(f,w.id)).operations[0].result.content,/failed/);
});

test('browser workflow observes automatically, reviews input, then observes its result',async t=>{
  const f=await fixture(t,(m)=>{
    const ops=evidence(m),last=ops.at(-1),action=last?.arguments.operation;
    if(!last)return call('computer_action',{operation:'open_url',url:'https://example.com',reason:'Requested page'});
    if(action==='open_url')return call('computer_action',{operation:'browser_read',reason:'Observe controls'});
    if(action==='browser_read'&&!ops.some(o=>o.arguments.operation==='browser_fill'))return call('computer_action',{operation:'browser_fill',ref:'r1',revision:'v1',text:'Fixture input',reason:'Requested input'});
    if(action==='browser_fill')return call('computer_action',{operation:'browser_read',reason:'Verify visible result'});
    if(action==='browser_read')return call('verify_outcome',{evidence:ops.at(-1).id,kind:'browser_text',expected:'Fixture input'});
    return call('finish_step',{summary:'Input is visible in the fresh page snapshot.',evidence:ops.filter(o=>o.status==='completed').map(o=>o.id)});
  });
  const executed=[];f.actions.computer={enabled(){},prepare:async p=>p,execute:async p=>{executed.push(p.operation);return {url:'https://example.com/',title:'Fixture',text:executed.includes('browser_fill')?'Fixture input':'Empty field r1, revision v1',revision:'v1'};}};
  const w=await f.workflows.start({goal:'Fill a page field and check the result'});
  const pending=await until(async()=>{const saved=await get(f,w.id);return saved.status==='waiting_approval'&&saved.operations.at(-1).arguments.operation==='browser_fill'?saved:false;});
  assert.deepEqual(executed,['open_url','browser_read']);await approve(f,pending);
  await until(async()=>(await get(f,w.id)).status==='completed');assert.deepEqual(executed,['open_url','browser_read','browser_fill','browser_read']);
});

test('restart during an action becomes uncertain; no approval can replay it',async t=>{
  const f=await fixture(t,(_m,{home})=>call('propose_command',{program:'printf',args:['fixture'],cwd:home,reason:'Fixture check'}));
  const w=await f.workflows.start({goal:'Check fixture'}),pending=await waiting(f,w.id);await f.workflows.close();
  const a=await f.store.get('actions',pending.operations[0].action);a.status='running';await f.store.put('actions',a);await f.actions.init();await f.workflows.init();
  assert.equal((await get(f,w.id)).status,'needs_verification');assert.equal((await f.store.get('actions',a.id)).status,'interrupted');await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/already/);
});

test('skills are snapshotted for a workflow and cannot add tools or bypass review',async t=>{
  let messages;const f=await fixture(t,(m,{path})=>{messages=m;return call('propose_file_edit',{path,content:'after',reason:'Fixture'});});
  const skill=await f.skills.save({id:'fixture-work',content:'# Fixture\nKeep findings concise.',revision:null});
  const w=await f.workflows.start({goal:'Edit fixture',skills:['fixture-work']});await waiting(f,w.id);
  await f.skills.save({id:'fixture-work',content:'# Fixture\nNew revision.',revision:skill.revision});
  const saved=await get(f,w.id);assert.match(saved.skills[0].content,/concise/);assert.equal(saved.skills[0].revision,skill.revision);assert.match(messages[0].content,/cannot authorize/);assert.equal(await readFile(f.path,'utf8'),'before');
});

test('prose completion binds to real evidence through a tool-free check; false or invented evidence cannot finish',async t=>{
  for(const outcome of ['supported','incomplete','invented']){
    let assessments=0;const f=await fixture(t,(m,{path,tools,opts})=>{
      if(opts?.format){
        assessments++;assert.equal(tools,undefined);assert.equal(opts.think,false);
        const context=JSON.parse(m.at(-1).content).state;
        assert.deepEqual(opts.format.properties.evidence.items.enum,context.evidenceForCompletion.map(o=>o.id));assert(!opts.format.properties.evidence.items.enum.includes('fake-id'));
        return {content:JSON.stringify({complete:outcome!=='incomplete',summary:'Read the fixture.',evidence:[outcome==='invented'?'fake-id':JSON.parse(context.recentEvidence[0]).id]})};
      }
      if(!evidence(m).length)return call('read_system_file',{path});assert.deepEqual(tools.find(t=>t.function.name==='finish_step').function.parameters.properties.evidence.items.enum,JSON.parse(m.at(-1).content).evidenceForCompletion.map(o=>o.id));return {content:'The file has been inspected.'};
    });
    const w=await f.workflows.start({goal:'Inspect fixture'});const done=await until(async()=>{const saved=await get(f,w.id);return ['completed','paused','needs_help'].includes(saved.status)?saved:false;});
    assert.equal(done.status,outcome==='supported'?'completed':'needs_help');assert(assessments>0);assert.equal((await f.store.list('actions')).length,0);
  }
});

test('changing models while awaiting approval pauses automatic continuation without replay',async t=>{
  const f=await fixture(t,(_m,{path})=>call('propose_file_edit',{path,content:'after',reason:'Fixture'}));
  const w=await f.workflows.start({goal:'Edit fixture'}),pending=await waiting(f,w.id);f.ollama.model='changed';await approve(f,pending);
  const paused=await until(async()=>{const saved=await get(f,w.id);return saved.status==='paused'?saved:false;});assert.match(paused.error,/original model/);assert.equal((await f.store.list('actions')).length,1);assert.equal(await readFile(f.path,'utf8'),'after');
});

test('readback must follow the latest edit; an earlier revision cannot verify a later correction',async t=>{
  const f=await fixture(t,()=>{}),path=f.path;
  const w={operations:[
    {expected:{path,revision:'first'},finished:'2026-01-01T00:00:01Z'},
    {name:'read_system_file',status:'completed',result:{path,revision:'first'},started:'2026-01-01T00:00:02Z'},
    {expected:{path,revision:'second'},finished:'2026-01-01T00:00:03Z'}
  ]};
  assert.deepEqual(f.workflows.unverifiedWrites(w),[{path,revision:'second'}]);
  w.operations.push({name:'read_system_file',status:'completed',result:{path,revision:'second'},started:'2026-01-01T00:00:04Z'});
  assert.deepEqual(f.workflows.unverifiedWrites(w),[]);
  w.operations.splice(1,1);assert.deepEqual(f.workflows.unverifiedWrites(w),[]);
});
