import {continueDay} from '../src/continue-day.mjs';
import {continueDayDrafts} from '../public/continue-day.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {taskLine} from '../src/task-meta.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-first-step-'));let calls=0;
 const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),backups:join(dir,'backups'),projects:[],ollamaClient:{model:'fixture',status:async()=>({online:false}),chat:async()=>{calls++;throw Error('No model call expected');}},workflowOptions:{pollMs:60000}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await app.workflows.close();app.calendar.close();app.recurring.stop();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
 const clock={now:new Date(2026,9,26,8)};app.dayPlanning.now=()=>clock.now;
 await app.vault.save('20 Projects/First step.md','# First step project\n\nOpen the lecture exercise. <img src=x>',null);
 await app.vault.addTask('Study discrete mathematics',{planDate:'2026-10-26',duration:30,project:'20 Projects/First step.md'});
 const task=(await app.vault.tasks()).find(t=>t.text==='Study discrete mathematics'),focus=app.dayPlanning.dailyFocus,steps=app.dayPlanning.firstSteps;
 const choose=async(action='focus')=>{const r=await focus.report(),row=r.rows.find(r=>r.taskId===task.id);return focus.decide({requestId:randomUUID(),taskId:task.id,date:r.date,timezone:r.timezone,revision:r.revision,contextRevision:row.contextRevision,action});};
 await choose();return {app,clock,task,focus,steps,choose,get calls(){return calls;}};
}
const input=async(f,extra={})=>({requestId:randomUUID(),taskId:f.task.id,revision:(await f.steps.report(f.task.id)).revision,text:'Open my notes and solve question one.',mode:'manual',acknowledge:true,...extra});

