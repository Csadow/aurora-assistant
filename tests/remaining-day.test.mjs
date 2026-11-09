import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Vault} from '../src/vault.mjs';
import {Store} from '../src/store.mjs';
import {TaskHistory} from '../src/task-history.mjs';
import {DailyFocus} from '../src/daily-focus.mjs';
import {DailyCheckins} from '../src/daily-checkins.mjs';
import {DayPlanning} from '../src/day-planning.mjs';
import {createApp} from '../src/server.mjs';
import {TIMETABLE_PATH,emptyTimetable,timetableMarkdown} from '../mobile/web/timetable.js';
import {remainingFit,remainingContext} from '../public/remaining-day.js';
const date='2096-06-11';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-remaining-'));t.after(()=>rm(dir,{recursive:true,force:true}));const vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data')),clock={now:new Date(2096,5,11,10,10)},links=[];await vault.init();await store.init();
 const history=new TaskHistory({vault,data:store.root,now:()=>clock.now.toISOString()});await history.init();const opts={vault,store,taskWorkflows:{summary:async()=>links},now:()=>clock.now},day=new DayPlanning(opts);day.dailyFocus=new DailyFocus({...opts,history,data:store.root});day.checkins=new DailyCheckins({planner:day,data:store.root});
 let fresh=0;const cal={enabled:true,complete:true,revision:'a',warnings:[],from:'2096-06-01',to:'2096-07-01',events:[{id:'busy',summary:'Calendar appointment <img>',start:{dateTime:new Date(2096,5,11,11,15).toISOString()},end:{dateTime:new Date(2096,5,11,12).toISOString()}}]};day.calendar={context:async options=>{if(options)assert.equal(options.includeLinked,true);return cal;},fresh:async()=>{fresh++;return cal;}};
 const tt={...emptyTimetable(),travelConfirmed:true,classes:[{id:'late',day:clock.now.getDay(),title:'Late class <img>',location:'Campus',start:'10:00',end:'10:30'}]};await vault.save(TIMETABLE_PATH,timetableMarkdown(tt),null);
 const meta={planDate:date,startTime:'07:00',duration:30,due:'2096-06-15',remindAt:'2096-06-14T04:00:00Z'};await vault.addTask('Small task <img>',meta);await vault.addTask('Long task',{...meta,startTime:'08:00',duration:90});await vault.addTask('In progress',{...meta,startTime:'10:00',duration:15});await vault.addTask('Fixed later',{...meta,startTime:'12:30'});
 const input=async extra=>{const r=await day.candidates();return {date:r.date,timezone:r.timezone,selected:r.tasks.filter(t=>t.text.startsWith('Small')||t.text==='Long task'),start:'10:00',end:'12:00',gap:5,...extra};};
 const snapshot=async()=>({notes:await vault.list(),history:await history.read(),focus:await day.dailyFocus.read(),checkins:await day.checkins.read(),proposals:await store.list('proposals'),workflows:await store.list('workflows')});
 return {vault,store,clock,links,history,day,cal,tt,input,snapshot,get fresh(){return fresh;}};
}
test('remaining fit reads cached commitments, preserves state and agrees with the actual preview engine',async t=>{
 const f=await fixture(t),i=await f.input(),before=await f.snapshot(),r=await f.day.assessRemainder(i);assert.equal(f.fresh,0);assert.deepEqual(await f.snapshot(),before);assert.equal(r.changes.find(c=>c.before.text.startsWith('Small')).after.startTime,'10:35');assert(r.changes.find(c=>c.before.text==='Long task').unplaced);assert.equal(r.targetDays[0].capacity.placedMinutes,30);assert.equal(r.targetDays[0].capacity.untimedMinutes,90);
 const p=await f.day.preview({...i,requestId:randomUUID()});assert.equal(f.fresh,1);assert.deepEqual(r.changes,p.changes.map(({before,after,unplaced})=>({before,after,unplaced})));assert.deepEqual(r.targetDays,p.targetDays);
});
test('empty selection only measures fixed commitments; explicit start bound and saved availability constrain fit',async t=>{
 const f=await fixture(t),before=await f.snapshot(),empty=await f.day.assessRemainder(await f.input({selected:[]}));assert.deepEqual(empty.changes,[]);assert.equal(empty.targetDays[0].capacity.selectedMinutes,0);assert.deepEqual(await f.snapshot(),before);await assert.rejects(f.day.preview({...await f.input({selected:[]}),requestId:randomUUID()}),/Select/);
 const late=await f.day.assessRemainder(await f.input({start:'11:40'}));assert(late.changes.every(c=>c.unplaced));const n=await f.vault.read(TIMETABLE_PATH);await f.vault.save(n.path,timetableMarkdown({...f.tt,availability:{gap:15,days:Array.from({length:7},()=>[['11:00','11:15']])}}),n.revision);const r=await f.day.assessRemainder(await f.input());assert.equal(r.targetDays[0].breakMinutes,15);assert(r.changes.every(c=>c.unplaced));
});
test('incomplete Calendar coverage and class information refuse a fit claim without refreshing or making proposals',async t=>{
 const f=await fixture(t);for(const patch of [{complete:false},{from:'2096-06-12'},{to:date}]){const saved={...f.cal};Object.assign(f.cal,patch);await assert.rejects(f.day.assessRemainder(await f.input()),/Refresh Google Calendar/);Object.assign(f.cal,saved);}
 const n=await f.vault.read(TIMETABLE_PATH);await f.vault.save(n.path,timetableMarkdown({...f.tt,unknownDays:[f.clock.now.getDay()]}),n.revision);await assert.rejects(f.day.assessRemainder(await f.input()),/incomplete class/);assert.equal(f.fresh,0);assert.deepEqual(await f.store.list('proposals'),[]);
});
test('active reservations, active attempts and stale selected tasks cannot be assessed as movable work',async t=>{
 const f=await fixture(t),rows=(await f.day.candidates()).tasks;await assert.rejects(f.day.assessRemainder(await f.input({selected:rows.filter(t=>t.text==='In progress')})),/in progress/);
 const input=await f.input();f.links.push({id:'attempt',taskId:input.selected[0].id,status:'running',executionRevision:'a'});await assert.rejects(f.day.assessRemainder(input),/current attempt/);f.links.length=0;await f.vault.scheduleTask({...input.selected[0],duration:45});await assert.rejects(f.day.assessRemainder(input),/selection changed/);assert.deepEqual(await f.store.list('proposals'),[]);
});
test('date, timezone and a midnight rollover are rejected without rolling a draft forward',async t=>{
 const f=await fixture(t);for(const patch of [{date:'2096-06-10'},{timezone:'wrong'}])await assert.rejects(f.day.assessRemainder(await f.input(patch)),/day or timezone/);const before=await f.snapshot();f.day.calendar.context=async()=>{f.clock.now=new Date(2096,5,12,0,1);return f.cal;};await assert.rejects(f.day.assessRemainder(await f.input()),/day or timezone changed while/);assert.deepEqual(await f.snapshot(),before);
});
test('a fit result gives no save authority: fresh Calendar changes alter preview and later changes block saving',async t=>{
 const f=await fixture(t),i=await f.input(),r=await f.day.assessRemainder(i);assert(r.changes.some(c=>!c.unplaced));f.cal.events[0].start.dateTime=new Date(2096,5,11,10,30).toISOString();f.cal.revision='b';const p=await f.day.preview({...i,requestId:randomUUID()});assert(p.changes.every(c=>c.unplaced));const notes=await f.vault.list();f.cal.revision='c';await assert.rejects(f.day.decide(p.id,'accept'),/Google Calendar changed/);assert.deepEqual(await f.vault.list(),notes);
});
test('check-in assessment respects its explicit window, and a lost save reply recovers without replaying later edits',async t=>{
 const f=await fixture(t),i=await f.input(),entry=await f.day.checkins.create({requestId:randomUUID(),date:i.date,timezone:i.timezone,kind:'interruption',note:'Class ran late',selected:i.selected.map(t=>({taskId:t.id,contextRevision:t.contextRevision})),start:'10:40',end:'12:00',gap:5}),input={...i,start:entry.start,checkin:{id:entry.id,revision:entry.revision}};await assert.rejects(f.day.assessRemainder({...input,start:'10:30'}),/work window/);const before=await f.snapshot(),r=await f.day.assessRemainder(input);assert.deepEqual(await f.snapshot(),before);assert.equal(r.changes.find(c=>!c.unplaced).after.startTime,'10:40');
 const p=await f.day.preview({...input,requestId:randomUUID()});await f.day.decide(p.id,'accept');const t0=(await f.vault.tasks()).find(t=>t.id===i.selected[0].id);await f.vault.scheduleTask({...t0,startTime:'13:30'});const saved=await f.snapshot();await f.day.decide(p.id,'accept');assert.deepEqual(await f.snapshot(),saved);for(const key of ['id','done','due','remindAt','duration','priority'])assert.deepEqual(t0[key],i.selected[0][key]);assert.equal((await f.day.checkins.report()).entries[0].status,'open');
});
test('remaining context and decisions escape source text and distinguish a comparison from a saved plan',async t=>{
 const f=await fixture(t),r=await f.day.assessRemainder(await f.input()),escape=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');let html=remainingFit(r,escape);assert(!html.includes('<img>'));assert(html.includes('not a saved plan'));assert(html.includes('Uncheck it'));assert(html.includes('data-remaining-held'));
 html=remainingContext(await f.day.candidates(),{generatedAt:f.clock.now.toISOString(),day:{blocks:[{end:700,time:'11:00',title:'<svg>',kind:'calendar'}],conflicts:[],unknown:true},warnings:['<script>']},escape);assert(!html.includes('<svg>'));assert(!html.includes('<script>'));assert(html.includes('In progress'));assert(html.includes('incomplete'));
});
test('assessment endpoint is authenticated, serves the native module and does not store a proposal',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-assess-api-')),app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),backups:join(dir,'backups'),projects:[],ollamaClient:{status:async()=>({online:false})},workflowOptions:{pollMs:60000}});t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await app.workflows.close();app.calendar.close();app.recurring.stop();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.server.address().port,b=await(await fetch(url+'/api/bootstrap')).json(),c=await app.dayPlanning.candidates(),body=JSON.stringify({date:c.date,timezone:c.timezone,selected:[],start:'00:00',end:'23:59',gap:0});assert.equal((await fetch(url+'/api/replan/assess',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);const response=await fetch(url+'/api/replan/assess',{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':b.token},body});assert.equal(response.status,200);assert.deepEqual((await response.json()).changes,[]);assert.deepEqual(await app.store.list('proposals'),[]);assert.equal((await fetch(url+'/remaining-day.js')).status,200);
});
