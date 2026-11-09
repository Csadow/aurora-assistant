import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Vault} from '../src/vault.mjs';
import {Store} from '../src/store.mjs';
import {TaskHistory} from '../src/task-history.mjs';
import {DailyFocus} from '../src/daily-focus.mjs';
import {DayPlanning} from '../src/day-planning.mjs';
import {taskLine} from '../src/task-meta.mjs';
import {emptyTimetable,timetableMarkdown,TIMETABLE_PATH} from '../mobile/web/timetable.js';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'aurora-next-day-'));t.after(()=>rm(dir,{recursive:true,force:true}));const vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data')),clock={now:new Date(2026,9,12,8)},links=[];await vault.init();await store.init();const history=new TaskHistory({vault,data:store.root,now:()=>clock.now.toISOString()});await history.init();const taskWorkflows={summary:async()=>links},opts={vault,store,taskWorkflows,now:()=>clock.now},day=new DayPlanning(opts),focus=new DailyFocus({...opts,history,data:store.root});day.dailyFocus=focus;return {vault,store,clock,links,history,day,focus,opts};}
const target='2026-10-13',base={duration:30,due:'2026-10-15',remindAt:'2026-10-14T04:00:00Z'};
async function input(f,ids,date=target){const r=await f.day.nextDay(date);return {requestId:randomUUID(),date:r.date,today:r.today,timezone:r.timezone,selected:r.rows.filter(r=>ids?ids.includes(r.taskId):!r.issue).map(r=>({taskId:r.taskId,contextRevision:r.contextRevision}))};}
const preview=async(f,extra={})=>f.day.nextDayPreview({...await input(f),...extra});
function calendar(f){const c={enabled:true,complete:true,revision:'calendar-a',from:'2026-10-01',to:'2026-11-01',events:[]};f.day.calendar={fresh:async()=>c,context:async()=>c};return c;}
test('next-day report is read only and keeps original schedules and focus separate',async t=>{
 const f=await fixture(t);await f.vault.addTask('Unscheduled',base);await f.vault.addTask('Missed',{...base,planDate:'2026-10-10',startTime:'12:00'});const notes=await f.vault.list(),history=await f.history.read(),r=await f.day.nextDay();
 assert.equal(r.date,target);assert.equal(r.rows.length,2);assert(r.rows.every(r=>!r.issue));assert.equal(r.rows.find(r=>r.text==='Unscheduled').task.planDate,null);assert.deepEqual(await f.vault.list(),notes);assert.deepEqual(await f.history.read(),history);assert.equal((await f.store.list('proposals')).length,0);await assert.rejects(readFile(f.focus.path),{code:'ENOENT'});
});
test('identity, prerequisites, active attempts and decisions stay held while future fixed blocks remain untouched',async t=>{
 const f=await fixture(t);for(const [text,meta] of [['Fixed',{planDate:target,startTime:'09:00'}],['Later',{planDate:'2026-10-15'}],['Active',{planDate:'2026-10-12',startTime:'08:00'}],['Question',{}],['Running',{}],['Prerequisite',{}],['Duplicate',{}]])await f.vault.addTask(text,{...base,...meta});
 const tasks=await f.vault.tasks(),by=text=>tasks.find(t=>t.text===text);await f.vault.addTask('Dependent',{...base,dependsOn:[by('Prerequisite').id]});await f.vault.save('40 Tasks/Duplicate.md','- [ ] '+taskLine('Duplicate',base,by('Duplicate').id),null);
 f.links.push({id:'question',taskId:by('Question').id,attention:{kind:'question'},executionRevision:'a'},{id:'running',taskId:by('Running').id,status:'running',executionRevision:'b'});const r=await f.day.nextDay();assert.equal(r.rows.filter(r=>!r.issue).length,1);
 for(const row of r.rows.filter(r=>r.issue))await assert.rejects(f.day.nextDayPreview(await input(f,[row.taskId])),/first|fixed|planned|active|Waiting|Duplicate|changed/);
});
test('future slots preserve task fields, current attempts and stable IDs and do not select focus or complete tasks',async t=>{
 const f=await fixture(t);await f.vault.addTask('A',base);const task=(await f.vault.tasks())[0];f.links.push({id:'existing',taskId:task.id,status:'draft',executionRevision:'one'});const original=await f.vault.tasks(),p=await preview(f);assert.equal(p.kind,'future_schedule');assert.equal(p.changes[0].after.startTime,'09:00');assert.deepEqual(await f.vault.tasks(),original);
 await f.day.decide(p.id,'accept');const after=(await f.vault.tasks())[0];for(const key of ['id','text','duration','due','remindAt','priority','project','parent','dependsOn','done'])assert.deepEqual(after[key],task[key]);assert.equal(after.planDate,target);assert.equal(f.links[0].id,'existing');assert.equal((await f.store.list('workflows')).length,0);await assert.rejects(readFile(f.focus.path),{code:'ENOENT'});
});
test('capacity accounts for classes, overlapping Google busy time, fixed work, windows and breaks',async t=>{
 const f=await fixture(t);await f.vault.addTask('Selected',base);await f.vault.addTask('Fixed',{...base,planDate:target,startTime:'12:00',duration:30});const c=calendar(f);c.events=[{id:'event',summary:'Busy overlap',start:{dateTime:new Date(2026,9,13,9,30).toISOString()},end:{dateTime:new Date(2026,9,13,10,30).toISOString()}}];
 await f.vault.save(TIMETABLE_PATH,timetableMarkdown({...emptyTimetable(),travelConfirmed:true,classes:[{id:'tue',day:2,title:'Class',location:'Campus',start:'09:00',end:'10:00'}]}),null);
 const p=await preview(f,{start:'09:00',end:'13:00',gap:10}),cap=p.targetDays[0].capacity;assert.equal(p.changes[0].after.startTime,'10:40');assert.equal(cap.windowMinutes,240);assert.equal(cap.busyMinutes,120);assert.equal(cap.bufferMinutes,30);assert.equal(cap.availableMinutes,90);assert.equal(cap.largestSlotMinutes,70);assert.equal(cap.remainingMinutes,50);assert.equal(cap.selectedMinutes,30);assert.equal(cap.placedMinutes,30);
});
test('unplaced and unselected tasks retain their whole original schedule, including old timed blocks',async t=>{
 const f=await fixture(t);await f.vault.addTask('Small',{...base,duration:20});await f.vault.addTask('Too large',{...base,planDate:'2026-10-10',startTime:'12:00',duration:120});await f.vault.addTask('Unselected',base);const tasks=await f.vault.tasks(),selected=tasks.filter(t=>t.text!=='Unselected').map(t=>t.id),p=await f.day.nextDayPreview({...await input(f,selected),start:'09:00',end:'10:00'});
 assert.equal(p.changes.length,1);assert.equal(p.held[0].text,'Too large');assert.equal(p.targetDays[0].capacity.untimedMinutes,120);await f.day.decide(p.id,'accept');for(const old of tasks.filter(t=>t.text!=='Small')){const current=(await f.vault.tasks()).find(t=>t.id===old.id);assert.deepEqual({...current,revision:old.revision},old);}
});
test('a day off and fragmented capacity explain a zero-fit preview without rewriting the task',async t=>{
 const f=await fixture(t);await f.vault.addTask('Long',{...base,duration:60});await f.vault.save(TIMETABLE_PATH,timetableMarkdown({...emptyTimetable(),availability:{gap:10,days:Array.from({length:7},()=>[['09:00','09:40'],['14:00','14:40']])}}),null);const p=await preview(f);assert.equal(p.changes.length,0);assert.equal(p.targetDays[0].capacity.availableMinutes,80);assert.equal(p.targetDays[0].capacity.largestSlotMinutes,40);assert.equal(p.held.length,1);const before=await f.vault.list();await f.day.decide(p.id,'dismiss');assert.deepEqual(await f.vault.list(),before);
 const n=await f.vault.read(TIMETABLE_PATH);await f.vault.save(n.path,timetableMarkdown({...emptyTimetable(),availability:{gap:10,days:Array.from({length:7},()=>[])}}),n.revision);assert.equal((await preview(f)).targetDays[0].capacity.availableMinutes,0);
});
test('stale selections reject changes to tasks, attempts, prerequisites and duplicate identity',async t=>{
 const f=await fixture(t);await f.vault.addTask('A',base);let old=await input(f),task=(await f.vault.tasks())[0];await f.vault.scheduleTask({...task,duration:40});await assert.rejects(f.day.nextDayPreview(old),/changed/);
 old=await input(f);f.links.push({id:'changed',taskId:task.id,executionRevision:'new'});await assert.rejects(f.day.nextDayPreview(old),/changed/);f.links.length=0;old=await input(f);await f.vault.save('40 Tasks/Duplicate.md','- [ ] '+taskLine('A',base,task.id),null);await assert.rejects(f.day.nextDayPreview(old),/changed/);
});
test('calendar coverage, freshness, unknown classes and changes during download prevent stale proposals',async t=>{
 const f=await fixture(t);await f.vault.addTask('A',base);const c=calendar(f);c.complete=false;await assert.rejects(preview(f),/Refresh Google/);c.complete=true;c.to=target;await assert.rejects(preview(f),/downloaded date/);c.to='2026-11-01';
 await f.vault.save(TIMETABLE_PATH,timetableMarkdown({...emptyTimetable(),unknownDays:[2]}),null);await assert.rejects(preview(f),/incomplete class/);const n=await f.vault.read(TIMETABLE_PATH);await f.vault.save(n.path,timetableMarkdown(emptyTimetable()),n.revision);
 f.day.calendar.fresh=async()=>{await f.vault.addTask('Changed during download',base);return c;};await assert.rejects(preview(f),/Tasks or classes changed/);assert.equal((await f.store.list('proposals')).length,0);
});
test('invalid requests and stale date or timezone fail before writes',async t=>{
 const f=await fixture(t);await f.vault.addTask('A',base);const i=await input(f);for(const extra of [{requestId:'bad'},{selected:[]},{selected:[...i.selected,...i.selected]},{date:'bad'},{date:'2026-10-11'},{today:'2026-10-11'},{timezone:'wrong'},{start:'18:00',end:'09:00'},{gap:-1}])await assert.rejects(f.day.nextDayPreview({...i,...extra}));assert.equal((await f.store.list('proposals')).length,0);
 f.clock.now=new Date(2026,9,13,8);await assert.rejects(f.day.nextDayPreview(i),/day or timezone changed/);
});
test('preview requests recover lost replies, serialize duplicate submissions and never overwrite another proposal',async t=>{
 const f=await fixture(t);await f.vault.addTask('A',base);const i=await input(f),[a,b]=await Promise.all([f.day.nextDayPreview(i),f.day.nextDayPreview(i)]);assert.equal(a.id,b.id);assert.equal((await f.store.list('proposals')).length,1);await assert.rejects(f.day.nextDayPreview({...i,end:'17:00'}),/already used/);
 await f.day.decide(a.id,'accept');f.clock.now=new Date(2026,9,14,8);assert.equal((await new DayPlanning(f.opts).nextDayPreview(i)).status,'accepted');assert.equal((await f.store.list('proposals')).length,1);
 const other=await f.store.proposal({kind:'task'});await assert.rejects(f.day.nextDayPreview({...i,requestId:other.id}),/already used/);assert.equal((await f.store.get('proposals',other.id)).kind,'task');
});
test('a preview receipt failure reports uncertainty and reopens the same committed request',async t=>{
 const f=await fixture(t);await f.vault.addTask('A',base);const i=await input(f),put=f.store.put.bind(f.store);f.store.put=async(k,r)=>{const result=await put(k,r);if(r.id===i.requestId)throw Error('Reply failed after preview write');return result;};
 await assert.rejects(f.day.nextDayPreview(i),e=>e.status===503&&/may already be saved/.test(e.message));f.store.put=put;const p=await new DayPlanning(f.opts).nextDayPreview(i);assert.equal(p.id,i.requestId);assert.equal((await f.store.list('proposals')).length,1);assert.equal((await f.vault.tasks())[0].planDate,null);
});
test('task and calendar changes at note replacement reject future time writes',async t=>{
 const f=await fixture(t);await f.vault.addTask('A',base);const c=calendar(f),save=f.vault.save.bind(f.vault),task=(await f.vault.tasks())[0];let p=await preview(f);f.vault.save=async(...args)=>{f.links.push({id:'new',taskId:task.id,executionRevision:'new'});return save(...args);};await assert.rejects(f.day.decide(p.id,'accept'),/attempt changed/);f.vault.save=save;f.links.length=0;p=await preview(f);f.vault.save=async(...args)=>{c.revision='changed';return save(...args);};await assert.rejects(f.day.decide(p.id,'accept'),/Calendar changed during/);assert.equal((await f.vault.tasks())[0].planDate,null);
});
test('partial saves recover remaining notes after restart without replaying saved tasks or history',async t=>{
 const f=await fixture(t);await f.vault.addTask('A',base);await f.vault.save('40 Tasks/Second.md','- [ ] '+taskLine('B',base),null);const before=await f.vault.tasks(),p=await preview(f),save=f.vault.save.bind(f.vault);let calls=0;f.vault.save=async(...args)=>{if(++calls===2)throw Error('Second note interrupted');return save(...args);};await assert.rejects(f.day.decide(p.id,'accept'),/Saved 1 of 2/);f.vault.save=save;
 const restarted=new DayPlanning(f.opts);await restarted.decide(p.id,'accept');await restarted.decide(p.id,'accept');assert.deepEqual((await f.vault.tasks()).map(t=>t.id),before.map(t=>t.id));assert.equal((await f.history.read()).events.filter(e=>e.decision?.kind==='future_schedule').length,2);
});
test('fully committed receipts reconcile after midnight, while unsaved slots expire and later edits stay protected',async t=>{
 const f=await fixture(t);await f.vault.addTask('A',base);const p=await preview(f),put=f.store.put.bind(f.store);let fail=true;f.store.put=async(k,r)=>{if(r.id===p.id&&r.saved?.length&&fail){fail=false;throw Error('Lost receipt');}return put(k,r);};await assert.rejects(f.day.decide(p.id,'accept'),/Lost receipt/);f.store.put=put;const notes=await f.vault.list(),events=await f.history.read();f.clock.now=new Date(2026,9,13,8);assert.equal((await new DayPlanning(f.opts).decide(p.id,'accept')).status,'accepted');assert.deepEqual(await f.vault.list(),notes);assert.deepEqual(await f.history.read(),events);
 await f.vault.addTask('New',base);const next=await f.day.nextDayPreview(await input(f,[(await f.vault.tasks()).find(t=>t.text==='New').id],'2026-10-14'));f.clock.now=new Date(2026,9,14,8);await assert.rejects(f.day.decide(next.id,'accept'),/day or timezone/);
});
test('partial recovery preserves an edit to an already saved note',async t=>{
 const f=await fixture(t);await f.vault.addTask('A',base);await f.vault.save('40 Tasks/Second.md','- [ ] '+taskLine('B',base),null);const p=await preview(f),save=f.vault.save.bind(f.vault);let calls=0;f.vault.save=async(...args)=>{if(++calls===2)throw Error('Interrupted');return save(...args);};await assert.rejects(f.day.decide(p.id,'accept'));f.vault.save=save;const stored=await f.store.get('proposals',p.id),note=await f.vault.read(stored.saved[0]);await f.vault.save(note.path,note.content+'\nKeep this later edit\n',note.revision);await assert.rejects(new DayPlanning(f.opts).decide(p.id,'accept'),/applied task note changed/);
});
test('next-day API authenticates preview creation, redacts intents and uses the dedicated review route without model calls',async t=>{
 const f=await fixture(t);await f.vault.addTask('API work',base);let calls=0;const {createApp}=await import('../src/server.mjs'),app=await createApp({vault:f.vault.root,data:f.store.root,projects:[],ollamaClient:{status:async()=>({online:false,models:[]}),chat:async()=>{calls++;throw Error('No model call');}}});app.dayPlanning.now=()=>f.clock.now;await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
 const url='http://127.0.0.1:'+app.server.address().port,boot=await(await fetch(url+'/api/bootstrap')).json(),post=(path,data,auth=true)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Aster-Token':boot.token}:{})},body:JSON.stringify(data)}),i=await input({...f,day:app.dayPlanning});assert.equal((await post('/api/next-day/preview',i,false)).status,403);const response=await post('/api/next-day/preview',i);assert.equal(response.status,200);const p=await response.json();assert.equal(p.intents,undefined);assert.equal(p.contextHash,undefined);assert.equal(p.requestHash,undefined);assert.equal((await post('/api/proposal',{id:p.id,action:'accept'})).status,400);assert.equal((await fetch(url+'/next-day.js')).status,200);assert.equal((await fetch(url+'/planning-selection.js')).status,200);assert.equal((await(await fetch(url+'/api/proposals')).json()).find(x=>x.id===p.id).intents,undefined);assert.equal(calls,0);
});
