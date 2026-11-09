import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Vault} from '../src/vault.mjs';
import {Store} from '../src/store.mjs';
import {RecurringTasks,RECURRING_PATH} from '../src/recurring-tasks.mjs';
import {TaskHistory} from '../src/task-history.mjs';
import {DayPlanning} from '../src/day-planning.mjs';
import {TaskProposals} from '../src/task-proposals.mjs';
import {buildWeek} from '../src/weekly-planner.mjs';
import {suggestDay} from '../mobile/web/planner-core.js';
import {emptyTimetable,validateTimetable,timetableMarkdown,readTimetable,classesForDay,TIMETABLE_PATH} from '../mobile/web/timetable.js';
const date='2026-10-12',now=()=>new Date(date+'T08:00:00'),zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
const calendar=extra=>validateTimetable({...emptyTimetable(),timezone:zone,classes:[{id:'math',day:1,title:'Math',location:'Room',start:'10:00',end:'10:50'}],...extra});
const availability={days:Array.from({length:7},()=>[['09:00','12:00'],['14:00','18:00']]),gap:10};
const rule={text:'Practice',from:date,until:null,days:[1,3,5],duration:30,priority:'normal'};
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'aurora-upgrade-'));t.after(()=>rm(dir,{recursive:true,force:true}));const vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data'));await vault.init();await store.init();const history=new TaskHistory({vault,data:join(dir,'data')});await history.init();const recurring=new RecurringTasks({vault,now});return {vault,store,history,recurring};}
async function add(r,input=rule){return r.change({operation:'add',revision:(await r.report()).revision,rule:input});}
async function change(r,input){return r.change({...input,revision:(await r.report()).revision});}
test('availability validates split windows, breaks, day off and old timetable compatibility',()=>{
 const a=calendar({availability});assert.deepEqual(classesForDay(a,date).windows,availability.days[1]);assert.equal(classesForDay(calendar({availability:{...availability,days:availability.days.map(()=>[])}}),date).unavailable[0][1],1440);
 assert.equal(readTimetable({content:timetableMarkdown(calendar())}).availability,null);
 for(const a of [{days:[],gap:10},{days:availability.days,gap:-1},{days:availability.days.map(()=>[['14:00','12:00']]),gap:0},{days:availability.days.map(()=>[['09:00','12:00'],['11:00','13:00']]),gap:0}])assert.throws(()=>calendar({availability:a}));
});
test('split-window suggestions fit exact boundaries and never consume lunch or days off',()=>{
 const tasks=[{path:'a',line:0,text:'a',duration:60,priority:'normal'},{path:'a',line:1,text:'b',duration:60,priority:'normal'}];
 const r=suggestDay(tasks,{date,now:now(),windows:[['09:00','10:00'],['14:00','15:00']]});assert.deepEqual(r.proposed.map(p=>p.changes.startTime),['09:00','14:00']);
 assert.equal(suggestDay(tasks,{date,now:now(),windows:[]}).unplaced.length,2);
});
test('cancel affects one date only; moved class recomputes travel and holiday removes arrivals',()=>{
 const c=calendar({travelBefore:20,travelAfter:15,exceptions:[{id:'one',date,kind:'move',classId:'math',targetDate:'2026-10-13',start:'15:00',end:'15:50'}]});
 assert.equal(classesForDay(c,date).classes.length,0);assert.equal(classesForDay(c,'2026-10-19').classes.length,1);
 assert.deepEqual(classesForDay(c,'2026-10-13').busy,[[900,950],[880,900],[950,965]]);
 c.exceptions.push({id:'holiday',kind:'holiday',date:'2026-10-13'});assert.equal(classesForDay(c,'2026-10-13').busy.length,0);
 const cancel=calendar({exceptions:[{id:'cancel',kind:'cancel',classId:'math',date}]});assert.equal(classesForDay(cancel,date).classes.length,0);
});
test('invalid duplicate exceptions and wrong weekdays fail; outside-trimester origins never move in',()=>{
 const move={id:'one',kind:'move',classId:'math',date,targetDate:'2026-10-13',start:'15:00',end:'15:50'};
 assert.throws(()=>calendar({exceptions:[move,{...move,id:'two'}]}));assert.throws(()=>calendar({exceptions:[{...move,date:'2026-10-13'}]}));
 assert.equal(classesForDay(calendar({from:'2026-10-13',exceptions:[move]}),'2026-10-13').classes.length,0);
});
test('weekly agenda and briefing use effective classes and expose availability',async t=>{
 const {vault,store}=await fixture(t);await vault.save(TIMETABLE_PATH,timetableMarkdown(calendar({availability,exceptions:[{id:'holiday',kind:'holiday',date}]})),null);
 await vault.addTask('Early',{planDate:date,startTime:'08:00'});const b=await new DayPlanning({vault,store,now}).briefing();assert.equal(b.day.classes.length,0);assert.deepEqual(b.day.availability,availability.days[1]);assert(b.warnings.some(w=>w.includes('outside your available hours')));
});
test('replan uses windows and rejecting accepted preview after calendar change keeps tasks intact',async t=>{
 const {vault,store}=await fixture(t);await vault.save(TIMETABLE_PATH,timetableMarkdown(calendar({availability,exceptions:[{id:'holiday',kind:'holiday',date}]})),null);await vault.addTask('Plan me',{planDate:date});
 const p=new DayPlanning({vault,store,now}),before=await vault.tasks(),draft=await p.preview({selected:before});assert.equal(draft.changes[0].after.startTime,'09:00');
 const n=await vault.read(TIMETABLE_PATH);await vault.save(n.path,timetableMarkdown(calendar({availability:{...availability,gap:20}})),n.revision);
 await assert.rejects(p.decide(draft.id,'accept'),/changed/);assert.deepEqual(await vault.tasks(),before);
});
test('task proposal detects unavailable time and moved class conflicts',async t=>{
 const {vault,store}=await fixture(t);await vault.save(TIMETABLE_PATH,timetableMarkdown(calendar({availability,exceptions:[{id:'move',kind:'move',classId:'math',date,targetDate:'2026-10-13',start:'15:00',end:'15:50'}]})),null);
 const p=new TaskProposals({vault,store}),a=await p.propose({text:'Early',planDate:date,startTime:'08:00'});assert(a.review.conflicts.some(c=>c.kind==='availability'));
 const b=await p.propose({text:'Overlap',planDate:'2026-10-13',startTime:'15:00'});assert(b.review.conflicts.some(c=>c.kind==='class'));
});
test('recurrence creates normal valid tasks once and persists rules with occurrences atomically',async t=>{
 const {recurring,vault,history}=await fixture(t);const s=await add(recurring);const tasks=await vault.tasks();assert.equal(tasks.length,6);assert(tasks.every(t=>t.id&&!t.scheduleError&&!t.startTime));assert.equal(s.rules[0].generated.length,6);
 const revision=s.revision;await Promise.all([recurring.tick(),recurring.tick()]);await new RecurringTasks({vault,now}).tick();assert.equal((await recurring.report()).revision,revision);assert.equal((await vault.tasks()).length,6);assert.equal((await history.report()).events.filter(e=>e.kinds.includes('appeared')).length,6);
});
test('editing, carrying and deleting an occurrence never regenerates or changes siblings',async t=>{
 const {recurring,vault}=await fixture(t);await add(recurring);const [a,b]=await vault.tasks();await vault.scheduleTask({...a,text:'Changed occurrence',planDate:'2026-11-01'});const n=await vault.read(RECURRING_PATH);await vault.save(n.path,n.content.split('\n').filter(l=>!l.includes(b.id)).join('\n'),n.revision);await recurring.tick();
 const tasks=await vault.tasks();assert.equal(tasks.length,5);assert.equal(tasks.find(t=>t.id===a.id).text,'Changed occurrence');assert(!tasks.some(t=>t.id===b.id));
});
test('pause, resume and end govern generation, never remove existing occurrences',async t=>{
 const {recurring,vault}=await fixture(t);const s=await add(recurring),id=s.rules[0].id;await change(recurring,{operation:'pause',id});recurring.now=()=>new Date('2026-11-02T08:00:00');await recurring.tick();assert.equal((await vault.tasks()).length,6);
 await change(recurring,{operation:'end',id,until:'2026-10-23'});await change(recurring,{operation:'resume',id});assert.equal((await vault.tasks()).length,6);
});
test('skip is idempotent, recorded as disappearance not completion, and survives restart',async t=>{
 const {recurring,vault,history}=await fixture(t);const s=await add(recurring),id=s.rules[0].id;await change(recurring,{operation:'skip',id,date});await change(recurring,{operation:'skip',id,date});await new RecurringTasks({vault,now}).tick();assert.equal((await vault.tasks()).length,5);
 const events=(await history.report()).events;assert.equal(events.filter(e=>e.kinds.includes('disappeared')).length,1);assert(!events.some(e=>e.kinds.includes('marked_complete')));
});
test('completed occurrence cannot be skipped and stale controls cannot overwrite rule changes',async t=>{
 const {recurring,vault}=await fixture(t);const s=await add(recurring),id=s.rules[0].id;const task=(await vault.tasks())[0];await vault.toggleTask(task.path,task.line,task.revision,true);
 await assert.rejects(change(recurring,{operation:'skip',id,date}),/complete/);await assert.rejects(recurring.change({revision:s.revision,operation:'pause',id}),/changed/);
});
test('offline gap never backfills and generation can cross year and leap-day boundaries',async t=>{
 const {recurring,vault}=await fixture(t);await add(recurring,{...rule,days:[0,1,2,3,4,5,6]});recurring.now=()=>new Date('2028-02-27T08:00:00');await recurring.tick();const tasks=await vault.tasks();assert.equal(tasks.length,28);assert(tasks.some(t=>t.planDate==='2028-02-29'));assert(!tasks.some(t=>t.planDate==='2026-10-26'));
});
test('failed save cannot issue dates without tasks, interrupted history acknowledgement cannot duplicate tasks',async t=>{
 const {recurring,vault,history}=await fixture(t);const original=vault.save.bind(vault);vault.save=async()=>{throw Error('Disk full');};await assert.rejects(add(recurring),/Disk full/);assert.equal((await recurring.report()).rules.length,0);vault.save=original;
 history.committed=async()=>{throw Error('Interrupted');};await assert.rejects(add(recurring),/note was saved/);await recurring.tick();assert.equal((await vault.tasks()).length,6);assert.equal((await recurring.report()).rules[0].generated.length,6);
});
test('malformed recurrence stops generation visibly and weekly report does not conceal it',async t=>{
 const {recurring,vault}=await fixture(t);await vault.save(RECURRING_PATH,'Broken recurrence note',null);await recurring.tick();assert.match(recurring.error,/exactly one/);const w=buildWeek(await vault.list(),{date,timezone:zone,now:now()});assert(w.warnings.some(w=>w.includes('Recurring tasks:')));assert.equal((await vault.read(RECURRING_PATH)).content,'Broken recurrence note');
});
test('recurrence HTTP mutations require authentication and stale revisions fail without task changes',async t=>{
 const {createApp}=await import('../src/server.mjs'),dir=await mkdtemp(join(tmpdir(),'aurora-recurrence-api-'));
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),projects:[],ollamaClient:{status:async()=>({online:false,models:[]})}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,token=(await(await fetch(base+'/api/bootstrap')).json()).token;
 const post=(body,auth=true)=>fetch(base+'/api/recurring',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Aster-Token':token}:{})},body:JSON.stringify(body)});
 const before=await app.vault.list();assert.equal((await fetch(base+'/api/recurring')).status,200);assert.deepEqual(await app.vault.list(),before);
 assert.equal((await post({operation:'add',rule,revision:null},false)).status,403);
 const result=await post({operation:'add',rule,revision:null});assert.equal(result.status,200);const s=await result.json();
 assert.equal((await post({operation:'pause',id:s.rules[0].id,revision:'stale'})).status,409);assert.equal((await app.recurring.report()).rules[0].paused,false);
 assert.equal((await fetch(base+'/calendar-options.js')).status,200);assert.equal((await fetch(base+'/planning-settings.js')).status,200);
});
