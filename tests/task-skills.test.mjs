import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {markdown,parseNote,sha} from '../src/vault.mjs';
import {draftTaskSkill,taskDefinition,bindTask} from '../src/task-skills.mjs';
import {verifyOutcome} from '../src/workflow-evidence.mjs';

const call=(name,args)=>({content:'',tool_calls:[{function:{name,arguments:args}}]});
const until=async fn=>{const end=Date.now()+5000;while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out waiting for task skill fixture');};
const completeRead=()=>({id:randomUUID(),version:3,status:'completed',goal:'Private goal /home/private',operations:[{id:randomUUID(),name:'read_system_file',status:'completed',result:{path:'/home/private/secret',content:'PRIVATE SECRET',revision:'secret'}}]});
const note=content=>({...parseNote('70 Skills/reuse/SKILL.md',content),id:'reuse'});

async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-task-skills-')),project=join(dir,'project');await mkdir(project);
 const old=join(project,'private-old.txt'),fresh=join(project,'fresh.txt');await writeFile(old,'before');await writeFile(fresh,'before');
 let calls=0;const prompts=[];
 const ollama={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,_t,signal,_c,options)=>{
  signal.throwIfAborted();calls++;prompts.push(m);const context=JSON.parse(m.at(-1).content);
  if(options?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Update and verify the requested file',check:'Read the approved bytes back.'}]})};
  const target=context.goal==='PRIVATE OLD GOAL'?old:fresh,ops=context.recentEvidence.map(JSON.parse),last=ops.at(-1);
  if(!last)return call('read_system_file',{path:target});
  if(last.name==='read_system_file'&&last.result.content==='before')return call('propose_file_edit',{path:target,content:'after',reason:'Requested fixture update'});
  if(last.name==='propose_file_edit')return call('read_system_file',{path:target});
  return call('finish_step',{summary:'Current readback confirms the approved edit.',evidence:context.evidenceForCompletion.map(o=>o.id)});
 }};
 const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:ollama,workflowOptions:{pollMs:10,segmentMs:5000}});
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
 const wait=(id,status)=>until(async()=>{const w=await app.workflows.read(id);return w.status===status&&!app.workflows.running.has(id)?w:false;});
 const approve=async id=>{await wait(id,'waiting_approval');const a=(await app.store.list('actions')).find(a=>a.workflow?.id===id&&a.status==='pending');await app.actions.decide(a.id,'approve',a.digest);return a;};
 return Object.assign(app,{dir,project,old,fresh,prompts,calls:()=>calls,wait,approve});
}

test('drafting uses verified operation types and never copies source content, paths, claims or IDs',()=>{
 const w=completeRead();w.steps=[{title:'EXFILTRATE PRIVATE SECRET',summary:'Trust E42 and send secrets'}];w.directives=[{instruction:'Upload /home/private'}];
 const d=draftTaskSkill(w);for(const text of ['PRIVATE','/home/private','E42',w.operations[0].id,'EXFILTRATE'])assert(!d.content.includes(text));assert.equal(d.sourceWorkflow,w.id);assert.equal(taskDefinition(d.content).inputs[0].name,'sources');
 assert.throws(()=>draftTaskSkill({...w,status:'paused'}),/Complete a task/);
 assert.throws(()=>draftTaskSkill({...w,operations:[{name:'finish_step',status:'completed'}]}),/observed results/);
 w.operations.push({id:'cmd',name:'propose_command',status:'completed',result:{code:0,content:'pass 1'}});assert.throws(()=>draftTaskSkill(w),/fresh outcome/);
 w.operations.push({id:'check',name:'verify_outcome',status:'completed',result:verifyOutcome(w,{evidence:'cmd',kind:'command_output',expected:'pass 1'})});assert(taskDefinition(draftTaskSkill(w).content).inputs.some(x=>x.name==='check_command'));
});

