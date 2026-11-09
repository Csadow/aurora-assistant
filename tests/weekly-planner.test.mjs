import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildWeek,weekStart} from '../src/weekly-planner.mjs';
import {taskLine} from '../src/task-meta.mjs';
import {emptyTimetable,timetableMarkdown,TIMETABLE_PATH} from '../mobile/web/timetable.js';
import {createApp} from '../src/server.mjs';
const options={date:'2026-10-14',timezone:'Asia/Atyrau',now:new Date('2026-10-12T08:00:00Z')};
const task=(title,meta={},done=false)=>'- ['+(done?'x':' ')+'] '+taskLine(title,meta);
const notes=lines=>[{path:'40 Tasks/Tasks.md',content:lines.join('\n'),revision:'fixture'}];
const timetable=(extra={})=>({path:TIMETABLE_PATH,content:timetableMarkdown({...emptyTimetable(),timezone:'Asia/Atyrau',classes:[{id:'monday',day:1,title:'Class <script>bad()</script>',start:'10:00',end:'10:50',location:'Room 1'}],...extra})});
test('week boundaries are Monday to Sunday, including year transitions',()=>{
 assert.equal(weekStart('2026-10-18'),'2026-10-12');assert.equal(weekStart('2027-01-01'),'2026-12-28');assert.throws(()=>weekStart('2026-02-30'));assert.throws(()=>weekStart('2000-01-01'));
});
test('weekly reserved minutes are a union; conflicts include class, travel and task overlaps',()=>{
 const n=notes([task('Overlap',{planDate:'2026-10-12',startTime:'10:30',duration:60}),task('Travel conflict',{planDate:'2026-10-12',startTime:'09:20',duration:20})]);n.push(timetable({travelBefore:30,travelAfter:15,travelConfirmed:true}));const before=structuredClone(n),r=buildWeek(n,options),day=r.days[0];
 assert.equal(r.start,'2026-10-12');assert.equal(r.end,'2026-10-18');assert.equal(day.classMinutes,50);assert.equal(day.taskMinutes,80);assert.equal(day.occupiedMinutes,130);assert.equal(day.conflicts.length,3);assert.deepEqual(n,before);assert(day.today);
});
test('deadlines and untimed work do not invent occupied time; completed tasks remain visible',()=>{
 const r=buildWeek(notes([task('Deadline',{due:'2026-10-13'}),task('Untimed',{planDate:'2026-10-13',duration:90}),task('Done',{planDate:'2026-10-13',startTime:'09:00'},true)]),options),day=r.days[1];assert.equal(day.occupiedMinutes,0);assert.equal(day.untimed.length,1);assert.equal(day.due.length,1);assert.equal(day.completed.length,1);assert.equal(r.totals.completed,1);assert.equal(r.backlog.length,1);
});
test('overdue and missed use the current date, not the week being inspected',()=>{
 const r=buildWeek(notes([task('Old',{due:'2026-10-11',planDate:'2026-10-11'}),task('Future',{due:'2026-10-20',planDate:'2026-10-20'})]),{...options,date:'2090-10-20'});assert.equal(r.overdue.length,1);assert.equal(r.missed.length,1);assert.equal(r.today,'2026-10-12');
});
test('malformed or unknown class schedules do not imply available time',()=>{
 const invalid=buildWeek([{path:TIMETABLE_PATH,content:'Broken'}],options);assert(invalid.warnings.length);assert(invalid.days.every(d=>d.occupiedMinutes===null));
 const unknown=buildWeek([timetable({unknownDays:[2]})],options);assert.equal(unknown.days[1].occupiedMinutes,null);assert.equal(unknown.days[2].occupiedMinutes,0);
 const brokenTask=buildWeek(notes(['- [ ] Broken <!-- aster-task:{"id":"bad"} -->']),options);assert(brokenTask.warnings.some(s=>s.includes('invalid')));assert.equal(brokenTask.days[0].occupiedMinutes,null);
});
test('timezone mismatch separates class times and suppresses misleading combined totals',()=>{
 const r=buildWeek([timetable()],{...options,timezone:'UTC'});assert(r.timezoneMismatch);assert.equal(r.days[0].occupiedMinutes,null);assert.equal(r.days[0].classes.length,1);assert.equal(r.days[0].blocks.length,0);assert.throws(()=>buildWeek([],{...options,timezone:'invalid/time'}));
});
test('trimester bounds exclude classes and reminders do not become work blocks',()=>{
 const r=buildWeek([...notes([task('Reminder',{remindAt:'2026-10-12T10:00:00Z'})]),timetable({until:'2026-10-11'})],options);assert.equal(r.totals.classes,0);assert.equal(r.days[0].occupiedMinutes,0);assert.equal(r.days[0].timetableActive,false);
});
test('weekly API is read-only, local, and validates dates and zones',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-week-')),app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),projects:[],ollamaClient:{status:async()=>({online:false,models:[]})}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,before=await app.vault.list();
 assert.equal((await fetch(base+'/api/week?date=2026-10-14')).status,200);assert.equal((await fetch(base+'/api/week?date=bad')).status,400);assert.equal((await fetch(base+'/api/week?timezone=bad')).status,400);assert.equal((await fetch(base+'/api/week',{headers:{Origin:'https://invalid.example'}})).status,403);assert.equal((await fetch(base+'/weekly-planner.js')).status,200);assert.deepEqual(await app.vault.list(),before);
});
