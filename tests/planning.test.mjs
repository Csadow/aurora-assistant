import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Vault,markdown} from '../src/vault.mjs';
import {Settings} from '../src/settings.mjs';
import {Reminders} from '../src/reminders.mjs';
import {overview} from '../src/overview.mjs';
import {schedule,taskLine} from '../src/task-meta.mjs';
import {ReminderNotifier} from '../desktop/reminders.mjs';
import {createApp} from '../src/server.mjs';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'aster-planning-'));t.after(()=>rm(dir,{recursive:true,force:true}));const vault=new Vault(join(dir,'vault'));await vault.init();const settings=new Settings(join(dir,'data'));await settings.init();const clock={now:Date.parse('2026-10-01T05:00:00Z')};const options={vault,data:join(dir,'data'),settings,now:()=>clock.now};return {dir,vault,settings,clock,options,reminders:new Reminders(options)};}
test('task deadlines and reminders remain portable Markdown with stable IDs and optimistic saves',async t=>{
  const f=await fixture(t);await f.vault.addTask('Study Linux',{due:'2026-10-01',remindAt:'2026-10-01T09:30:00+05:00'});const task=(await f.vault.tasks())[0];assert.equal(task.text,'Study Linux');assert.equal(task.remindAt,'2026-10-01T04:30:00.000Z');assert(task.id);assert.match(await readFile(join(f.vault.root,task.path),'utf8'),/- \[ \] Study Linux <!-- aster-task:/);
  await f.vault.scheduleTask({...task,due:'2026-10-02',remindAt:null});const changed=(await f.vault.tasks())[0];assert.equal(changed.id,task.id);assert.equal(changed.due,'2026-10-02');assert.equal(changed.remindAt,null);await assert.rejects(f.vault.scheduleTask({...task,due:'2026-10-03'}),e=>e.status===409);
  await f.vault.toggleTask(changed.path,changed.line,changed.revision,true);assert((await f.vault.tasks())[0].done);
});
test('task parser ignores code examples and unsafe or malformed scheduling metadata',async t=>{
  const f=await fixture(t);const line=taskLine('Example',{remindAt:'2026-10-01T04:00:00Z'});
  await f.vault.save('30 Knowledge/Examples.md',markdown('Examples','```md\n- [ ] '+line+'\n```\n- [ ] Actual task\n- [ ] Broken <!-- aster-task:{"id":"bad","remindAt":"now"} -->'),null);
  const tasks=await f.vault.tasks();assert.equal(tasks.length,2);assert(tasks.find(t=>t.scheduleError));assert(tasks.every(t=>!t.remindAt));
  for(const input of [{due:'2026-02-30'},{remindAt:'2026-10-01T09:00'},{remindAt:'2026-02-30T09:00:00Z'},{due:42}])assert.throws(()=>schedule(input));
  await assert.rejects(f.vault.addTask('Inject <!-- aster-task:{} -->'),/metadata/);
});
test('adding a task recovers a deleted task list without recreating unrelated starter notes',async t=>{
  const f=await fixture(t),note=await f.vault.read('40 Tasks/Tasks.md');await f.vault.trash(note.path,note.revision);await f.vault.addTask('Start again');assert.equal((await f.vault.tasks())[0].text,'Start again');
});
test('daily overview uses Atyrau date boundaries and excludes archived and journal tasks',async t=>{
  const f=await fixture(t);await f.vault.addTask('Overdue',{due:'2026-09-30'});await f.vault.addTask('Due today',{due:'2026-10-01'});await f.vault.addTask('Midnight reminder',{remindAt:'2026-09-30T19:30:00Z'});await f.vault.addTask('Tomorrow',{due:'2026-10-02'});await f.vault.addTask('Unscheduled');await f.vault.save('90 Journal/Example.md',markdown('Journal','- [ ] Never a task',{status:'journal'}),null);await f.vault.save('20 Projects/Old.md',markdown('Old project','Obsolete',{status:'archived'}),null);
  const report=await overview({vault:f.vault,settings:f.settings,now:Date.parse('2026-09-30T20:00:00Z')});assert.equal(report.date,'2026-10-01');assert.equal(report.counts.overdue,1);assert.equal(report.counts.dueToday,2);assert.equal(report.counts.open,5);assert.equal(report.upcoming.length,1);assert(!report.projects.some(n=>n.title==='Old project'));
});
test('due reminders are leased once, acknowledged durably, and not replayed on restart',async t=>{
  const f=await fixture(t);await f.vault.addTask('Due now',{remindAt:'2026-10-01T04:00:00Z'});await f.vault.addTask('Later',{remindAt:'2026-10-02T04:00:00Z'});const [a,b]=await Promise.all([f.reminders.claim(),f.reminders.claim()]);assert.equal(a.delivery.count,1);assert.equal(b.delivery,null);await f.reminders.acknowledge(a.delivery.id);const restarted=new Reminders(f.options);assert.equal((await restarted.claim()).delivery,null);await assert.rejects(restarted.acknowledge(a.delivery.id),e=>e.status===409);
});
test('failed reminder delivery retries after lease expiry and completed tasks cancel pending notifications',async t=>{
  const f=await fixture(t);await f.vault.addTask('Catch up',{remindAt:'2026-09-01T04:00:00Z'});const first=await f.reminders.claim();assert(first.delivery);f.clock.now+=61000;const next=await new Reminders(f.options).claim();assert(next.delivery);assert.notEqual(first.delivery.id,next.delivery.id);await assert.rejects(f.reminders.acknowledge(first.delivery.id),e=>e.status===409);
  const task=(await f.vault.tasks())[0];await f.vault.toggleTask(task.path,task.line,task.revision,true);f.clock.now+=61000;assert.equal((await f.reminders.claim()).delivery,null);
});
test('reminder pause preserves tasks and rescheduling creates a fresh notification',async t=>{
  const f=await fixture(t);await f.vault.addTask('Reschedule',{remindAt:'2026-10-01T04:00:00Z'});await f.settings.save({remindersEnabled:false});assert.equal((await f.reminders.claim()).delivery,null);await f.settings.save({remindersEnabled:true});const first=await f.reminders.claim();await f.reminders.acknowledge(first.delivery.id);
  const task=(await f.vault.tasks())[0];await f.vault.scheduleTask({...task,remindAt:'2026-10-01T04:30:00Z'});assert((await f.reminders.claim()).delivery);assert.equal((await f.vault.tasks()).length,1);
});
test('invalid reminder history fails closed rather than notifying every task again',async t=>{
  const f=await fixture(t);await f.settings.save({});await writeFile(f.reminders.path,'invalid JSON');await assert.rejects(f.reminders.claim(),e=>e.status===503);
});
test('native notifier acknowledges only shown notifications and leaves failures retryable',async()=>{
  const calls=[],errors=[];let fail=true;const notifier=new ReminderNotifier({origin:'http://127.0.0.1:1234',fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('bootstrap')?{token:'fixture'}:url.endsWith('poll')?{delivery:{id:'one',count:1,items:[{text:'Task'}]}}:{recorded:true});},notify:async()=>{if(fail)throw new Error('Desktop unavailable');},onError:e=>errors.push(e)});notifier.running=true;
  await notifier.tick();assert.equal(calls.filter(c=>c.url.endsWith('ack')).length,0);assert.equal(errors.length,1);fail=false;await notifier.tick();assert.equal(calls.filter(c=>c.url.endsWith('ack')).length,1);assert.equal(calls.find(c=>c.url.endsWith('ack')).options.headers['X-Aster-Token'],'fixture');notifier.stop();
});
test('task proposals preserve reviewed deadlines but schedule nothing before acceptance',async t=>{
  const f=await fixture(t),app=await createApp({vault:f.vault.root,data:join(f.dir,'app'),projects:[],embedding:'',ollamaClient:{}}),conversation=await app.store.conversation();
  const proposal=await app.assistant.runTool({function:{name:'propose_task',arguments:{text:'Read chapter',due:'2026-10-02',remindAt:'2026-10-02T09:00:00+05:00'}}},conversation.id);assert.equal((await app.vault.tasks()).length,0);assert.equal(proposal.remindAt,'2026-10-02T04:00:00.000Z');await app.assistant.acceptProposal(proposal.id,'accept');const task=(await app.vault.tasks())[0];assert.equal(task.due,proposal.due);assert.equal(task.remindAt,proposal.remindAt);
});

test('reminders for future deadlines appear today and overdue reminders stay visible without inventing a missed deadline',async t=>{
  const f=await fixture(t);await f.vault.addTask('Prepare ahead',{due:'2026-11-01',remindAt:'2026-10-01T04:00:00Z'});await f.vault.addTask('Missed reminder',{remindAt:'2026-09-01T04:00:00Z'});const report=await overview({vault:f.vault,settings:f.settings,now:f.clock.now});assert.equal(report.today.length,2);assert.equal(report.overdue.length,0);assert.equal(report.upcoming.length,0);
});
