import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {taskLine} from '../src/task-meta.mjs';
import {remainingAdjustments} from '../src/remaining-adjustments.mjs';
import {continueDay} from '../src/continue-day.mjs';
import {adjustmentHTML,adjustmentSummary} from '../public/remaining-adjustments.js';
import {TIMETABLE_PATH,emptyTimetable,timetableMarkdown} from '../mobile/web/timetable.js';

const date='2097-05-12';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-adjustments-'));let calls=0;
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],ollamaClient:{status:async()=>({online:false}),chat:async()=>{calls++;throw Error('No inference expected');}},workflowOptions:{pollMs:60000}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await app.workflows.close();app.calendar.close();app.recurring.stop();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 const day=app.dayPlanning,clock={now:new Date(2097,4,12,9,40)},history=day.dailyFocus.history;day.now=()=>clock.now;history.now=()=>clock.now.toISOString();const cal={enabled:false,complete:true,revision:'off',events:[],warnings:[]};day.calendar={context:async()=>cal,fresh:async()=>cal};
 const tt=await app.vault.read(TIMETABLE_PATH).catch(()=>null);await app.vault.save(TIMETABLE_PATH,timetableMarkdown(emptyTimetable()),tt?.revision||null);
 const ids=[randomUUID(),randomUUID()];for(let i=0;i<2;i++)await app.vault.save('40 Tasks/Adjustment '+i+'.md','- [ ] '+taskLine('Adjustment '+i+' <img src=x>',{planDate:date,startTime:i?'08:00':'07:00',duration:i?90:30},ids[i]),null);
 const plan=async({checkin=false,start='10:00',end='11:00'}={})=>{const c=await day.candidates(),selected=c.tasks.filter(t=>ids.includes(t.id));let source;if(checkin)source=await day.checkins.create({requestId:randomUUID(),date,timezone:c.timezone,kind:'interruption',note:'Class ran late <svg>',start,end,gap:0,selected:selected.map(t=>({taskId:t.id,contextRevision:t.contextRevision}))});return day.preview({requestId:randomUUID(),date,timezone:c.timezone,start,end,gap:0,selected,...(source?{checkin:{id:source.id,revision:source.revision}}:{})});};
 const report=(input={})=>remainingAdjustments(day,{date,...input}),snapshot=async()=>({notes:await app.vault.list(),history:await history.read(),focus:await day.dailyFocus.read(),steps:await day.firstSteps.read(),sessions:await day.focusSessions.read(),checkins:await day.checkins.read(),proposals:await app.store.list('proposals'),workflows:await app.store.list('workflows')});
 return {app,day,clock,history,ids,plan,report,snapshot,get calls(){return calls;}};
}
test('adjustment preview reads make no changes and distinguish proposed untimed work from a saved change',async t=>{
 const f=await fixture(t),p=await f.plan(),before=await f.snapshot(),r=await f.report();assert.equal(r.total,1);const a=r.adjustments[0];assert.equal(a.id,p.id);assert.equal(a.recorded,0);assert.equal(a.untimed,0);assert.equal(a.status,'pending');assert(a.rows[1].unplaced);assert.equal(a.rows[1].current.startTime,'08:00');assert.equal(a.rows[1].saved,null);assert.deepEqual(await f.snapshot(),before);assert.equal(f.calls,0);
});
test('accepted receipts retain exact earlier saves through a second interruption and later task edits',async t=>{
 const f=await fixture(t),first=await f.plan({checkin:true});await f.day.decide(first.id,'accept');let a=(await f.report({proposalId:first.id})).adjustments[0];assert.equal(a.recorded,2);assert.equal(a.untimed,1);assert.equal(a.rows[0].saved.after.startTime,'10:00');assert.equal(a.rows[1].saved.after.startTime,null);assert.equal(a.checkin.currentStatus,'open');
 const second=await f.plan({checkin:true,start:'12:00',end:'15:00'});await f.day.decide(second.id,'accept');const task=(await f.app.vault.tasks()).find(t=>t.id===f.ids[0]);await f.app.vault.scheduleTask({...task,duration:45});const before=await f.snapshot();a=(await f.report({proposalId:first.id})).adjustments[0];assert.equal(a.checkin.id,first.checkin.id);assert.notEqual(a.checkin.id,second.checkin.id);assert.equal(a.rows[0].saved.after.duration,30);assert.equal(a.rows[0].current.duration,45);assert.equal(a.rows[0].current.startTime,'12:00');assert(a.rows.every(r=>r.changed));assert.deepEqual(await f.snapshot(),before);
});
test('partial and dismissed saves preserve only actual recorded task changes',async t=>{
 const f=await fixture(t),p=await f.plan(),save=f.app.vault.save.bind(f.app.vault);let n=0;f.app.vault.save=async(...a)=>{if(++n===2)throw Error('Interrupted write');return save(...a);};await assert.rejects(f.day.decide(p.id,'accept'));f.app.vault.save=save;
 let a=(await f.report()).adjustments[0];assert.equal(a.recorded,1);assert.equal(a.savedNotes,1);assert.equal(a.status,'pending');assert.equal(a.rows[1].current.startTime,'08:00');await f.day.decide(p.id,'dismiss');a=(await f.report()).adjustments[0];assert.equal(a.status,'dismissed');assert.equal(a.recorded,1);assert.equal(a.rows[1].saved,null);
});
test('unconfirmed history stays unknown until explicit recovery, which retains recovered provenance',async t=>{
 const f=await fixture(t),p=await f.plan(),committed=f.history.committed.bind(f.history);f.history.committed=async()=>{throw Error('Lost history reply');};await assert.rejects(f.day.decide(p.id,'accept'));f.history.committed=committed;const before=await f.snapshot();let r=await f.report();assert.equal(r.adjustments[0].recorded,0);assert(r.warnings.some(w=>w.includes('reconciliation')));assert.deepEqual(await f.snapshot(),before);await f.history.report();r=await f.report();assert.equal(r.adjustments[0].recorded,1);assert.equal(r.adjustments[0].rows[0].saved.source,'recovered_save');
});
test('independent source failures preserve original check-in and receipt context without claiming zero saves',async t=>{
 const f=await fixture(t),p=await f.plan({checkin:true});await f.day.decide(p.id,'accept');const history=f.history.read,checkins=f.day.checkins.read,tasks=f.app.vault.tasks;
 f.history.read=async()=>{throw Error('History offline');};let r=await f.report();assert.equal(r.adjustments[0].recorded,null);assert.equal(r.adjustments[0].untimed,null);assert(r.adjustments[0].rows[0].current);f.history.read=history;
 f.day.checkins.read=async()=>{throw Error('Check-ins offline');};r=await f.report();assert.equal(r.adjustments[0].checkin.note,p.checkin.note);assert(r.adjustments[0].checkin.issue);assert.equal(r.adjustments[0].recorded,2);f.day.checkins.read=checkins;
 f.app.vault.tasks=async()=>{throw Error('Tasks offline');};r=await f.report();assert.equal(r.adjustments[0].rows[0].current,null);assert(r.adjustments[0].rows[0].saved);assert.match(r.adjustments[0].rows[0].issue,/unavailable/);f.app.vault.tasks=tasks;
});
test('missing, duplicate and damaged tasks retain history; a damaged review does not hide a valid exact source',async t=>{
 const f=await fixture(t),p=await f.plan();await f.day.decide(p.id,'accept');await f.app.vault.save('40 Tasks/Duplicate.md','- [ ] '+taskLine('Duplicate',{},f.ids[0]),null);let a=(await f.report()).adjustments[0];assert.equal(a.rows[0].current,null);assert.match(a.rows[0].issue,/Duplicate/);assert(a.rows[0].saved);const n=await f.app.vault.read('40 Tasks/Adjustment 1.md');await f.app.vault.trash(n.path,n.revision);a=(await f.report()).adjustments[0];assert.match(a.rows[1].issue,/completion is unknown/);
 const raw=await f.app.store.get('proposals',p.id);await f.app.store.put('proposals',{...raw,id:randomUUID(),changes:null});assert((await f.report()).adjustments.some(a=>a.error));assert.equal((await f.report({proposalId:p.id})).adjustments[0].recorded,2);
});
test('pagination, original-date reopening and validation never advance a saved adjustment',async t=>{
 const f=await fixture(t),p=await f.plan(),raw=await f.app.store.get('proposals',p.id);for(let i=0;i<12;i++)await f.app.store.put('proposals',{...raw,id:randomUUID()});let r=await f.report();assert.equal(r.total,13);assert.equal(r.adjustments.length,10);assert.equal((await f.report({offset:10})).adjustments.length,3);assert.equal((await f.report({proposalId:p.id,offset:10})).adjustments[0].id,p.id);
 f.clock.now=new Date(2097,4,13,8);r=await remainingAdjustments(f.day);assert.equal(r.total,0);assert.deepEqual(r.earlier,[date]);assert.equal((await f.report({proposalId:p.id})).date,date);
 for(const input of [{date:'2097-02-30'},{date:'2097-05-14'},{proposalId:'bad'},{offset:-1},{offset:0.5}])await assert.rejects(f.report(input));await assert.rejects(f.report({date:'2097-05-13',proposalId:p.id}),/original date/);
});
test('workspace and authenticated API expose the same read-only adjustment records and native module',async t=>{
 const f=await fixture(t),p=await f.plan();const before=await f.snapshot();assert.equal((await continueDay(f.day)).adjustments.adjustments[0].id,p.id);await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.app.server.address().port;
 const response=await fetch(base+'/api/remaining-adjustments?date='+date+'&proposalId='+p.id);assert.equal(response.status,200);assert.equal((await response.json()).adjustments[0].id,p.id);assert.equal((await fetch(base+'/remaining-adjustments.js')).status,200);assert.equal((await fetch(base+'/api/remaining-adjustments?offset=-1')).status,400);assert.equal((await fetch(base+'/api/remaining-adjustments',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);assert.deepEqual(await f.snapshot(),before);assert.equal(f.calls,0);
});
test('comparison escapes task and check-in text and labels unknown histories and missing current tasks',async t=>{
 const f=await fixture(t),p=await f.plan({checkin:true}),e=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');let r=await f.report(),html=adjustmentHTML(r.adjustments[0],e);assert(!html.includes('<img'));assert(!html.includes('<svg>'));assert(html.includes('Proposed:'));assert(html.includes('No changed-task receipt'));
 f.history.read=async()=>{throw Error('History unavailable');};r=await f.report();html=adjustmentSummary(r,null,e,(label)=>e(label));assert(html.includes('recorded changes unavailable'));assert(!html.includes('0 of 2 task changes'));assert.equal((await f.app.store.get('proposals',p.id)).status,'pending');
});

test('accepted unchanged rows acknowledge saved notes without inventing change receipts',async t=>{
 const f=await fixture(t);await f.day.decide((await f.plan()).id,'accept');const p=await f.plan();await f.day.decide(p.id,'accept');const a=(await f.report({proposalId:p.id})).adjustments[0];assert.equal(a.status,'accepted');assert.equal(a.savedNotes,2);assert.equal(a.recorded,0);assert(a.rows.every(r=>r.noteSaved&&!r.saved));
});
test('completed and malformed current tasks never replace historical evidence, and duplicate review rows are rejected',async t=>{
 const f=await fixture(t),p=await f.plan();await f.day.decide(p.id,'accept');let n=await f.app.vault.read('40 Tasks/Adjustment 0.md');await f.app.vault.save(n.path,n.content.replace('- [ ]','- [x]'),n.revision);let a=(await f.report()).adjustments[0];assert.equal(a.rows[0].current.done,true);assert.equal(a.rows[0].saved.after.done,false);assert(a.rows[0].changed);
 n=await f.app.vault.read(n.path);await f.app.vault.save(n.path,n.content.replace('"duration":30','"duration":0'),n.revision);a=(await f.report()).adjustments[0];assert.equal(a.rows[0].current,null);assert.match(a.rows[0].issue,/metadata needs repair/);assert(a.rows[0].saved);
 const raw=await f.app.store.get('proposals',p.id);await f.app.store.put('proposals',{...raw,changes:[raw.changes[0],raw.changes[0]]});assert((await f.report()).adjustments[0].error);
});
