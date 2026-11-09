import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {taskLine} from '../src/task-meta.mjs';
import {dayHandoff} from '../src/day-handoff.mjs';
import {handoffActionHTML,validHandoffSource} from '../public/handoff-action.js';
import {taskReturnState} from '../public/task-details.js';
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
const state=async f=>({notes:await f.app.vault.list(),focus:await f.day.dailyFocus.read(),steps:await f.day.firstSteps.read(),sessions:await f.day.focusSessions.read(),history:await f.history.read(),checkins:await f.day.checkins.read(),proposals:await f.app.store.list('proposals'),workflows:await f.app.store.list('workflows')});
const source=p=>({date:'2093-05-12',proposalId:p.id});
const detail=(f,p,id=f.ids[0])=>f.day.taskDetails.report(id,source(p));
async function prepared(t){const f=await fixture(t),p=await f.plan();await f.day.decide(p.id,'accept');await f.checkin();f.clock.now=new Date(2093,4,13,8);f.p=p;return f;}
async function step(f){const r=await f.day.dailyFocus.report(f.ids[0]),row=r.rows.find(r=>r.taskId===f.ids[0]);await f.day.dailyFocus.decide({requestId:randomUUID(),taskId:row.taskId,date:r.date,timezone:r.timezone,revision:r.revision,contextRevision:row.contextRevision,action:'focus'});await f.day.firstSteps.save({requestId:randomUUID(),taskId:row.taskId,revision:(await f.day.firstSteps.report(row.taskId)).revision,text:'Open just the first exercise <img>',mode:'manual',acknowledge:true});}
test('an evening task opens original decisions and day notes alongside current context without any writes',async t=>{
 const f=await prepared(t),before=await state(f),r=await detail(f,f.p),h=r.sections.handoff.data;
 assert.equal(h.row.before.planDate,'2093-05-12');assert.equal(h.row.proposed.planDate,'2093-05-13');assert.equal(h.row.saved.after.planDate,'2093-05-13');assert.match(h.checkins[0].note,/Class ran late/);assert.equal(r.sections.focus.data.choice,null);assert.equal(r.sections.steps.data.card,null);assert.deepEqual(await state(f),before);assert.equal(f.calls,0);
});
test('rescheduled and blocked work keeps the saved first-step wording and original decision',async t=>{
 const f=await prepared(t);await step(f);const task=(await f.app.vault.tasks()).find(t=>t.id===f.ids[0]);await f.app.vault.scheduleTask({...task,planDate:'2093-05-14',duration:45});
 let r=await detail(f,f.p);assert.equal(r.task.planDate,'2093-05-14');assert.equal(r.sections.handoff.data.row.saved.after.planDate,'2093-05-13');assert(r.sections.handoff.data.row.changed);assert(r.sections.steps.data.changed);assert.match(r.sections.steps.data.card.text,/first exercise/);
 const n=await f.app.vault.read(task.path);await f.app.vault.save(n.path,'- [ ] '+taskLine(task.text,{planDate:'2093-05-14',duration:45,dependsOn:[f.ids[2]]},task.id),n.revision);r=await detail(f,f.p);assert(r.sections.focus.data.dependencyReasons.length);assert(r.sections.schedule.data.dependencies.length);assert.equal(r.sections.sessions.data.total,0);
});
test('completed, missing and duplicate tasks retain their evidence without inferring completion from absence',async t=>{
 const f=await prepared(t);await step(f);let n=await f.app.vault.read('40 Tasks/Handoff 0.md');await f.app.vault.save(n.path,n.content.replace('- [ ]','- [x]'),n.revision);
 let r=await detail(f,f.p);assert(r.task.done);assert.equal(r.sections.focus.data.readiness,'complete');assert.equal(r.sections.steps.data.canSave,false);
 n=await f.app.vault.read(n.path);await f.app.vault.trash(n.path,n.revision);r=await detail(f,f.p);assert.equal(r.task,null);assert.match(r.identityIssue,/no longer/);assert(r.sections.handoff.data.row.saved);assert(r.sections.steps.data.card);
 for(const name of ['A','B'])await f.app.vault.save('40 Tasks/Duplicate '+name+'.md','- [ ] '+taskLine('Duplicate',{},f.ids[0]),null);r=await detail(f,f.p);assert.equal(r.task,null);assert.match(r.identityIssue,/more than one/);assert.equal(r.sections.handoff.data.row.current,null);
});
test('exact source links survive report display limits and do not silently select another decision',async t=>{
 const f=await prepared(t);for(let i=0;i<25;i++)await f.app.store.put('proposals',{...f.p,id:randomUUID(),created:new Date(2093,4,12,19,0,i).toISOString()});
 assert(!(await dayHandoff(f.day,'2093-05-12')).decisions.some(d=>d.id===f.p.id));assert.equal((await detail(f,f.p)).sections.handoff.data.decision.id,f.p.id);
 assert.equal((await detail(f,{id:randomUUID()})).sections.handoff.available,false);assert.equal((await detail(f,f.p,f.ids[2])).sections.handoff.available,false);
 await f.app.store.put('proposals',{...f.p,id:randomUUID(),changes:null});assert.equal((await dayHandoff(f.day,'2093-05-12')).decisions,null);assert.equal((await detail(f,f.p)).sections.handoff.data.decision.id,f.p.id);
});
test('unavailable original sources leave current task sections usable and never invent a saved result',async t=>{
 const f=await prepared(t);f.history.read=async()=>{throw Error('History offline');};let r=await detail(f,f.p);assert.equal(r.sections.handoff.data.historyAvailable,false);assert.equal(r.sections.handoff.data.row.saved,null);assert(r.sections.schedule.available);
 await writeFile(f.day.checkins.path,'damaged');r=await detail(f,f.p);assert.equal(r.sections.handoff.data.checkins,null);assert(r.sections.handoff.data.warnings.some(w=>w.includes('Check-ins')));
 const raw=await f.app.store.get('proposals',f.p.id);await f.app.store.put('proposals',{...raw,changes:null});r=await detail(f,f.p);assert.equal(r.sections.handoff.available,false);assert(r.sections.schedule.available);
});
test('task handoff API validates complete source identity and dates, and keeps ordinary task details compatible',async t=>{
 const f=await prepared(t);await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.app.server.address().port;
 const url=base+'/api/task-detail?taskId='+f.ids[0];assert.equal((await fetch(url)).status,200);assert.equal((await fetch(base+'/handoff-action.js')).status,200);
 for(const q of ['&handoffDate=2093-05-12','&handoffProposalId='+f.p.id,'&handoffDate=2093-02-30&handoffProposalId='+f.p.id,'&handoffDate=2093-05-14&handoffProposalId='+f.p.id,'&handoffDate=2093-05-12&handoffProposalId=bad'])assert.equal((await fetch(url+q)).status,400);
 const r=await (await fetch(url+'&handoffDate=2093-05-12&handoffProposalId='+f.p.id)).json();assert(r.sections.handoff.available);assert.equal((await f.day.taskDetails.report(f.ids[0])).handoffSource,undefined);
});
test('retained task navigation validates source pointers without changing old drafts',()=>{
 const s={version:1,taskId:randomUUID(),sections:['steps'],scrollTop:20,focusKey:''},read=x=>taskReturnState({getItem:()=>JSON.stringify(x)},'/vault');assert.deepEqual(read(s),s);
 s.handoffSource={date:'2093-05-12',proposalId:randomUUID()};s.handoffNotesOpen=true;assert.deepEqual(read(s),s);assert(validHandoffSource(s.handoffSource));assert.throws(()=>read({...s,handoffSource:{...s.handoffSource,date:'2093-02-30'}}));assert.throws(()=>read({...s,handoffNotesOpen:'true'}));
});
test('handoff action view escapes saved sources and explains missing history, focus and task state',async t=>{
 const f=await prepared(t);await step(f);const r=await detail(f,f.p),e=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),button=(label,route,disabled)=>'<button '+(disabled?'disabled':'')+'>'+e(label)+'</button>';
 let html=handoffActionHTML(r,e,button);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);assert.match(html,/not automatically attributed/);
 r.sections.handoff.data.historyAvailable=false;r.sections.handoff.data.row.saved=null;r.sections.focus={available:false,error:'Offline',data:null};html=handoffActionHTML(r,e,button);assert.match(html,/Save history unavailable/);assert.match(html,/focus choice is unavailable/);assert.doesNotMatch(html,/has not been chosen/);
});
