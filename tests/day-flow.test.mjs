import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {continueDay} from '../src/continue-day.mjs';
import {dayStart} from '../src/day-start.mjs';
import {dayStartHTML} from '../public/day-start.js';
import {taskLine} from '../src/task-meta.mjs';

const date='2095-06-10',later='2095-06-14';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-day-flow-'));let calls=0;
 const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),backups:join(dir,'backups'),projects:[],ollamaClient:{model:'fixture',status:async()=>({online:false}),chat:async()=>{calls++;throw Error('Unexpected model call');}},workflowOptions:{pollMs:60000}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await app.workflows.close();app.calendar.close();app.recurring.stop();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 const day=app.dayPlanning,clock={now:new Date(2095,5,10,8)};day.now=()=>clock.now;day.dailyFocus.history.now=()=>clock.now.toISOString();day.calendar={context:async()=>({enabled:false,complete:true,revision:'off',events:[],warnings:[]})};
 const id=randomUUID();await app.vault.save('40 Tasks/Day flow.md','- [ ] '+taskLine('Study one example <img src=x>',{planDate:date,duration:30},id),null);
 const focus=await day.dailyFocus.report(id),row=focus.rows.find(r=>r.taskId===id);await day.dailyFocus.decide({requestId:randomUUID(),taskId:id,date:focus.date,timezone:focus.timezone,revision:focus.revision,contextRevision:row.contextRevision,action:'focus'});
 await day.firstSteps.save({requestId:randomUUID(),taskId:id,revision:(await day.firstSteps.report(id)).revision,text:'Read the first exercise <img src=x>',mode:'manual',acknowledge:true});
 const snapshot=async()=>({notes:await app.vault.list(),focus:await day.dailyFocus.read(),steps:await day.firstSteps.read(),history:await app.vault.taskHistory.read(),checkins:await day.checkins.read(),sessions:await day.focusSessions.read(),workflows:await app.store.list('workflows')});
 return {app,day,clock,id,snapshot,get calls(){return calls;}};
}
test('briefing and workspace share chosen action and first-step context without mutating planning state',async t=>{
 const f=await fixture(t),before=await f.snapshot(),b=await f.day.briefing(),w=await continueDay(f.day);
 assert.equal(b.start.selected.taskId,f.id);assert.deepEqual(w.focused,b.start.focused);assert.equal(b.start.selected.step.card.text,'Read the first exercise <img src=x>');assert.deepEqual(await f.snapshot(),before);assert.equal(f.calls,0);
 const n=await f.app.vault.read('40 Tasks/Day flow.md');await f.app.vault.save(n.path,n.content.replace('Study one example','Changed example'),n.revision);const changed=await f.day.briefing();assert(changed.start.selected.step.changed);assert.equal(changed.start.selected.step.card.text,b.start.selected.step.card.text);
});
test('return after several days lists original tasks, focus, check-ins and evening decisions without moving them',async t=>{
 const f=await fixture(t),c=await f.day.candidates();await f.day.checkins.create({requestId:randomUUID(),date:c.date,timezone:c.timezone,kind:'interruption',note:'Interrupted by a call',selected:[],start:'09:00',end:'18:00',gap:10});
 const task=(await f.day.evening(date)).unfinished.find(t=>t.id===f.id);await f.day.eveningPreview({date,choices:[{task,action:'move',date:later}]});f.clock.now=new Date(2095,5,14,8);const before=await f.snapshot(),b=await f.day.briefing();
 assert.equal(b.start.selected,null);assert.equal(b.start.focusTotal,0);assert.deepEqual(b.start.earlier.rows.find(r=>r.date===date),{date,unfinished:1,checkins:1,openCheckins:1,reviews:1,focusChoices:1});assert.deepEqual(await f.snapshot(),before);assert.equal((await f.app.vault.tasks()).find(t=>t.id===f.id).planDate,date);assert.equal(f.calls,0);
});
test('new daily overview module and both read-only endpoints serve the same dates and chosen action',async t=>{
 const f=await fixture(t);await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+f.app.server.address().port;
 const b=await(await fetch(url+'/api/briefing')).json(),w=await(await fetch(url+'/api/continue-day')).json();assert.equal(b.start.selected.taskId,f.id);assert.deepEqual(w.start.earlier,b.start.earlier);assert.equal((await fetch(url+'/day-start.js')).status,200);assert.equal(f.calls,0);
});
function stub(){
 const now=new Date(2095,5,14,10,30),id=randomUUID(),notes=[{path:'40 Tasks/Old.md',content:'- [ ] '+taskLine('Earlier task',{planDate:date,duration:30},id)}],planner={now:()=>now,vault:{list:async()=>notes},firstSteps:{read:async()=>({cards:{},outcomes:[]})},checkins:{read:async()=>({entries:[]})},store:{list:async()=>[]},dailyFocus:{read:async()=>({days:{}})}};
 const b={date:later,timezone:'Asia/Atyrau',generatedAt:now.toISOString(),focus:{rows:[]},day:{blocks:[],conflicts:[],unknown:false}};return {planner,b,notes};
}
test('upcoming blocks retain ongoing classes and calendar events, exclude elapsed blocks and show bounded counts',async()=>{
 const {planner,b}=stub();b.day.blocks=[{start:540,end:600,kind:'task',title:'Elapsed'},{start:600,end:650,kind:'class',title:'Ongoing lecture'},{start:660,end:690,kind:'calendar',title:'Appointment'},{start:720,end:750,kind:'task',title:'Chosen task'},{start:780,end:810,kind:'class',title:'Afternoon class'}];b.day.conflicts=[{}];b.day.unknown=true;
 const r=await dayStart(planner,b);assert.deepEqual(r.upcoming.map(x=>x.title),['Ongoing lecture','Appointment','Chosen task']);assert.equal(r.upcomingCount,4);assert.equal(r.conflicts,1);assert(r.unknownClasses);
});
test('one failed earlier-day source preserves other records and marks the unavailable counts',async()=>{
 for(const name of ['tasks','checkins','reviews','focus']){
  const {planner,b}=stub();planner.checkins.read=async()=>({entries:[{date,created:'2095-06-10T01:00:00Z',status:'open'}]});planner.store.list=async()=>[{kind:'evening_review',reviewDate:date,created:'2095-06-10T01:00:00Z'}];planner.dailyFocus.read=async()=>({days:{old:{date,choices:{one:{action:'focus'}}}}});const fail=async()=>{throw Error(name+' fixture unavailable');};
  if(name==='tasks')planner.vault.list=fail;if(name==='checkins')planner.checkins.read=fail;if(name==='reviews')planner.store.list=fail;if(name==='focus')planner.dailyFocus.read=fail;
  const r=await dayStart(planner,b);assert.equal(r.earlier.sources[name],false);assert.equal(r.earlier.rows[0].date,date);assert(r.warnings.length);for(const other of Object.keys(r.earlier.sources).filter(k=>k!==name))assert.equal(r.earlier.sources[other],true);
 }
});
test('earlier-day navigation bounds recent dates, excludes today/future/invalid/completed tasks and retains total',async()=>{
 const {planner,b,notes}=stub();notes[0].content=Array.from({length:20},(_,i)=>'- [ ] '+taskLine('Old '+i,{planDate:'2095-05-'+String(i+1).padStart(2,'0')},randomUUID())).join('\n')+'\n- [ ] '+taskLine('Today',{planDate:later},randomUUID())+'\n- [ ] '+taskLine('Future',{planDate:'2095-07-01'},randomUUID())+'\n- [x] '+taskLine('Done',{planDate:'2095-04-01'},randomUUID());
 planner.store.list=async()=>[{kind:'evening_review',reviewDate:'2095-02-30',created:'2095-02-01T00:00:00Z'},{kind:'evening_review',reviewDate:'2095-04-02',created:'2096-01-01T00:00:00Z'}];const r=await dayStart(planner,b);assert.equal(r.earlier.total,20);assert.equal(r.earlier.rows.length,14);assert.equal(r.earlier.rows[0].date,'2095-05-20');assert.equal(r.earlier.rows.at(-1).date,'2095-05-07');
});
test('a midnight rollover is visible and does not promote an earlier choice',async()=>{
 const {planner,b}=stub();planner.now=()=>new Date(2095,5,15,0,1);planner.dailyFocus.read=async()=>({days:{old:{date,choices:{one:{action:'focus'}}}}});const r=await dayStart(planner,b);assert(r.warnings.some(w=>w.includes('day changed')));assert.equal(r.selected,null);assert.equal(r.earlier.rows[0].date,date);
});
test('compact overview escapes task, step, warning and commitment text; source failures never render as zero records',async()=>{
 const {planner,b}=stub();planner.vault.list=async()=>{throw Error('<img src=x>');};planner.checkins.read=async()=>({entries:[{date,created:'2095-06-10T01:00:00Z',status:'open'}]});b.day.blocks=[{end:900,time:'11:00',title:'<img src=x>',kind:'calendar'}];const r=await dayStart(planner,b);r.selected={taskId:'fixture',text:'<script>',detail:'<img>',readiness:'ready',step:{card:{text:'<svg>',context:{date}},changed:true}};
 const escape=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');const html=dayStartHTML(r,null,escape);assert(!html.includes('<img'));assert(!html.includes('<script>'));assert(!html.includes('<svg>'));assert(html.includes('planned tasks unavailable'));assert(html.includes('&quot;date&quot;:&quot;2095-06-10&quot;'));assert(html.includes('Step context changed'));
});
