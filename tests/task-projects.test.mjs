import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Vault,parseNote} from '../src/vault.mjs';
import {Store} from '../src/store.mjs';
import {TaskHistory} from '../src/task-history.mjs';
import {taskLine,tasksIn,schedule} from '../src/task-meta.mjs';
import {TaskProjects,projectContext} from '../src/task-projects.mjs';
import {taskGraph,taskRef} from '../mobile/web/task-links.js';
import {suggestDay,taskSignature} from '../mobile/web/planner-core.js';
import {DayPlanning} from '../src/day-planning.mjs';
import {TaskProposals} from '../src/task-proposals.mjs';
const date='2026-10-12',now=()=>new Date(date+'T08:00:00'),project='20 Projects/Research.md';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'aurora-project-tasks-'));t.after(()=>rm(dir,{recursive:true,force:true}));const vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data'));await vault.init();await store.init();const history=new TaskHistory({vault,data:join(dir,'data')});await history.init();await vault.save(project,'# Research\n\nUse the field notes to draft a report.\n',null);return {vault,store,history,projects:new TaskProjects({vault}),get:async text=>(await vault.tasks()).find(t=>t.text===text)};}
test('optional links round-trip, ordinary task format stays compatible, malformed references fail closed',()=>{
 const id=crypto.randomUUID(),meta={project,parent:id,dependsOn:[id]};assert.deepEqual(schedule(meta),{...schedule(),...meta});assert.equal(tasksIn([{path:'40 Tasks/T.md',content:'- [ ] '+taskLine('Task',meta)}])[0].parent,id);
 for(const p of ['/root/a.md','../a.md','20 Projects/.secret.md','20 Projects\\a.md'])assert.throws(()=>schedule({project:p}));assert.throws(()=>schedule({parent:'bad'}));assert.throws(()=>schedule({dependsOn:[id,id]}));
 assert.notEqual(taskSignature({id}),taskSignature({id,project}));assert.notEqual(taskSignature({id}),taskSignature({id,dependsOn:[id]}));
});
test('project changes and independent subtask creation preserve parent state and inherit only its project',async t=>{
 const f=await fixture(t);await f.vault.addTask('Parent',{project,planDate:date,due:date});let parent=await f.get('Parent');await f.projects.subtask({task:parent,text:'Child',duration:20});const child=await f.get('Child');assert.equal(child.project,project);assert.equal(child.parent,parent.id);assert.equal(child.planDate,null);assert.equal(child.due,null);
 parent=await f.get('Parent');await f.vault.toggleTask(parent.path,parent.line,parent.revision,true);assert.equal((await f.get('Child')).done,false);
 const report=await f.projects.report();assert.equal(report.tasks.find(t=>t.id===parent.id).links.children.length,1);assert.equal(report.tasks.find(t=>t.id===parent.id).links.completedChildren,0);
 const c=await f.get('Child');await f.vault.toggleTask(c.path,c.line,c.revision,true);parent=await f.get('Parent');await f.vault.toggleTask(parent.path,parent.line,parent.revision,false);assert.equal((await f.get('Child')).done,true);
});
test('only existing project notes can be linked and clearing a project preserves other fields',async t=>{
 const f=await fixture(t);await assert.rejects(f.vault.addTask('Bad',{project:'20 Projects/Gone.md'}),/missing/);await f.vault.addTask('Keep',{project,duration:45,due:date});await f.vault.scheduleTask({...await f.get('Keep'),project:null});const task=await f.get('Keep');assert.equal(task.project,undefined);assert.equal(task.duration,45);assert.equal(task.due,date);
});
test('parent and dependency cycles, self links and unknown IDs cannot be saved',async t=>{
 const f=await fixture(t);await f.vault.addTask('A');await f.vault.addTask('B');const a=await f.get('A'),b=await f.get('B');await f.vault.scheduleTask({...a,parent:b.id,dependsOn:[b.id]});
 await assert.rejects(f.vault.scheduleTask({...await f.get('B'),parent:a.id}),/cycle/);await assert.rejects(f.vault.scheduleTask({...await f.get('B'),dependsOn:[a.id]}),/cycle/);await assert.rejects(f.vault.scheduleTask({...await f.get('B'),parent:b.id}),/different/);await assert.rejects(f.vault.scheduleTask({...await f.get('B'),dependsOn:[crypto.randomUUID()]}),/existing/);
});
test('unfinished prerequisites block suggestions even when their own work blocks are planned',async t=>{
 const f=await fixture(t);await f.vault.addTask('Prepare',{planDate:date,startTime:'09:00'});await f.vault.addTask('Write',{dependsOn:[(await f.get('Prepare')).id]});let tasks=await f.vault.tasks(),r=suggestDay(tasks,{date,now:now()});assert.equal(r.proposed.length,0);assert.equal(r.blocked[0].task.text,'Write');
 const p=await f.get('Prepare');await f.vault.toggleTask(p.path,p.line,p.revision,true);r=suggestDay(await f.vault.tasks(),{date,now:now()});assert.equal(r.proposed[0].task.text,'Write');
});
test('missing and duplicate prerequisites remain blocked; externally introduced dependency cycles are visible',()=>{
 const a=crypto.randomUUID(),b=crypto.randomUUID(),rows=[{id:a,path:'a',line:0,dependsOn:[b]},{id:b,path:'b',line:0,dependsOn:[a]}];assert(taskGraph(rows).states.get(taskRef(rows[0])).reasons.some(x=>x.includes('cycle')));
 assert(taskGraph([{...rows[0],scheduleError:true}]).states.get(taskRef(rows[0])).reasons.some(x=>x.includes('Invalid task metadata')));
 assert(taskGraph(rows.slice(0,1)).states.get(taskRef(rows[0])).blocked);assert(taskGraph([...rows,{...rows[1],path:'copy',done:true}]).states.get(taskRef(rows[0])).reasons.some(x=>x.includes('ambiguous')));
});
test('automatic schedule save checks a prerequisite in another note again at commit time',async t=>{
 const f=await fixture(t),id=crypto.randomUUID();await f.vault.save('40 Tasks/Prereq.md','- [x] '+taskLine('Prepared',{},id)+'\n',null);await f.vault.addTask('Write',{dependsOn:[id]});const selected=await f.get('Write'),n=await f.vault.read('40 Tasks/Prereq.md');
 const originalSave=f.vault.save.bind(f.vault);f.vault.save=(path,content,revision,options)=>originalSave(path,content,revision,{...options,beforeCommit:async()=>{await writeFile(join(f.vault.root,n.path),n.content.replace('[x]','[ ]'));await options.beforeCommit();}});
 await assert.rejects(f.vault.scheduleTask({...selected,planDate:date,startTime:'12:00',requireReady:true}),/no longer ready/);assert.equal((await f.get('Write')).planDate,null);
});
test('blocked tasks may be manually completed without changing prerequisites',async t=>{
 const f=await fixture(t);await f.vault.addTask('Prepare');await f.vault.addTask('Write',{dependsOn:[(await f.get('Prepare')).id]});const tsk=await f.get('Write');await f.vault.toggleTask(tsk.path,tsk.line,tsk.revision,true);assert.equal((await f.get('Prepare')).done,false);
});
test('subtask creation rejects stale parent revisions and never duplicates on stale retry',async t=>{
 const f=await fixture(t);await f.vault.addTask('Parent',{project});const parent=await f.get('Parent');await f.projects.subtask({task:parent,text:'Child'});await assert.rejects(f.projects.subtask({task:parent,text:'Child'}),/changed/);assert.equal((await f.vault.tasks()).filter(t=>t.text==='Child').length,1);
});
test('day replan rejects blocked selections and preserves links on ready work',async t=>{
 const f=await fixture(t);await f.vault.addTask('Prepare');await f.vault.addTask('Write',{project,planDate:date,dependsOn:[(await f.get('Prepare')).id]});const dp=new DayPlanning({...f,now});assert((await dp.candidates()).tasks.find(t=>t.text==='Write').locked);await assert.rejects(dp.preview({selected:[await f.get('Write')]}),/prerequisites/);
 let p=await f.get('Prepare');await f.vault.toggleTask(p.path,p.line,p.revision,true);const draft=await dp.preview({selected:[await f.get('Write')]});await dp.decide(draft.id,'accept');assert.equal((await f.get('Write')).project,project);assert.deepEqual((await f.get('Write')).dependsOn,[p.id]);
});
test('task proposal preserves links, surfaces blocked conflicts and rejects stale readiness',async t=>{
 const f=await fixture(t);await f.vault.addTask('Prepare');await f.vault.addTask('Write',{project,dependsOn:[(await f.get('Prepare')).id]});const p=new TaskProposals(f),task=await f.get('Write');const draft=await p.propose({...task,changes:{planDate:date,startTime:'12:00'}},null,{update:true});assert(draft.review.conflicts.some(c=>c.kind==='dependency'));assert.equal(draft.review.after.project,project);
 let prepare=await f.get('Prepare');await f.vault.toggleTask(prepare.path,prepare.line,prepare.revision,true);await assert.rejects(p.decide(draft.id,'accept',{allowConflicts:true}),/changed/);
});
test('history records link changes without fabricating completion or changing existing baseline',async t=>{
 const f=await fixture(t);await f.vault.addTask('Task');let task=await f.get('Task');await f.vault.scheduleTask({...task,project});const r=await f.history.report();assert.deepEqual(r.events[0].kinds,['project_changed']);assert.equal((await f.history.report()).total,r.total);assert(!r.events.some(e=>e.kinds.includes('marked_complete')));
});
test('briefing includes only relevant explicit project links with bounded excerpts and source paths',async t=>{
 const f=await fixture(t);await f.vault.addTask('Read',{project,planDate:date});await f.vault.save('20 Projects/Unrelated.md','# Secret unrelated\nUNRELATED CONTEXT',null);const b=await new DayPlanning({...f,now}).briefing();assert.equal(b.projectContext.projects.length,1);assert.equal(b.projectContext.projects[0].path,project);assert.match(b.projectContext.projects[0].excerpt,/field notes/);assert.equal(b.projectContext.projects[0].ready[0].text,'Read');assert(!JSON.stringify(b.projectContext).includes('UNRELATED'));
 const n=await f.vault.read(project);await f.vault.save(project,'# Research\n\n'+('x'.repeat(1000)),n.revision);assert.equal(projectContext(await f.vault.list(),date).projects[0].excerpt.length,600);
});
test('missing or archived projects keep their task links and appear as unavailable context',async t=>{
 const f=await fixture(t);await f.vault.addTask('Read',{project,planDate:date});const n=await f.vault.read(project);await f.vault.trash(project,n.revision);const context=projectContext(await f.vault.list(),date);assert(context.projects[0].missing);assert.equal(context.projects[0].ready[0].project,project);
});
test('project context caps the number of projects without hiding the total',()=>{
 const notes=[];for(let i=0;i<6;i++){const path='20 Projects/'+i+'.md';notes.push(parseNote(path,'# Project '+i+'\nContext'),parseNote('40 Tasks/'+i+'.md','- [ ] '+taskLine('Today',{project:path,planDate:date})));}const c=projectContext(notes,date);assert.equal(c.total,6);assert.equal(c.projects.length,4);
});
test('project task endpoints require write authentication and expose no side effects on reads',async t=>{
 const {createApp}=await import('../src/server.mjs'),dir=await mkdtemp(join(tmpdir(),'aurora-project-task-api-'));
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),projects:[],ollamaClient:{status:async()=>({online:false,models:[]})}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,before=await app.vault.list();assert.equal((await fetch(base+'/api/task-projects')).status,200);assert.deepEqual(await app.vault.list(),before);assert.equal((await fetch(base+'/api/task-projects',{headers:{Origin:'https://untrusted.example'}})).status,403);
 await app.vault.addTask('Parent');const parent=(await app.vault.tasks())[0],token=(await(await fetch(base+'/api/bootstrap')).json()).token;
 const post=auth=>fetch(base+'/api/subtask',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Aster-Token':token}:{})},body:JSON.stringify({task:parent,text:'Child'})});
 assert.equal((await post(false)).status,403);assert.equal((await post(true)).status,200);assert.equal((await post(true)).status,409);assert.equal((await app.vault.tasks()).length,2);
 assert.equal((await fetch(base+'/task-links.js')).status,200);assert.equal((await fetch(base+'/task-projects.js')).status,200);
});
test('evening review preserves links and moves only the selected occurrence',async t=>{
 const f=await fixture(t);await f.vault.addTask('Parent',{project});const parent=await f.get('Parent');await f.projects.subtask({task:parent,text:'Child'});await f.vault.scheduleTask({...await f.get('Child'),planDate:date,dependsOn:[parent.id]});
 const dp=new DayPlanning({...f,now}),child=await f.get('Child'),p=await dp.eveningPreview({date,choices:[{task:child,action:'move',date:'2026-10-13'}]});await dp.decide(p.id,'accept');const next=await f.get('Child');assert.equal(next.project,project);assert.equal(next.parent,parent.id);assert.deepEqual(next.dependsOn,[parent.id]);assert.equal((await f.get('Parent')).done,false);
});
test('chat task tools draft linked subtasks without saving and review acceptance keeps requested relationships',async t=>{
 const f=await fixture(t);await f.vault.addTask('Parent',{project});const parent=await f.get('Parent'),p=new TaskProposals(f);
 const draft=await p.propose({text:'Draft child',project,parent:parent.id,dependsOn:[parent.id]});assert.equal((await f.vault.tasks()).length,1);assert.equal(draft.review.linkLabels[parent.id],'Parent');assert.equal(draft.status,'pending');await p.decide(draft.id,'accept');const child=await f.get('Draft child');assert.equal(child.project,project);assert.equal(child.parent,parent.id);assert.deepEqual(child.dependsOn,[parent.id]);assert.equal((await f.get('Parent')).done,false);
 await assert.rejects(p.propose({text:'Invalid child',parent:crypto.randomUUID()}),/existing/);
});
test('chat relationship changes reject cycles and deleted projects after a draft',async t=>{
 const f=await fixture(t);await f.vault.addTask('A');await f.vault.addTask('B',{parent:(await f.get('A')).id});const p=new TaskProposals(f);
 await assert.rejects(p.propose({...await f.get('A'),changes:{parent:(await f.get('B')).id}},null,{update:true}),/cycle/);
 const draft=await p.propose({...await f.get('A'),changes:{project}},null,{update:true}),n=await f.vault.read(project);await f.vault.trash(project,n.revision);await assert.rejects(p.decide(draft.id,'accept'),/missing/);
});
test('links, dependency state and subtask progress survive a new vault instance without history inflation',async t=>{
 const f=await fixture(t);await f.vault.addTask('Parent',{project});await f.projects.subtask({task:await f.get('Parent'),text:'Child'});const parent=await f.get('Parent');await f.vault.scheduleTask({...await f.get('Child'),dependsOn:[parent.id]});const before=await f.history.report();
 const vault=new Vault(f.vault.root);await vault.init();const report=await new TaskProjects({vault}).report(),child=report.tasks.find(t=>t.text==='Child');assert.equal(child.project,project);assert.equal(child.parent,parent.id);assert(child.links.blocked);assert.equal(report.tasks.find(t=>t.id===parent.id).links.children.length,1);assert.equal((await f.history.report()).total,before.total);
});