const outcomeInput=async(f,extra={})=>{const r=await f.steps.outcomes.report(f.task.id,extra.cardSequence);return {requestId:randomUUID(),taskId:f.task.id,cardSequence:r.card.sequence,revision:r.revision,kind:'blocked',note:'Need clarification on the first exercise.',acknowledge:true,...extra};};
const prepared=async t=>{const f=await fixture(t);await f.steps.save(await input(f));return f;};
const setup=async t=>{const f=await prepared(t);await f.steps.outcomes.record(await outcomeInput(f));return f;};
const planInput=async(f,ids=[f.task.id])=>{const r=await f.app.dayPlanning.outcomePlan('2026-10-27');return {requestId:randomUUID(),date:r.date,today:r.today,timezone:r.timezone,outcomeMode:true,selected:r.rows.filter(r=>ids.includes(r.taskId)).map(r=>({taskId:r.taskId,contextRevision:r.contextRevision})),start:'09:00',end:'18:00',gap:10};};
const preview=async(f,extra={})=>f.app.dayPlanning.nextDayPreview({...await planInput(f),...extra});
test('daily workspace is a read-only snapshot of explicit focus, step context and self-reported outcomes',async t=>{
 const f=await setup(t),notes=await f.app.vault.list(),focus=await f.focus.read(),state=await f.steps.read(),history=await f.app.vault.taskHistory.read();const r=await continueDay(f.app.dayPlanning);assert.equal(r.focused.length,1);assert.equal(r.focused[0].taskId,f.task.id);assert.equal(r.focused[0].step.latest.kind,'blocked');assert.equal(r.focused[0].task.done,false);assert.equal(r.focused[0].step.changed,(await f.steps.report(f.task.id)).changed);assert.deepEqual(await f.app.vault.list(),notes);assert.deepEqual(await f.focus.read(),focus);assert.deepEqual(await f.steps.read(),state);assert.deepEqual(await f.app.vault.taskHistory.read(),history);assert.equal((await f.app.store.list('workflows')).length,0);assert.equal(f.calls,0);
});
test('off, later and completed tasks never become workspace focus, including after midnight',async t=>{
 const f=await setup(t);await f.choose('off');assert.equal((await continueDay(f.app.dayPlanning)).focusTotal,0);await f.choose();const current=(await f.app.vault.tasks()).find(t=>t.id===f.task.id);await f.app.vault.toggleTask(current.path,current.line,current.revision,true);assert.equal((await continueDay(f.app.dayPlanning)).focusTotal,0);f.clock.now=new Date(2026,9,27,8);assert.equal((await continueDay(f.app.dayPlanning)).focusTotal,0);
});
test('changed project and new step reports appear without treating done-for-now as planner completion',async t=>{
 const f=await setup(t),n=await f.app.vault.read(f.task.project);await f.app.vault.save(n.path,n.content+'\nNew project detail',n.revision);await f.steps.outcomes.record(await outcomeInput(f,{kind:'done',note:'Finished this step'}));const r=await continueDay(f.app.dayPlanning);assert(r.focused[0].step.changed);assert.equal(r.focused[0].step.latest.note,'Finished this step');assert.equal(r.focused[0].task.done,false);assert.equal(r.focused[0].step.changed,(await f.steps.report(f.task.id)).changed);
});
test('missing and duplicate focus identities stay visible for repair rather than starting new work',async t=>{
 for(const kind of ['missing','duplicate']){const f=await setup(t);if(kind==='missing'){const n=await f.app.vault.read(f.task.path);await f.app.vault.trash(n.path,n.revision);}else await f.app.vault.save('40 Tasks/Duplicate.md','- [ ] '+taskLine('Duplicate',{},f.task.id),null);const r=await continueDay(f.app.dayPlanning);assert.equal(r.focusTotal,1);assert(r.focused[0].identityIssue);assert.equal(r.focused[0].task,null);assert(r.focused[0].step.changed);}
});
test('damaged focus and step history remain errors, and independent saved reviews stay accessible',async t=>{
 const f=await setup(t),p=await preview(f);await writeFile(f.steps.path,'broken');let r=await continueDay(f.app.dayPlanning);assert.match(r.focused[0].stepError,/cannot be read/);assert.equal(r.reviews[0].id,p.id);await writeFile(f.focus.path,'broken');r=await continueDay(f.app.dayPlanning);assert.equal(r.focusAvailable,false);assert(r.warnings.some(w=>/focus cannot be read/.test(w)));assert.equal(r.reviews[0].id,p.id);assert.equal(await readFile(f.steps.path,'utf8'),'broken');
});
test('saved review navigation lists only unfinished planner proposals, including interrupted older work',async t=>{
 const f=await setup(t),pending=await preview(f);await f.app.store.proposal({kind:'memory',title:'Not a planning review'});let r=await continueDay(f.app.dayPlanning);assert.equal(r.reviews.length,1);assert.equal(r.reviews[0].savedNotes,0);assert.equal(r.reviews[0].totalNotes,1);f.clock.now=new Date(2026,9,29,8);r=await continueDay(f.app.dayPlanning);assert.equal(r.reviews[0].id,pending.id);await f.app.dayPlanning.decide(pending.id,'dismiss');assert.equal((await continueDay(f.app.dayPlanning)).reviews.length,0);
});
test('workspace catches a day rollover while loading and never rolls focus forward',async t=>{
 const f=await setup(t),day=f.app.dayPlanning,brief=day.briefing.bind(day);day.briefing=async()=>{const r=await brief();f.clock.now=new Date(2026,9,27,8);return r;};const state=await f.focus.read(),r=await continueDay(day);assert(r.warnings.some(w=>w.includes('day changed')));assert.deepEqual(await f.focus.read(),state);
});
test('current attention and prepared execution drafts are exposed without resuming their workflows',async t=>{
 const f=await prepared(t),d=await f.app.taskWorkflows.draft({task:(await f.app.vault.tasks()).find(t=>t.id===f.task.id)});let r=await continueDay(f.app.dayPlanning);assert(r.executionDrafts.some(x=>x.id===d.id));const real=f.app.dayPlanning.taskWorkflows.summary.bind(f.app.dayPlanning.taskWorkflows);f.app.dayPlanning.taskWorkflows.summary=async(...args)=>(await real(...args)).map(x=>({...x,attention:{label:'Decision needed'},detail:'Review the prepared plan'}));r=await continueDay(f.app.dayPlanning);assert.equal(r.attention[0].id,d.id);assert.equal((await f.app.store.list('workflows')).length,0);
});
test('workspace endpoint and module are available without model calls or automatic decisions',async t=>{
 const f=await setup(t);await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+f.app.server.address().port;const r=await(await fetch(url+'/api/continue-day')).json();assert.equal(r.focused[0].taskId,f.task.id);assert.equal((await fetch(url+'/continue-day.js')).status,200);assert.equal((await fetch(url+'/api/continue-day',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);assert.equal(f.calls,0);
});
const storage=entries=>{const m=new Map(entries);return {get length(){return m.size},key:i=>[...m.keys()][i],getItem:k=>m.get(k)??null,setItem:()=>assert.fail('Discovery must not write'),removeItem:()=>assert.fail('Discovery must not delete')};};
test('local draft discovery stays within the vault and uses explicit routes for separate editors',()=>{
 const vault='/tmp/vault',id=randomUUID(),pid=randomUUID(),keys=[['aurora-first-step:'+vault+':'+id,{version:1,text:'First <img>',pending:{}}],['aurora-step-outcome:'+vault+':'+id+':2',{note:'Outcome'}],['aurora-remainder-draft:'+vault+':follow:'+pid+':'+id,{rows:[],pending:{}}],['aurora-summary-draft:'+vault+':2026-10-26',{body:'Reflection'}],['aurora-evening-choices:'+vault+':2026-10-26:focus-review-request',{}],['aurora-weekly-choices:'+vault+':2026-10-26',{}],['aurora-next-day-draft:'+vault,{}],['aurora-checkin-decision:'+vault,{id}],['aurora-first-step:'+vault+'-other:'+id,{}],['aurora-first-step:'+vault+':invalid',{}],['unknown:'+vault,{}]];const r=continueDayDrafts(storage(keys.map(([k,v])=>[k,JSON.stringify(v)])),vault);assert.equal(r.rows.length,8);assert.equal(r.rows.find(r=>r.route.type==='follow-adjust').route.proposalId,pid);assert.equal(r.rows.find(r=>r.route.type==='outcome').route.sequence,2);assert.equal(r.rows.find(r=>r.route.type==='first-step').text,'First <img>');assert.equal(r.rows.find(r=>r.route.type==='checkin-detail').route.id,id);
});
test('unreadable local drafts stay discoverable through their owning editor without interpreting stored markup',()=>{
 const vault='/tmp/vault',id=randomUUID(),r=continueDayDrafts(storage([['aurora-first-step:'+vault+':'+id,'<img src=x>'],['aurora-follow-through-choice:'+vault,'null'],['aurora-summary-draft:'+vault+':2026-02-30','{}']]),vault);assert.equal(r.rows.length,2);assert(r.rows.every(r=>r.unreadable));assert(r.rows.some(r=>r.route.taskId===id));
});
test('storage access errors remain visible without clearing or inventing drafts',()=>{const r=continueDayDrafts({get length(){throw Error('Blocked')}},'/tmp/vault');assert.equal(r.rows.length,0);assert.equal(r.warnings.length,1);});

test('unavailable review storage is not reported as an empty completed inbox',async t=>{
 const f=await setup(t),list=f.app.store.list.bind(f.app.store);f.app.store.list=async kind=>{if(kind==='proposals')throw Error('Review store unavailable');return list(kind);};const r=await continueDay(f.app.dayPlanning);assert.equal(r.reviewsAvailable,false);assert(r.warnings.some(w=>w.includes('Review store unavailable')));assert.equal(r.focused[0].taskId,f.task.id);
});