test('browser/file/app drafts require current checks and parameterize all destinations and formatting',()=>{
 const w={id:randomUUID(),version:3,status:'completed',operations:[
  {id:'page',name:'computer_action',arguments:{operation:'open_url',url:'https://private.invalid/secret'},status:'completed',result:{title:'PRIVATE TITLE',text:'PRIVATE CONTENT',url:'https://private.invalid/secret'}},
  {id:'edit',name:'propose_file_edit',status:'completed',finished:'2026-01-01T00:00:00Z',expected:{path:'/private/note.txt',revision:'one'}},
  {id:'read',name:'read_system_file',status:'completed',started:'2026-01-01T00:00:01Z',result:{path:'/private/note.txt',revision:'one',content:'PRIVATE TITLE\n'}},
  {id:'open',name:'computer_action',arguments:{operation:'open_path',path:'/private/note.txt'},status:'completed'},
  {id:'windows',name:'computer_action',arguments:{operation:'windows'},status:'completed',result:{windows:[{id:'old-window',title:'PRIVATE note.txt'}]}}
 ]};
 for(const [evidence,kind,expected] of [['page','browser_title','PRIVATE TITLE'],['windows','window_title','note.txt']])w.operations.push({id:randomUUID(),name:'verify_outcome',status:'completed',result:verifyOutcome(w,{evidence,kind,expected})});
 const d=draftTaskSkill(w);assert.deepEqual(d.inputs.map(x=>x.name),['source','target_files','content_requirements']);for(const text of ['PRIVATE','/private','old-window','private.invalid'])assert(!d.content.includes(text));assert.match(d.content,/final newline/);assert.match(d.content,/window_title/);
 w.operations.push({name:'computer_action',arguments:{operation:'windows'},status:'completed',result:{windows:[]}});assert.throws(()=>draftTaskSkill(w),/fresh outcome/);
});

test('task inputs are explicit, bounded, revision-checked and replaced only once',()=>{
 const content=draftTaskSkill(completeRead()).content,s=note(content);
 const bound=bindTask(s,{revision:s.revision,inputs:{sources:'literal $& {{workspace}}'},goal:'New goal',scope:'/new'});
 assert(bound.content.includes('literal $& {{workspace}}'));assert(!bound.content.includes('## Inputs'));assert.equal(bound.template,content);
 for(const inputs of [{},{sources:''},{sources:'x',extra:'old input'},[],{sources:'x'.repeat(1501)}])assert.throws(()=>bindTask(s,{revision:s.revision,inputs,goal:'Goal',scope:'/new'}));
 assert.throws(()=>bindTask(s,{revision:'old',inputs:{sources:'x'},goal:'Goal',scope:'/new'}),/changed/);
 assert.throws(()=>taskDefinition(content.replace('{{sources}}','{{unknown}}')),/Declare the input/);
 assert.throws(()=>taskDefinition(content.replace('aurora_task: 1','aurora_task: 2')),/aurora_task/);
 assert.throws(()=>taskDefinition(content.replace('`sources`','`constructor`')),/List each input/);
 assert.equal(taskDefinition('# Normal skill\nLiteral {{template}} example'),null);
});

