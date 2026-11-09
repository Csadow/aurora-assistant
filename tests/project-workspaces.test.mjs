import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
const call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});
const until=async fn=>{const end=Date.now()+10000;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('Project fixture timed out');};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'aurora-projects-')),folder=join(dir,'project'),outside=join(dir,'other');await mkdir(folder);await mkdir(outside);const file=join(folder,'one.txt');await writeFile(file,'one\n');await writeFile(join(outside,'other.txt'),'other\n');
  let respond=c=>c.evidenceForCompletion.length?call('finish_step',{summary:'Fresh file observed.',evidence:c.evidenceForCompletion.map(o=>o.id)}):call('read_system_file',{path:file});
  const model={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,_t,signal,_c,options)=>{signal.throwIfAborted();return options?.format?.properties.steps?{content:JSON.stringify({steps:[{title:'Inspect the project',check:'Fresh file observation and required check results.'}]})}:respond(JSON.parse(m.at(-1).content));}};
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:model,workflowOptions:{pollMs:10,segmentMs:10000}});
  t.after(async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
  const input={name:'Example project',notePath:'20 Projects/Example Project.md',folders:[folder],checks:[{name:'Tests',program:'node',args:['--test','one.test.mjs'],cwd:folder,outputIncludes:'pass 1'}]};
  const wait=(id,status)=>until(async()=>{const w=await app.workflows.read(id);return w.status===status&&!app.workflows.running.has(id)?w:null;});
  const start=(p,checks=[])=>app.workflows.start({goal:'Inspect and verify the project',projectId:p.id,projectRevision:p.revision,projectCheckNames:checks});
  return {...app,dir,folder,outside,file,input,wait,start,setReply:r=>respond=r};
}
test('project settings normalize commands without execution, reject stale updates and duplicate notes',async t=>{
  const f=await fixture(t),p=await f.projectWorkspaces.save(f.input);assert.equal(p.revision,1);assert.equal(p.checks[0].program,'/usr/bin/node');assert.equal((await f.store.list('actions')).length,0);
  const next=await f.projectWorkspaces.save({...p,name:'Revised'});assert.equal(next.revision,2);await assert.rejects(f.projectWorkspaces.save({...p,name:'Stale'}),/settings changed/);await assert.rejects(f.projectWorkspaces.save(f.input),/already has/);await assert.rejects(f.start(p),/settings changed/);assert.equal((await f.store.list('workflows')).length,0);
});
test('project configuration rejects drafts, invalid folders, duplicate checks and commands outside folders',async t=>{
  const f=await fixture(t);
  for(const change of [{folders:[f.file]},{folders:[f.folder,f.folder]},{folders:[]},{checks:[{...f.input.checks[0],cwd:f.outside}]},{checks:[f.input.checks[0],f.input.checks[0]]},{checks:[{...f.input.checks[0],outputIncludes:''}]}])await assert.rejects(f.projectWorkspaces.save({...f.input,...change}));
  await f.vault.save('20 Projects/Draft.md','---\nstatus: draft\n---\n# Draft\n',null);await assert.rejects(f.projectWorkspaces.save({...f.input,notePath:'20 Projects/Draft.md'}),/active project/);
});
test('selected checks are explicit requirements and settings snapshots survive updates and restart',async t=>{
  const f=await fixture(t),p=await f.projectWorkspaces.save(f.input),w=await f.start(p,['Tests']);const plan=await f.wait(w.id,'plan_review');assert.equal(plan.operations.length,0);assert.equal(plan.requirements.commands.length,1);assert.equal(plan.requirements.commands[0].outputIncludes,'pass 1');
  await f.projectWorkspaces.save({...p,folders:[f.outside],checks:[]});await f.workflows.close();await f.workflows.init();const saved=await f.workflows.read(w.id);assert.deepEqual(saved.project.folders,[f.folder]);assert.equal(saved.project.revision,1);assert.equal(saved.status,'plan_review');assert.equal((await f.store.list('actions')).length,0);
  await assert.rejects(f.projectWorkspaces.bind(p.id,2,['Tests']),/Select saved checks/);
});
test('no saved check is inherited by default and handoff alone never adds project settings',async t=>{
  const f=await fixture(t),p=await f.projectWorkspaces.save(f.input),w=await f.start(p);await f.wait(w.id,'plan_review');await f.workflows.control(w.id,'approve_plan','',1);const done=await f.wait(w.id,'completed');assert.deepEqual(done.requirements,{files:[],commands:[]});assert.deepEqual(done.project.checks,[]);
  const d=await f.workflows.handoffs.draft(w.id);assert.equal(d.project,p.notePath);const h=await f.workflows.handoffs.save({sourceId:w.id,handoffId:d.id,draftRevision:d.draftRevision,title:d.title,body:d.body,project:d.project});
  const child=await f.workflows.start({goal:'Inspect current state',handoffId:h.id,handoffRevision:h.revision});const childPlan=await f.wait(child.id,'plan_review');assert.equal(childPlan.project,undefined);assert.deepEqual(childPlan.requirements,{files:[],commands:[]});
  const dashboard=await f.projectWorkspaces.dashboard(p.id,f.workflows.handoffs);assert.equal(dashboard.tasks.length,1);assert.equal(dashboard.tasks[0].children[0].id,child.id);assert.equal(dashboard.handoffs[0].id,h.id);
});
test('project folder boundaries reject sibling prefixes, symlink escapes and changed roots',async t=>{
  const f=await fixture(t),p=await f.projectWorkspaces.save(f.input);await mkdir(join(f.dir,'project-copy'));await symlink(f.outside,join(f.folder,'escape'));
  await assert.rejects(f.projectWorkspaces.target(p,join(f.dir,'project-copy')),/outside/);await assert.rejects(f.projectWorkspaces.target(p,join(f.folder,'escape','other.txt')),/outside/);
  await rename(f.folder,f.folder+'-old');await symlink(f.outside,f.folder);await assert.rejects(f.projectWorkspaces.bind(p.id,p.revision,[]),/paths changed/);await assert.rejects(f.projectWorkspaces.target(p,join(f.folder,'other.txt')),/folder changed/);
});
test('out-of-project requirements, read tools, writes and command cwd cannot bypass saved folders',async t=>{
  const f=await fixture(t),p=await f.projectWorkspaces.save(f.input);
  await assert.rejects(f.workflows.start({goal:'Invalid target',projectId:p.id,projectRevision:p.revision,projectCheckNames:[],requirements:{files:[{path:join(f.outside,'other.txt'),lineEndings:'any',finalNewline:'any'}],commands:[]}}),/outside/);
  f.setReply(c=>c.recentEvidence.length?call('ask_user',{question:'Choose the intended project.'}):call('read_system_file',{path:join(f.outside,'other.txt')}));const w=await f.start(p);await f.wait(w.id,'plan_review');await f.workflows.control(w.id,'approve_plan','',1);const paused=await f.wait(w.id,'waiting_input');assert.match(paused.operations[0].result.error,/outside/);
  const {name,...command}=f.input.checks[0];await assert.rejects(f.workflows.updateRequirements(w.id,{revision:1,requirements:{files:[],commands:[{...command,cwd:f.outside}]}}),/outside/);
  // Test the real proposal path while the task is in a valid execution state.
  const raw=await f.store.get('workflows',w.id);raw.status='running';await f.workflows.save(raw);
  await assert.rejects(f.actions.propose('write',{path:join(f.outside,'other.txt'),content:'bad'},null,null,{id:w.id,revision:1}),/outside/);
  await assert.rejects(f.actions.propose('command',{program:'node',args:['--version'],cwd:f.outside},null,null,{id:w.id,revision:1}),/outside/);assert.equal((await f.store.list('actions')).length,0);
});
test('saved checks run through real approvals, verify output and preserve a paused task across restart',async t=>{
  const f=await fixture(t);await writeFile(join(f.folder,'one.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';test('content',async()=>assert.equal(await readFile('one.txt','utf8'),'one\\n'));\n");
  f.setReply(c=>{const ops=c.recentEvidence.map(JSON.parse),last=ops.at(-1);if(!last)return call('propose_command',c.outputRequirements.commands[0]);if(last.name==='propose_command')return call('verify_outcome',{evidence:c.evidenceForCompletion.find(o=>o.name==='propose_command').id,kind:'command_output',expected:'pass 1'});return call('finish_step',{summary:'Saved check passed.',evidence:c.evidenceForCompletion.map(o=>o.id)});});
  const p=await f.projectWorkspaces.save(f.input),w=await f.start(p,['Tests']);await f.wait(w.id,'plan_review');await f.workflows.control(w.id,'approve_plan','',1);await f.wait(w.id,'waiting_approval');const action=(await f.store.list('actions'))[0];await f.workflows.control(w.id,'pause');await f.workflows.close();await f.workflows.init();assert.equal((await f.workflows.read(w.id)).status,'paused');await assert.rejects(f.actions.decide(action.id,'approve',action.digest),/Resume/);await f.workflows.control(w.id,'resume');await f.actions.decide(action.id,'approve',action.digest);const done=await f.wait(w.id,'completed');assert(done.requirementChecks.every(x=>x.passed));assert.equal((await f.store.list('actions')).length,1);assert.equal((await f.projectWorkspaces.dashboard(p.id,f.workflows.handoffs)).tasks[0].result,done.result);
});
test('project APIs require authenticated changes and expose saved settings/history',async t=>{
  const f=await fixture(t);await new Promise(r=>f.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+f.server.address().port;
  const post=token=>fetch(origin+'/api/project-workspace',{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-Aster-Token':token}:{})},body:JSON.stringify(f.input)});
  assert.equal((await post()).status,403);const {token}=await (await fetch(origin+'/api/bootstrap')).json();const response=await post(token);assert.equal(response.status,200);const saved=await response.json();assert.equal((await (await fetch(origin+'/api/project-workspaces')).json())[0].id,saved.id);const d=await (await fetch(origin+'/api/project-workspace?id='+saved.id)).json();assert.deepEqual(d.tasks,[]);assert.deepEqual(d.handoffs,[]);
});

test('a pending project action rechecks canonical folders at approval time',async t=>{
  const f=await fixture(t),p=await f.projectWorkspaces.save(f.input);f.setReply(()=>call('propose_file_edit',{path:f.file,content:'updated\n',reason:'Fixture update'}));
  const w=await f.start(p);await f.wait(w.id,'plan_review');await f.workflows.control(w.id,'approve_plan','',1);await f.wait(w.id,'waiting_approval');const a=(await f.store.list('actions'))[0];
  await rename(f.folder,f.folder+'-original');await symlink(f.outside,f.folder);await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/folder changed/);assert.equal((await f.store.get('actions',a.id)).status,'pending');assert.equal(await readFile(join(f.folder+'-original','one.txt'),'utf8'),'one\n');assert.equal((await f.store.list('actions')).length,1);
});
