import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {SessionReviews} from '../src/session-reviews.mjs';
import {taskLine} from '../src/task-meta.mjs';
import {FocusSessions} from '../src/focus-sessions.mjs';
import {continueDay} from '../src/continue-day.mjs';
import {continueDayDrafts} from '../public/continue-day.js';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-sessions-'));let calls=0;
 const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),backups:join(dir,'backups'),projects:[],ollamaClient:{model:'fixture',status:async()=>({online:false}),chat:async()=>{calls++;throw Error('Unexpected model call');}},workflowOptions:{pollMs:60000}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await app.workflows.close();app.calendar.close();app.recurring.stop();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 const day=app.dayPlanning,clock={now:new Date(2026,9,27,8),mono:1000};day.now=()=>clock.now;const sessions=day.focusSessions;sessions.clock=()=>clock.mono;
 const advance=ms=>{clock.now=new Date(+clock.now+ms);clock.mono+=ms;};
 const prepare=async(text='Read discrete mathematics notes')=>{await app.vault.addTask(text,{planDate:'2026-10-27',duration:30});const task=(await app.vault.tasks()).find(t=>t.text===text),r=await day.dailyFocus.report(),row=r.rows.find(r=>r.taskId===task.id);await day.dailyFocus.decide({requestId:randomUUID(),taskId:task.id,date:r.date,timezone:r.timezone,revision:r.revision,contextRevision:row.contextRevision,action:'focus'});await day.firstSteps.save({requestId:randomUUID(),taskId:task.id,revision:(await day.firstSteps.report(task.id)).revision,text:'Read exercise one <img src=x>',mode:'manual',acknowledge:true});return task;};
 const task=await prepare();return {app,day,clock,sessions,task,advance,prepare,get calls(){return calls;}};
}
const input=async(f,action='start',id,extra={})=>({requestId:randomUUID(),action,revision:(await f.sessions.report(id?{id}:{taskId:f.task.id})).revision,note:'',acknowledge:true,...(id?{id}:{taskId:f.task.id}),...extra});
const start=async f=>(await f.sessions.change(await input(f))).session.id;
const act=async(f,action,id,extra={})=>f.sessions.change(await input(f,action,id,extra));