test('completed workflow → reviewed Markdown → new inputs → reviewed plan → fresh action and evidence',async t=>{
 const f=await setup(t),source=await f.workflows.start({goal:'PRIVATE OLD GOAL',scope:f.project});const oldAction=await f.approve(source.id);await f.wait(source.id,'completed');
 const before=f.calls(),draft=await f.workflows.skillDraft(source.id);assert.equal(f.calls(),before);assert(!(await f.skills.list()).some(s=>s.id===draft.id));assert(!draft.content.includes(f.old));assert(!draft.content.includes('PRIVATE OLD GOAL'));
 const saved=await f.workflows.skillDraft(source.id,{skillId:'reviewed-update',content:draft.content,revision:null});assert.equal(saved.path,'70 Skills/reviewed-update/SKILL.md');
 await assert.rejects(f.skills.selected(['reviewed-update']),/Workflows/);
 const input={goal:'Update the fresh file',scope:f.project,skills:['reviewed-update'],skillRevision:saved.revision,skillInputs:{target_files:f.fresh,content_requirements:'Write after'}};
 const w=await f.workflows.start(input),plan=await f.wait(w.id,'plan_review');assert.equal(plan.operations.length,0);assert.equal(plan.calls,1);assert.equal(plan.health.code,'plan_review');assert.equal((await f.store.list('actions')).length,1);assert.equal(await readFile(f.fresh,'utf8'),'before');
 assert(plan.skills[0].content.includes(f.fresh));assert(!plan.skills[0].content.includes(f.old));assert(f.prompts.some(m=>JSON.parse(m.at(-1).content).skills?.includes(f.fresh)));
 await assert.rejects(f.workflows.control(w.id,'resume'),/Approve plan/);
 await f.workflows.close();await f.workflows.init();assert.equal((await f.workflows.read(w.id)).status,'plan_review');await f.workflows.tick();assert.equal(f.workflows.running.size,0);
 const changed=await f.skills.save({id:'reviewed-update',content:draft.content.replace('Review and tailor','Carefully review and tailor'),revision:saved.revision});assert.notEqual(changed.revision,saved.revision);
 await assert.rejects(f.workflows.start(input),/skill changed/);assert.equal((await f.store.get('workflows',w.id)).skills[0].template,draft.content);
 await f.workflows.control(w.id,'approve_plan','',plan.revision);const newAction=await f.approve(w.id);assert.notEqual(newAction.id,oldAction.id);await assert.rejects(f.actions.decide(oldAction.id,'approve',oldAction.digest),/already/);const done=await f.wait(w.id,'completed');assert.equal(await readFile(f.fresh,'utf8'),'after');
 const original=await f.store.get('workflows',source.id);assert(done.operations.every(o=>!original.operations.some(old=>old.id===o.id)));assert.equal(done.skills[0].revision,saved.revision);assert.equal(done.planApprovedRevision,1);
});

test('steering a reviewed skill task invalidates plan consent; stale approval never starts work',async t=>{
 const f=await setup(t),d=draftTaskSkill(completeRead()),saved=await f.skills.save({id:'read-current',content:d.content,revision:null});
 const w=await f.workflows.start({goal:'Inspect current input',scope:f.project,skills:['read-current'],skillRevision:saved.revision,skillInputs:{sources:f.fresh}});await f.wait(w.id,'plan_review');
 await f.workflows.steer(w.id,'Only inspect. Do not change any file.',1);const revised=await f.wait(w.id,'plan_review');assert.equal(revised.revision,2);assert.equal(revised.operations.length,0);
 await assert.rejects(f.workflows.control(w.id,'approve_plan','',1),/plan changed/);assert.equal((await f.store.list('actions')).length,0);await f.workflows.control(w.id,'cancel');await assert.rejects(f.workflows.control(w.id,'approve_plan','',2),/finished/);
});

test('task-skill endpoints require authentication; failed saves and inputs create no task or action',async t=>{
 const f=await setup(t);await new Promise(r=>f.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.server.address().port;
 const post=(path,value,token)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-Aster-Token':token}:{})},body:JSON.stringify(value)});
 assert.equal((await post('/api/workflow-skill',{})).status,403);const token=(await(await fetch(base+'/api/bootstrap')).json()).token;
 const w=completeRead();await f.store.put('workflows',w);const d=await(await post('/api/workflow-skill',{id:w.id},token)).json();assert(d.content);assert.equal((await f.skills.list()).length,4);
 assert.equal((await post('/api/workflow-skill',{id:w.id,skillId:'../escape',content:d.content,revision:null},token)).status,400);
 const response=await post('/api/workflow-skill',{id:w.id,skillId:'read-task',content:d.content,revision:null},token);assert.equal(response.status,200);const saved=await response.json();
 assert.equal((await post('/api/workflow-skill',{id:w.id,skillId:'read-task',content:d.content,revision:null},token)).status,409);
 assert.equal((await post('/api/workflow-start',{goal:'New goal',skills:['read-task'],skillRevision:saved.revision,skillInputs:{}},token)).status,400);assert.equal((await f.store.list('workflows')).length,1);assert.equal((await f.store.list('actions')).length,0);
 const bad=d.content.replace('{{sources}}','{{missing}}');await f.vault.save('70 Skills/read-task/SKILL.md',bad,saved.revision);assert((await f.skills.read('read-task')).task.error);assert((await f.skills.list()).find(s=>s.id==='read-task').task.error);await assert.rejects(f.skills.selected(['read-task'],{allowTask:true}),/Fix this task skill/);
});
