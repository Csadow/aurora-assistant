import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Vault} from '../src/vault.mjs';
import {MobileTransfers} from '../src/mobile-transfers.mjs';
import {createApp} from '../src/server.mjs';
import {taskLine,schedule} from '../src/task-meta.mjs';
import {emptyState,saveNote,exportBundle,readBundle,importBundle} from '../mobile/web/core.js';
import {mobileTasks,editTaskContent,suggestDay,agenda,currentTask,TASK_PATH,localDay} from '../mobile/web/planner-core.js';
function stateWith(...items){const s=emptyState();saveNote(s,TASK_PATH,'# Tasks\n'+items.map(([text,opts])=>'- [ ] '+taskLine(text,opts)).join('\n'),null);return s;}
const opts={date:'2026-10-20',start:'09:00',end:'12:00',gap:10,now:new Date(2026,9,19,10)};
test('planner validates dates, duration, priority, and within-day blocks',()=>{
  for(const fields of [{planDate:'2026-02-30'},{startTime:'09:00'},{planDate:'2026-10-20',startTime:'24:00'},{duration:0},{duration:30.5},{priority:'urgent'},{planDate:'2026-10-20',startTime:'23:50',duration:30}])assert.throws(()=>schedule(fields));
  assert.equal(schedule({due:'2026-10-25',planDate:'2026-10-20',startTime:'23:30'}).due,'2026-10-25');
});
test('mobile completion and scheduling survive backup without losing baseline or reminder',()=>{
  const s=stateWith(['Study',{due:'2026-10-25',remindAt:'2026-10-20T10:00:00Z'}]),n=s.notes[0];n.desktop={exportId:crypto.randomUUID(),revision:'a'.repeat(64)};
  const t=mobileTasks(s)[0];saveNote(s,n.path,editTaskContent(n,t,{planDate:'2026-10-20',startTime:'09:00',duration:45,priority:'high'}),n.revision);
  const next=mobileTasks(s)[0];assert.equal(next.id,t.id);assert.equal(next.due,t.due);assert.equal(next.remindAt,t.remindAt);
  saveNote(s,n.path,editTaskContent(s.notes[0],next,{done:true}),s.notes[0].revision);
  const restored=emptyState();importBundle(restored,readBundle(exportBundle(s)));
  assert.equal(mobileTasks(restored)[0].done,true);assert.equal(mobileTasks(restored)[0].startTime,'09:00');assert.deepEqual(restored.notes[0].desktop,n.desktop);
});
test('legacy tasks and frontmatter exclusions use the same parser on mobile',()=>{
  const s=stateWith(['Keep',{}]);saveNote(s,'Old.md','---\nstatus: "archived"\n---\n- [ ] Hidden',null);saveNote(s,'Draft.md',"---\nstatus: 'draft'\n---\n- [ ] Hidden",null);saveNote(s,'Examples.md','~~~md\n- [ ] Example\n~~~\n- [ ] Legacy',null);
  assert.deepEqual(mobileTasks(s).map(t=>t.text),['Keep','Legacy']);assert.equal(mobileTasks(s)[1].duration,30);
});
test('suggestions preserve fixed blocks, add breaks, prioritize deadlines, and never mutate tasks',()=>{
  const s=stateWith(['Normal',{}],['High',{priority:'high',duration:45}],['Due',{due:'2026-10-19'}],['Meeting',{planDate:opts.date,startTime:'10:00',duration:60}]);
  const tasks=mobileTasks(s),before=structuredClone(tasks),result=suggestDay(tasks,opts);
  assert.deepEqual(result.proposed.map(p=>[p.task.text,p.changes.startTime]),[['Due','09:00'],['High','11:10']]);assert.equal(result.unplaced[0].text,'Normal');assert.deepEqual(tasks,before);
});
test('suggestions do not move other days, missed blocks, or completed tasks',()=>{
  const s=stateWith(['Missed',{planDate:'2026-10-18',startTime:'09:00'}],['Future',{planDate:'2026-10-21'}],['Today',{planDate:opts.date}]);
  const tasks=mobileTasks(s);tasks.push({...tasks[2],id:crypto.randomUUID(),line:tasks[2].line+1,text:'Done',done:true});const p=suggestDay(tasks,opts);assert.deepEqual(p.proposed.map(x=>x.task.text),['Today']);assert.equal(agenda(tasks,opts.date).missed.length,1);
});
test('today suggestions start after now and cannot fit beyond the end',()=>{
  const now=new Date(2026,9,20,11,40),tasks=mobileTasks(stateWith(['Work',{}]));
  assert.equal(suggestDay(tasks,{...opts,date:localDay(now),now}).unplaced.length,1);
  assert.equal(suggestDay(tasks,{...opts,date:localDay(now),end:'13:00',now}).proposed[0].changes.startTime,'11:45');
  assert.throws(()=>suggestDay(tasks,{...opts,date:'2026-10-18'}),/today/);
});
test('overlaps and invalid metadata block suggestions without hidden repair',()=>{
  const tasks=mobileTasks(stateWith(['One',{planDate:opts.date,startTime:'09:00',duration:120}],['Two',{planDate:opts.date,startTime:'10:00'}]));
  assert.equal(agenda(tasks,opts.date).conflicts.length,1);assert.throws(()=>suggestDay(tasks,opts),/overlapping/);
  assert.throws(()=>suggestDay([{...tasks[0],scheduleError:true}],opts),/invalid/);
  assert.throws(()=>suggestDay([],{...opts,end:'08:00'}),/after/);
});
test('stale task edits reject while unrelated line movement preserves identity',()=>{
  const s=stateWith(['First',{}],['Second',{}]),t=mobileTasks(s)[1];
  const n=s.notes[0];saveNote(s,n.path,'Extra heading\n'+n.content,n.revision);
  assert.equal(currentTask(mobileTasks(s),t).line,t.line+1);
  const moved=mobileTasks(s)[1];saveNote(s,n.path,editTaskContent(s.notes[0],moved,{text:'Changed'}),s.notes[0].revision);
  assert.throws(()=>editTaskContent(s.notes[0],t,{done:true}),/changed/);
});
test('duplicate task IDs fail closed instead of completing the wrong task',()=>{
  const s=stateWith(['One',{}]),t=mobileTasks(s)[0];s.notes[0].content+='\n- [ ] '+taskLine('Another',{},t.id);
  assert.throws(()=>currentTask(mobileTasks(s),t),/changed/);
});
test('desktop reminder changes preserve planner fields and reject stale revisions',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-planner-'));t.after(()=>rm(dir,{recursive:true,force:true}));const vault=new Vault(dir);await vault.init();
  await vault.addTask('Study',{planDate:opts.date,startTime:'09:00',duration:50,priority:'high'});
  const original=(await vault.tasks())[0];await vault.scheduleTask({path:original.path,line:original.line,revision:original.revision,due:'2026-10-22',remindAt:'2026-10-20T04:00:00Z'});
  const next=(await vault.tasks())[0];assert.equal(next.startTime,'09:00');assert.equal(next.duration,50);assert.equal(next.priority,'high');
  await assert.rejects(vault.scheduleTask({...original,text:'stale'}),e=>e.status===409);
  await vault.scheduleTask({...next,text:'Study chapter',startTime:null,planDate:null});const changed=(await vault.tasks())[0];assert.equal(changed.text,'Study chapter');assert.equal(changed.remindAt,next.remindAt);
});
test('reviewed phone transfer returns a scheduled task and completion to the desktop vault',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-planner-transfer-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const vault=new Vault(join(dir,'vault'));await vault.init();await vault.addTask('Take a walk');
  const transfer=new MobileTransfers({vault,data:join(dir,'data')}),out=await transfer.export([TASK_PATH]),phone=emptyState();
  importBundle(phone,readBundle(JSON.stringify(out.bundle)));
  const task=mobileTasks(phone)[0],note=phone.notes[0];saveNote(phone,note.path,editTaskContent(note,task,{planDate:opts.date,startTime:'17:00',done:true}),note.revision);
  const review=await transfer.prepare(exportBundle(phone));assert.equal(review.rows[0].kind,'update');
  assert.equal((await vault.tasks())[0].done,false);
  await transfer.decide({id:review.id,rowId:review.rows[0].id,digest:review.digest,choice:'save'});
  const saved=(await vault.tasks())[0];assert.equal(saved.done,true);assert.equal(saved.startTime,'17:00');assert.equal(saved.id,task.id);
});
test('planner HTTP API persists metadata, reports invalid values, and uses existing request protection',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-planner-api-'));
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),projects:[],ollamaClient:{status:async()=>({online:false,models:[]})}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`,token=(await(await fetch(base+'/api/bootstrap')).json()).token;
  const post=(path,data,auth=true)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Aster-Token':token}:{})},body:JSON.stringify(data)});
  assert.equal((await post('/api/tasks',{text:'Not saved'},false)).status,403);
  assert.equal((await post('/api/tasks',{text:'Study',planDate:opts.date,startTime:'09:00',duration:45,priority:'high'})).status,200);
  const task=(await app.vault.tasks())[0];assert.equal(task.duration,45);
  assert.equal((await post('/api/task-schedule',{...task,duration:-1})).status,400);
  assert.equal((await post('/api/task-schedule',{...task,text:'Study chapter',startTime:'10:00'})).status,200);
  assert.equal((await post('/api/task-schedule',{...task,startTime:'11:00'})).status,409);
  const overview=await(await fetch(base+'/api/overview')).json();assert.equal(overview.unscheduled.length,0);
  for(const file of ['/planner.js','/planner-core.js','/tasks.js'])assert.equal((await fetch(base+file)).status,200);
});