const refocus=async f=>{await f.app.vault.scheduleTask({...((await f.app.vault.tasks()).find(t=>t.id===f.task.id)),planDate:(await f.day.candidates()).date});const r=await f.day.dailyFocus.report(),row=r.rows.find(r=>r.taskId===f.task.id);await f.day.dailyFocus.decide({requestId:randomUUID(),taskId:f.task.id,date:r.date,timezone:r.timezone,revision:r.revision,contextRevision:row.contextRevision,action:'focus'});await f.day.firstSteps.save({requestId:randomUUID(),taskId:f.task.id,revision:(await f.day.firstSteps.report(f.task.id)).revision,text:'Read exercise one',mode:'manual',acknowledge:true});};
const report=(f,period='day',date='2026-10-27')=>f.day.sessionReviews[period].report(date);
const draft=async(f,period='day',body)=>{const r=await report(f,period);return {requestId:randomUUID(),date:r.date,sourceRevision:r.sourceRevision,targetRevision:r.target?.revision||null,body:body||r.suggested};};
const preview=async(f,period='day',body)=>f.day.sessionReviews[period].preview(await draft(f,period,body));
test('closed intervals add exactly across daily and weekly reviews; paused and open time are excluded',async t=>{
 const f=await fixture(t),id=await start(f);f.advance(60000);await act(f,'pause',id);f.advance(300000);await act(f,'resume',id);f.advance(30000);await act(f,'finish',id);f.advance(86400000);await refocus(f);const next=await start(f);f.advance(20000);await act(f,'pause',next);await act(f,'resume',next);f.advance(9000);
 const a=await report(f),b=await report(f,'day','2026-10-28'),w=await report(f,'week');assert.equal(a.sources.totals.recordedMilliseconds,90000);assert.equal(b.sources.totals.recordedMilliseconds,20000);assert.equal(w.sources.totals.recordedMilliseconds,110000);assert.equal(w.sources.totals.openIntervals,1);assert.equal(w.sources.days.reduce((s,d)=>s+d.recordedMilliseconds,0),110000);assert.match(w.suggested,/not proof of productive work/);
});
test('midnight and week crossings belong wholly to the closing date, with zero time on the start date',async t=>{
 const f=await fixture(t);f.clock.now=new Date(2026,10,1,23,59);await refocus(f);const id=await start(f);f.advance(120000);await act(f,'finish',id);assert.equal((await report(f,'day','2026-11-01')).sources.totals.recordedMilliseconds,0);assert.equal((await report(f,'day','2026-11-02')).sources.totals.recordedMilliseconds,120000);assert.equal((await report(f,'week','2026-11-01')).sources.totals.recordedMilliseconds,0);assert.equal((await report(f,'week','2026-11-02')).sources.totals.recordedMilliseconds,120000);
});
test('restart and clock gaps are visible unknown durations, never estimated from wall time',async t=>{
 const f=await fixture(t),id=await start(f);f.advance(20000);f.sessions=f.day.focusSessions=new FocusSessions({planner:f.day,data:f.app.config.data});f.sessions.clock=()=>f.clock.mono;assert.equal((await report(f)).sources.totals.openIntervals,1);await act(f,'pause',id);await act(f,'resume',id);f.clock.now=new Date(+f.clock.now+600000);await act(f,'finish',id);const r=await report(f);assert.equal(r.sources.totals.recordedMilliseconds,0);assert.equal(r.sources.totals.unrecordedIntervals,2);assert.match(r.suggested,/Unrecorded:/);
});
test('read-only review revisions remain stable while the same open interval advances',async t=>{
 const f=await fixture(t);await start(f);const state=await readFile(f.sessions.path,'utf8'),notes=await f.app.vault.list(),steps=await f.day.firstSteps.read(),a=await report(f);f.advance(60000);assert.equal((await report(f)).sourceRevision,a.sourceRevision);assert.equal(await readFile(f.sessions.path,'utf8'),state);assert.deepEqual(await f.app.vault.list(),notes);assert.deepEqual(await f.day.firstSteps.read(),steps);assert.equal(f.calls,0);assert.equal((await f.app.store.list('workflows')).length,0);
});
test('review grouping uses its displayed timezone and retains the original session timezone',async t=>{
 const f=await fixture(t);f.day.dailyFocus.timezone=()=> 'UTC';f.clock.now=new Date('2026-10-27T23:59:00Z');await refocus(f);const id=await start(f);f.advance(120000);await act(f,'finish',id);f.day.dailyFocus.timezone=()=> 'America/Los_Angeles';const r=await report(f);assert.equal(r.sources.timezone,'America/Los_Angeles');assert.equal(r.sources.rows[0].timezoneMismatch,true);assert.equal(r.sources.totals.recordedMilliseconds,120000);assert.equal(r.sources.rows[0].intervals[0].date,'2026-10-27');
});
test('historical reviews retain latest self-reports for pinned steps, current task state and AI evidence separately',async t=>{
 const f=await fixture(t),id=await start(f);f.advance(50000);await act(f,'finish',id);const outcomes=f.day.firstSteps.outcomes;
 for(const kind of ['blocked','done']){const r=await outcomes.report(f.task.id);await outcomes.record({requestId:randomUUID(),taskId:f.task.id,cardSequence:r.card.sequence,revision:r.revision,kind,note:'My own report '+kind,acknowledge:true});}
 f.day.execution=async()=>[{id:'attempt',taskId:f.task.id,detail:'Needs checking',results:{notice:'Partial record',checksPassed:1,checksTotal:2,steps:[{title:'Read',status:'completed',summary:'Read only'}],stepCount:3,error:'Verification failed',question:'Which source?',unresolved:['Output is missing']}}];const r=await report(f);assert.equal(r.sources.outcomes.length,1);assert.equal(r.sources.outcomes[0].kind,'done');assert.equal(r.sources.tasks[0].current.done,false);assert.match(r.suggested,/not verified AI work/);assert.match(r.suggested,/Showing 1 of 3/);assert.match(r.suggested,/Verification failed/);assert.match(r.suggested,/Output is missing/);assert.match(r.suggested,/Current planner checkbox: open/);
});
test('missing or duplicate tasks retain original references without attributing completion or AI results',async t=>{
 const f=await fixture(t);await start(f);f.day.execution=async()=>[{id:'attempt',taskId:f.task.id,detail:'Completed'}];await f.app.vault.save('40 Tasks/Copy.md','- [x] '+taskLine('Duplicate',{},f.task.id),null);let r=await report(f);assert.match(r.sources.tasks[0].issue,/Duplicate/);assert.equal(r.sources.tasks[0].current,null);assert.equal(r.sources.execution.length,0);for(const path of [f.task.path,'40 Tasks/Copy.md']){const n=await f.app.vault.read(path);await f.app.vault.trash(path,n.revision);}r=await report(f);assert.match(r.sources.tasks[0].issue,/unavailable/);assert.equal(r.sources.tasks[0].reference.text,f.task.text);
});
test('day and week use independent destinations, reviews and canonical Monday dates',async t=>{
 const f=await fixture(t),a=await preview(f),b=await preview(f,'week');assert.equal(b.date,'2026-10-26');assert.notEqual(a.path,b.path);assert.equal((await f.day.sessionReviews.day.index()).length,1);assert.equal((await f.day.sessionReviews.week.index()).length,1);assert.equal((await continueDay(f.day)).sessionReviews.length,2);await assert.rejects(f.day.sessionReviews.week.preview({...await draft(f,'week'),date:'2026-10-27'}));await assert.rejects(report(f,'week','nonsense'));await assert.rejects(report(f,'day','2026-10-28'));
});
test('explicit summary saving publishes journal Markdown and never creates planner tasks',async t=>{
 const f=await fixture(t);await start(f);const tasks=await f.app.vault.tasks(),state=await f.sessions.read(),d=await draft(f,'day','Personal reflection\n\n- [ ] This is journal text'),p=await f.day.sessionReviews.day.preview(d);assert.equal((await report(f)).target,null);assert.equal((await f.day.sessionReviews.day.preview(d)).id,p.id);await assert.rejects(f.day.sessionReviews.day.preview({...d,body:'Changed'}),/already used/);await f.day.sessionReviews.day.decide({id:p.id,action:'save'});const n=await f.app.vault.read(p.path);assert.equal(n.kind,'session-summary-day');assert.equal(n.status,'journal');assert.deepEqual(await f.app.vault.tasks(),tasks);assert.deepEqual(await f.sessions.read(),state);assert.equal((await f.day.sessionReviews.day.index()).length,0);
});
test('session actions, task changes, outcomes, AI attempts and observation day invalidate stale reviews',async t=>{
 for(const kind of ['session','task','outcome','execution','day']){const f=await fixture(t),id=await start(f),p=await preview(f);if(kind==='session')await act(f,'pause',id);if(kind==='task')await f.app.vault.scheduleTask({...f.task,duration:50});if(kind==='execution')f.day.execution=async()=>[{id:'new',taskId:f.task.id,detail:'Waiting'}];if(kind==='day')f.advance(86400000);if(kind==='outcome'){const r=await f.day.firstSteps.outcomes.report(f.task.id);await f.day.firstSteps.outcomes.record({requestId:randomUUID(),taskId:f.task.id,cardSequence:r.card.sequence,revision:r.revision,kind:'continue',note:'Still working',acknowledge:true});}await assert.rejects(f.day.sessionReviews.day.decide({id:p.id,action:'save'}),/sources or the saved note changed/);assert.equal((await report(f)).target,null);}
});
test('source changes at the atomic replacement boundary block summary publication',async t=>{
 const f=await fixture(t),id=await start(f),p=await preview(f),save=f.app.vault.save.bind(f.app.vault);f.app.vault.save=async(...a)=>{await act(f,'pause',id);return save(...a);};await assert.rejects(f.day.sessionReviews.day.decide({id:p.id,action:'save'}),/sources or the saved note changed/);assert.equal((await report(f)).target,null);
});
test('lost save receipts recover after restart and later note edits or deletion without replaying text',async t=>{
 for(const period of ['day','week'])for(const deleted of [false,true]){const f=await fixture(t),p=await preview(f,period),put=f.app.store.put.bind(f.app.store);f.app.store.put=async(k,r)=>{if(k==='session-summaries-'+period&&r.status==='saved')throw Error('lost receipt');return put(k,r);};await assert.rejects(f.day.sessionReviews[period].decide({id:p.id,action:'save'}),/may already be saved/);f.app.store.put=put;const n=await f.app.vault.read(p.path);if(deleted)await f.app.vault.trash(p.path,n.revision);else await f.app.vault.save(p.path,n.content+'\nLater edit',n.revision);const notes=await f.app.vault.list();f.advance(86400000);const fresh=new SessionReviews({planner:f.day,period});assert.equal((await fresh.decide({id:p.id,action:'save'})).status,'saved');assert.deepEqual(await f.app.vault.list(),notes);}
});
test('unconfirmed writes without surviving evidence require a new review rather than automatic replay',async t=>{
 const f=await fixture(t),p=await preview(f),save=f.app.vault.save;f.app.vault.save=async()=>{throw Error('disk');};await assert.rejects(f.day.sessionReviews.day.decide({id:p.id,action:'save'}),/may already be saved/);f.app.vault.save=save;await assert.rejects(f.day.sessionReviews.day.decide({id:p.id,action:'save'}),/cannot be confirmed/);assert.equal((await report(f)).target,null);assert.equal((await f.day.sessionReviews.day.index())[0].writeAttempted,true);await f.day.sessionReviews.day.decide({id:p.id,action:'dismiss'});
});
test('unrelated and externally edited targets are protected',async t=>{
 const f=await fixture(t),p=await preview(f);await f.day.sessionReviews.day.decide({id:p.id,action:'save'});const next=await preview(f),n=await f.app.vault.read(p.path);await f.app.vault.save(p.path,n.content+'\nExternal edit',n.revision);await assert.rejects(f.day.sessionReviews.day.decide({id:next.id,action:'save'}),/sources or the saved note changed/);const w=await report(f,'week');await f.app.vault.save(w.path,'Unrelated note',null);await assert.rejects(preview(f,'week'),/Another note occupies/);
});
test('damaged session or first-step history blocks review publication instead of inventing empty history',async t=>{
 for(const source of ['focusSessions','firstSteps']){const f=await fixture(t);await start(f);const p=await preview(f);await writeFile(f.day[source].path,'bad');await assert.rejects(report(f),/cannot be read/);await assert.rejects(f.day.sessionReviews.day.decide({id:p.id,action:'save'}),/cannot be read/);}
});
test('damaged durable review records cannot redirect a save into another note',async t=>{
 const f=await fixture(t),p=await preview(f),r=await f.app.store.get('session-summaries-day',p.id);r.path='10 Profile/About me.md';await f.app.store.put('session-summaries-day',r);await assert.rejects(f.day.sessionReviews.day.get(p.id),/damaged/);await assert.rejects(f.day.sessionReviews.day.index(),/damaged/);assert.equal((await continueDay(f.day)).reviewsAvailable,false);
});
test('local recovery discovery isolates vaults, periods, canonical weeks and malformed drafts',()=>{
 const vault='/vault',m=new Map([['day:2026-10-27','{bad'],['week:2026-10-26',JSON.stringify({body:'Weekly reflection'})],['week:2026-10-27','{}'],['day:2026-02-30','{}'],['other:2026-10-27','{}']].map(([s,v])=>['aurora-session-summary:'+vault+':'+s,v]));m.set('aurora-session-summary:/other:day:2026-10-27','{}');const before=[...m],storage={length:m.size,key:i=>[...m.keys()][i],getItem:k=>m.get(k)},r=continueDayDrafts(storage,vault);assert.equal(r.rows.length,2);assert.equal(r.rows[0].unreadable,true);assert.equal(r.rows[1].text,'Weekly reflection');assert.deepEqual([...m],before);
});
test('session review endpoints authenticate writes and serve both renderer modules',async t=>{
 const f=await fixture(t);await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.app.server.address().port,boot=await(await fetch(base+'/api/bootstrap')).json(),post=(p,d,token)=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-Aster-Token':token}:{})},body:JSON.stringify(d)});
 for(const period of ['day','week']){const path='/api/session-summary/'+period;for(const p of ['/preview','/decide'])assert.equal((await post(path+p,{})).status,403);const c=await(await fetch(base+path+'?date=2026-10-27')).json(),p=await post(path+'/preview',{requestId:randomUUID(),date:c.date,sourceRevision:c.sourceRevision,targetRevision:null,body:c.suggested},boot.token);assert.equal(p.status,200);const r=await p.json();assert.equal(r.period,period);assert.equal(r.intent,undefined);assert.equal((await post(path+'/decide',{id:r.id,action:'save'},boot.token)).status,200);assert.equal((await fetch(base+path+'/review?id='+r.id)).status,200);}for(const path of ['/session-review.js','/session-summary.js'])assert.equal((await fetch(base+path)).status,200);
});

test('fresh installations have empty readable session summary history',async t=>{const f=await fixture(t);assert.deepEqual(await f.day.sessionReviews.day.index(),[]);assert.deepEqual(await f.day.sessionReviews.week.index(),[]);assert.equal((await continueDay(f.day)).reviewsAvailable,true);});
