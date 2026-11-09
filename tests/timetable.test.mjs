import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {emptyTimetable,validateTimetable,timetableMarkdown,readTimetable,classesForDay,TIMETABLE_PATH} from '../mobile/web/timetable.js';
import {suggestDay,mobileTasks,TASK_PATH} from '../mobile/web/planner-core.js';
import {taskLine} from '../src/task-meta.mjs';
import {emptyState,saveNote,exportBundle,readBundle,importBundle} from '../mobile/web/core.js';
import {createApp} from '../src/server.mjs';
const fixture=()=>({...emptyTimetable(),timezone:'Asia/Atyrau',classes:[{id:'class-a',day:1,title:'Mathematics',location:'Room 101',start:'10:00',end:'10:50'},{id:'class-b',day:1,title:'Programming',location:'Room 202',start:'14:00',end:'14:50'}]});
test('weekly classes recur by calendar day without generating task copies',()=>{
  const t=fixture();assert.equal(classesForDay(t,'2026-10-12').classes.length,2);assert.equal(classesForDay(t,'2026-10-19').classes.length,2);assert.equal(classesForDay(t,'2026-10-17').classes.length,0);
  const note={path:TIMETABLE_PATH,content:timetableMarkdown(t)};assert.deepEqual(readTimetable(note),t);assert.deepEqual(mobileTasks({notes:[note]}),[]);
});
test('term bounds and incomplete days constrain only their intended dates',()=>{
  const t={...fixture(),from:'2026-10-12',until:'2026-12-20',unknownDays:[6]};assert.equal(classesForDay(t,'2026-10-05').classes.length,0);assert.equal(classesForDay(t,'2026-12-21').classes.length,0);assert(classesForDay(t,'2026-10-17').unknown);assert(!classesForDay(t,'2026-12-26').unknown);
});
test('travel surrounds first and last classes while keeping the midday gap available',()=>{
  const t={...fixture(),travelBefore:30,travelAfter:40};assert.deepEqual(classesForDay(t,'2026-10-12').busy,[[600,650],[840,890],[570,600],[890,930]]);
  const tasks=mobileTasks({notes:[{path:TASK_PATH,content:'- [ ] '+taskLine('Study',{duration:60})}]});
  const plan=suggestDay(tasks,{date:'2026-10-12',start:'09:00',end:'17:00',gap:10,now:new Date(2026,9,11),reserved:classesForDay(t,'2026-10-12').busy});assert.equal(plan.proposed[0].changes.startTime,'11:00');
});
test('malformed timetable fails closed instead of implying a free day',()=>{
  for(const change of [{timezone:'not/a-zone'},{travelBefore:-1},{travelAfter:181},{until:'bad'},{unknownDays:[8]},{from:'2026-12-01',until:'2026-10-01'}])assert.throws(()=>validateTimetable({...fixture(),...change}));
  assert.throws(()=>readTimetable({content:'Broken schedule'}));assert.throws(()=>readTimetable({content:timetableMarkdown(fixture())+'\n'+timetableMarkdown(fixture())}));
  for(const change of [{start:'25:00'},{end:'09:00'},{day:7},{title:''}])assert.throws(()=>validateTimetable({...fixture(),classes:[{...fixture().classes[0],...change}]}));
});
test('class IDs are unique and travel bounds clamp to the current day',()=>{
  const t=fixture();assert.throws(()=>validateTimetable({...t,classes:[t.classes[0],t.classes[0]]}));
  t.classes=[{...t.classes[0],start:'00:10',end:'23:50'}];t.travelBefore=30;t.travelAfter=30;assert.deepEqual(classesForDay(t,'2026-10-12').busy,[[10,1430],[0,10],[1430,1440]]);
});
test('phone backup preserves editable weekly classes, travel and trimester end',()=>{
  const state=emptyState(),data={...fixture(),travelBefore:30,travelConfirmed:true,until:'2026-12-20'};saveNote(state,TIMETABLE_PATH,timetableMarkdown(data),null);
  const phone=emptyState();importBundle(phone,readBundle(exportBundle(state)));assert.deepEqual(readTimetable(phone.notes[0]),data);
});
test('planning chat receives today class commitments and work-block metadata as reference data',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-timetable-context-'));t.after(()=>rm(dir,{recursive:true,force:true}));let prompt;
  const ollama={check:async()=>{},status:async()=>({online:true,models:[]}),chat:async messages=>{prompt=messages[0].content;return {content:'A suggested plan, not saved.'};}};
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),projects:[],ollamaClient:ollama});
  const data=fixture(),date=new Intl.DateTimeFormat('en-CA',{timeZone:data.timezone}).format(new Date());data.classes[0].day=new Date(date+'T12:00:00Z').getUTCDay();data.travelBefore=25;
  await app.vault.save(TIMETABLE_PATH,timetableMarkdown(data),null);await app.vault.addTask('Read chapter',{planDate:'2090-10-20',startTime:'11:00',duration:45,priority:'high'});
  const c=await app.store.conversation();await app.assistant.chat({id:c.id,message:'Help plan my day',mode:'plan'},new AbortController().signal,()=>{});
  assert.match(prompt,/TODAY CLASS COMMITMENTS/);assert.match(prompt,/Mathematics/);assert.match(prompt,/"travelBefore":25/);assert.match(prompt,/"duration":45/);assert.match(prompt,/"planDate":"2090-10-20"/);
});
