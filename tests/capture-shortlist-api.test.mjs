import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {taskLine} from '../src/task-meta.mjs';
import {firstStepContext} from '../src/first-steps.mjs';
import {captureReviewFilters} from '../src/captured-tasks.mjs';
async function setup(t,count=3){
 const dir=await mkdtemp(join(tmpdir(),'aurora-shortlist-')),app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],ollamaClient:{status:async()=>({online:false,models:[]})}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
 const ids=Array.from({length:count},()=>randomUUID()),now=new Date();await app.vault.save('40 Tasks/Shortlist API.md',ids.map((id,i)=>'- [ ] '+taskLine('Shortlist task '+i,{},id)).join('\n'),null);
 for(const [i,id] of ids.entries())await app.store.put('proposals',{id:randomUUID(),kind:'task',created:now.toISOString(),origin:'desktop_capture',status:'accepted',acceptedAt:new Date(+now-i*1000).toISOString(),review:{version:1,path:'40 Tasks/Shortlist API.md',after:{id,text:'Shortlist task '+i}}});
 const base='http://127.0.0.1:'+app.server.address().port,boot=await(await fetch(base+'/api/bootstrap')).json(),headers={'Content-Type':'application/json','X-Aster-Token':boot.token};return {app,ids,base,headers};
}
test('capture progress and local-edit filters apply before the forty-row limit and do not write notes',async t=>{
 const {app,ids}=await setup(t,46),p=app.dayPlanning,notes=await app.vault.list(),focus=await p.dailyFocus.build(undefined,{includeIds:ids}),cards={};
 for(const id of ids.slice(0,45)){const r=focus.rows.find(r=>r.taskId===id);cards[id]={sequence:1,text:'A saved step',mode:'manual',context:firstStepContext(r,focus.date,focus.timezone,notes)};}
 const original=p.firstSteps.read;p.firstSteps.read=async()=>({cards});
 let r=await p.capturedTasks.review({status:'no-step'});assert.equal(r.counts.matched,1);assert.equal(r.rows[0].taskId,ids[45]);
 r=await p.capturedTasks.review({status:'draft',draftIds:[ids[45]]});assert.equal(r.counts.matched,1);assert.equal(r.rows[0].taskId,ids[45]);assert.equal(r.rows[0].localDraft,true);assert.equal(r.rows[0].planning.issue,null);
 cards[ids[45]]={sequence:1,text:'An older step',mode:'manual',context:{date:focus.date}};r=await p.capturedTasks.review({status:'changed'});assert.equal(r.counts.matched,1);assert.equal(r.rows[0].taskId,ids[45]);assert.deepEqual(await app.vault.list(),notes);p.firstSteps.read=original;
});
test('selected task context remains available outside capture filters and shows prerequisites, fixed work and missing identity',async t=>{
 const {app,ids}=await setup(t),p=app.dayPlanning;let tasks=await app.vault.tasks(),a=tasks.find(t=>t.id===ids[0]);await app.vault.scheduleTask({...a,dependsOn:[ids[1]]});tasks=await app.vault.tasks();const b=tasks.find(t=>t.id===ids[1]);await app.vault.scheduleTask({...b,planDate:'2091-04-10',startTime:'09:00'});const missing=randomUUID(),r=await p.capturedTasks.review({query:'no matching words',date:'2091-04-10',selectedIds:[ids[0],ids[1],missing]});assert.equal(r.rows.length,0);assert.match(r.planning.rows[0].issue,/prerequisite|waiting|unfinished/i);assert.match(r.planning.rows[1].issue,/timed commitment/);assert.match(r.planning.rows[2].issue,/missing/);
});
test('unavailable progress and planning keep readable captures without claiming no saved step',async t=>{
 const {app}=await setup(t),p=app.dayPlanning;p.firstSteps.read=async()=>{throw Error('Unreadable first steps');};let r=await p.capturedTasks.review({status:'no-step'});assert.equal(r.rows.length,0);assert(r.warnings.some(w=>w.includes('may omit')));const execution=p.execution;p.execution=async()=>{throw Error('Unavailable attempts');};r=await p.capturedTasks.review();assert.equal(r.rows.length,3);assert(r.planning.warnings.some(w=>w.includes('Unavailable attempts')));assert(r.rows.every(r=>r.planning===null));p.execution=execution;
});
test('review API requires local authorization and validates shortlist, status, date and local draft IDs',async t=>{
 const {base,headers,app}=await setup(t),before=await app.vault.list(),post=(data,h=headers)=>fetch(base+'/api/captured-tasks/review',{method:'POST',headers:h,body:JSON.stringify(data)});
 assert.equal((await post({}, {'Content-Type':'application/json'})).status,403);assert.equal((await post({status:'all'},{...headers,Origin:'https://outside.invalid'})).status,403);
 for(const input of [null,[],true,{status:'bogus'},{draftIds:['bad']},{selectedIds:Array.from({length:11},()=>randomUUID())},{date:'2091-02-30'},{query:'x'.repeat(501)}])assert.equal((await post(input)).status,400);
 const response=await post({status:'all'});assert.equal(response.status,200);const r=await response.json();assert.equal(r.rows.length,3);assert.equal(r.planning.date,r.date);assert.deepEqual(await app.vault.list(),before);
 for(const input of [{draftIds:Array.from({length:2001},()=>randomUUID())},{selectedIds:['bad']},{selectedIds:[r.rows[0].taskId,r.rows[0].taskId]}])assert.throws(()=>captureReviewFilters(input));
});

test('shortlist receipt API is authenticated, read-only, and validates selected IDs before reading evidence',async t=>{
 const {base,headers,app,ids}=await setup(t),before=await app.vault.list(),post=(data,h=headers)=>fetch(base+'/api/shortlist-review',{method:'POST',headers:h,body:JSON.stringify(data)}),input={date:'2091-04-10',selectedIds:ids};
 assert.equal((await post(input,{'Content-Type':'application/json'})).status,403);assert.equal((await post(input,{...headers,Origin:'https://outside.invalid'})).status,403);
 for(const bad of [null,[],{}, {...input,selectedIds:[ids[0],ids[0]]},{...input,date:'2200-01-01'}])assert.equal((await post(bad)).status,400);
 const response=await post(input);assert.equal(response.status,200);const r=await response.json();assert.equal(r.rows.length,3);assert(r.historyAvailable&&r.proposalsAvailable&&r.revision);assert.deepEqual(await app.vault.list(),before);
});
