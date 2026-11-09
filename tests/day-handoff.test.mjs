import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {taskLine} from '../src/task-meta.mjs';
import {dayHandoff} from '../src/day-handoff.mjs';
import {dayHandoffHTML,eveningShortlist} from '../public/day-handoff.js';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-handoff-'));let calls=0;
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],ollamaClient:{status:async()=>({online:false}),chat:async()=>{calls++;throw Error('No inference expected');}},workflowOptions:{pollMs:60000}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await app.workflows.close();app.calendar.close();app.recurring.stop();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 const day=app.dayPlanning,clock={now:new Date(2093,4,12,18)},history=day.dailyFocus.history;day.now=()=>clock.now;history.now=()=>clock.now.toISOString();
 const ids=[randomUUID(),randomUUID(),randomUUID()];for(let i=0;i<3;i++)await app.vault.save('40 Tasks/Handoff '+i+'.md','- [ ] '+taskLine('Handoff '+i,{planDate:'2093-05-12',startTime:i===2?'20:00':'09:00',duration:30},ids[i]),null);
 const report=()=>dayHandoff(day,'2093-05-12');
 const plan=async()=>day.eveningPreview({date:'2093-05-12',choices:(await day.evening('2093-05-12')).unfinished.filter(t=>ids.slice(0,2).includes(t.id)).map(task=>({task,action:'move',date:'2093-05-13'}))});
 const checkin=async()=>{const r=await day.candidates();return day.checkins.create({requestId:randomUUID(),date:r.date,timezone:r.timezone,kind:'interruption',note:'Class ran late <img src=x>',selected:[],start:'18:00',end:'23:00',gap:10});};
 return {app,day,clock,history,ids,report,plan,checkin,get calls(){return calls;}};
}
test('handoff counts only elapsed unfinished reservations and reads the previous date across midnight without effects',async t=>{
 const f=await fixture(t),notes=await f.app.vault.list(),history=await f.history.read(),focus=await f.day.dailyFocus.read();assert.equal((await f.report()).reservationCount,2);
 f.clock.now=new Date(2093,4,13,8);const r=await dayHandoff(f.day);assert.equal(r.date,'2093-05-12');assert.equal(r.reservationCount,3);assert.deepEqual(await f.app.vault.list(),notes);assert.deepEqual(await f.history.read(),history);assert.deepEqual(await f.day.dailyFocus.read(),focus);assert.equal(f.calls,0);
});
test('preview, partial save and dismissed remainder preserve actual receipts and current state separately',async t=>{
 const f=await fixture(t),p=await f.plan();assert.equal((await f.report()).decisions[0].recorded,0);
 const save=f.app.vault.save.bind(f.app.vault);let n=0;f.app.vault.save=async(...a)=>{if(++n===2)throw Error('Interrupted save');return save(...a);};await assert.rejects(f.day.decide(p.id,'accept'));f.app.vault.save=save;
 let r=await f.report();assert.equal(r.decisions[0].recorded,1);assert.equal(r.decisions[0].status,'pending');assert.equal(r.decisions[0].rows.filter(r=>r.saved).length,1);assert.equal(r.decisions[0].rows.find(r=>r.saved).changed,false);
 await f.day.decide(p.id,'dismiss');r=await f.report();assert.equal(r.decisions[0].status,'dismissed');assert.equal(r.decisions[0].recorded,1);
 const task=(await f.app.vault.tasks()).find(t=>t.id===r.decisions[0].rows.find(r=>r.saved).taskId);await f.app.vault.scheduleTask({...task,duration:45});r=await f.report();assert(r.decisions[0].rows.find(r=>r.saved).changed);assert.equal(r.decisions[0].rows.find(r=>r.saved).saved.after.duration,30);
});
test('reviewed interruption notes remain in the next morning handoff without reopening their decisions',async t=>{
 const f=await fixture(t),entry=await f.checkin();await f.day.checkins.decide({requestId:randomUUID(),id:entry.id,revision:entry.revision,status:'reviewed'});f.clock.now=new Date(2093,4,13,8);const state=await f.day.checkins.read(),r=await dayHandoff(f.day);assert.equal(r.checkins[0].note,entry.note);assert.equal(r.checkins[0].status,'reviewed');assert.deepEqual(await f.day.checkins.read(),state);assert.equal((await f.day.briefing()).handoff.checkins[0].id,entry.id);
});
test('unavailable history does not claim zero saves and damaged check-ins do not hide independent decisions',async t=>{
 const f=await fixture(t);await f.plan();await f.checkin();const read=f.history.read.bind(f.history);f.history.read=async()=>{throw Error('History unavailable');};let r=await f.report();assert.equal(r.decisions[0].recorded,null);assert.equal(r.historyAvailable,false);assert.equal(r.checkins.length,1);f.history.read=read;
 await writeFile(f.day.checkins.path,'broken check-ins');r=await f.report();assert.equal(r.checkins,null);assert.equal(r.decisions.length,1);assert.equal(await readFile(f.day.checkins.path,'utf8'),'broken check-ins');
});
test('missing tasks and duplicate identities keep saved evidence without selecting a current task',async t=>{
 const f=await fixture(t);await f.day.decide((await f.plan()).id,'accept');let r=await f.report();const id=r.decisions[0].rows[0].taskId,task=(await f.app.vault.tasks()).find(t=>t.id===id);await f.app.vault.save('40 Tasks/Duplicate.md','- [ ] '+taskLine('Duplicate',{},id),null);r=await f.report();assert.equal(r.decisions[0].rows[0].current,null);assert(r.decisions[0].rows[0].saved);const n=await f.app.vault.read(task.path);await f.app.vault.trash(n.path,n.revision);const copy=await f.app.vault.read('40 Tasks/Duplicate.md');await f.app.vault.trash(copy.path,copy.revision);assert.equal((await f.report()).decisions[0].rows[0].current,null);
});
test('unreconciled saves remain unknown until explicit recovery and retain recovered provenance',async t=>{
 const f=await fixture(t),p=await f.plan(),committed=f.history.committed.bind(f.history);f.history.committed=async()=>{throw Error('Lost history confirmation');};await assert.rejects(f.day.decide(p.id,'accept'));f.history.committed=committed;
 let r=await f.report();assert.equal(r.decisions[0].recorded,0);assert(r.warnings.some(w=>w.includes('reconciliation')));const before=await f.history.read();await f.report();assert.deepEqual(await f.history.read(),before);
 await f.history.report();r=await f.report();assert.equal(r.decisions[0].recorded,1);assert.equal(r.decisions[0].rows.find(r=>r.saved).saved.source,'recovered_save');
});
test('damaged decision rows do not hide check-ins or current reservations',async t=>{
 const f=await fixture(t);await f.checkin();const p=await f.plan(),raw=await f.app.store.get('proposals',p.id);await f.app.store.put('proposals',{...raw,changes:null});const r=await f.report();assert.equal(r.decisions,null);assert.equal(r.checkins.length,1);assert.equal(r.reservationCount,2);assert.equal((await f.app.store.get('proposals',p.id)).changes,null);await f.app.store.put('proposals',{...raw,created:'bad date'});assert.equal((await f.report()).decisions,null);
});
test('handoff GET and static module are read-only; invalid dates and unauthenticated writes are rejected',async t=>{
 const f=await fixture(t);await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.app.server.address().port;
 assert.equal((await fetch(base+'/api/day-handoff?date=2093-05-12')).status,200);assert.equal((await fetch(base+'/day-handoff.js')).status,200);
 for(const date of ['2093-05-14','2093-02-30','garbage'])assert.equal((await fetch(base+'/api/day-handoff?date='+date)).status,400);
 assert.equal((await fetch(base+'/api/day-handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);assert.equal(f.calls,0);
});
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
test('handoff escapes notes and differentiates unavailable sources; unrelated shortlist dates remain explicit',async t=>{
 const f=await fixture(t);await f.checkin();const r=await f.report(),html=dayHandoffHTML(r,null,escape);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);assert.match(dayHandoffHTML({...r,checkins:null,decisions:null},null,escape),/could not be loaded/);
 const raw='broken shortlist';assert.match(await eveningShortlist({api:()=>assert.fail(),vault:'/fixture',storage:{getItem:()=>raw},date:r.date,escape}),/cannot be read/);
});
