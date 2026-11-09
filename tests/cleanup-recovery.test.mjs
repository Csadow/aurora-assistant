import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cleanupKey,validCleanupDraft,cleanupDraft,clearCleanupDraft,cleanupRecovery,cleanupRecoveryHTML} from '../public/cleanup-recovery.js';
import {continueDayDrafts} from '../public/continue-day.js';
const vault='/tmp/cleanup-vault',key=cleanupKey(vault),id=randomUUID();
const empty=()=>({version:1,offset:0,selected:[],request:null,reviewId:null});
const choice=()=>({id,revision:'a'.repeat(64),title:'Class <img>',targetDate:'2103-04-18'});
function storage(raw){const m=new Map(raw===undefined?[]:[[key,raw]]);return {m,get length(){return m.size;},key:i=>[...m.keys()][i],getItem:k=>m.get(k)??null,removeItem:k=>m.delete(k),setItem:(k,v)=>m.set(k,v)};}
test('cleanup discovery distinguishes empty drafts, choices and exact requests without writes',()=>{
 const s=storage(JSON.stringify(empty()));assert.equal(cleanupDraft(s,vault),null);const d={...empty(),selected:[choice()]};s.setItem(key,JSON.stringify(d));let r=cleanupDraft(s,vault);assert.match(r.text,/1 reminder/);assert.equal(r.pending,false);
 d.request={requestId:randomUUID(),today:'2103-04-17',timezone:'Asia/Atyrau',selected:[{id,revision:choice().revision}]};d.reviewId=d.request.requestId;const raw=JSON.stringify(d);s.setItem(key,raw);r=cleanupDraft(s,vault);assert(r.pending);assert.equal(r.date,'2103-04-17');assert.deepEqual(r.route,{type:'reminder-cleanup'});assert.equal(s.getItem(key),raw);assert.equal(continueDayDrafts(s,vault).rows.length,1);assert.equal(continueDayDrafts(s,vault+'-other').rows.length,0);
});
test('damaged cleanup drafts stay visible and are never automatically repaired',()=>{
 for(const raw of ['{','null','[]',JSON.stringify({...empty(),selected:[choice(),choice()]}),JSON.stringify({...empty(),reviewId:'bad'})]){
  const s=storage(raw);assert.equal(cleanupDraft(s,vault).unreadable,true);assert.equal(continueDayDrafts(s,vault).rows[0].unreadable,true);assert.equal(s.getItem(key),raw);
 }
 assert(!validCleanupDraft({...empty(),request:{}}));
});
test('clearing a local cleanup is exact and preserves other drafts; failed storage keeps it',()=>{
 const raw=JSON.stringify({...empty(),selected:[choice()]}),s=storage(raw);s.setItem('unrelated','keep');assert.throws(()=>clearCleanupDraft(s,vault,'older'),/changed/);assert.equal(s.getItem(key),raw);const broken={...s,removeItem(){throw Error('storage unavailable');}};assert.throws(()=>clearCleanupDraft(broken,vault,raw),/unavailable/);assert.equal(s.getItem(key),raw);clearCleanupDraft(s,vault,raw);assert.equal(s.getItem(key),null);assert.equal(s.getItem('unrelated'),'keep');
});
test('recovery reads only GET reports and keeps local evidence when the service fails',async()=>{
 const s=storage(JSON.stringify({...empty(),selected:[choice()]})),calls=[];const r=await cleanupRecovery({api:async(...args)=>{calls.push(args);throw Error('History unavailable');},storage:s,vault,date:'2103-04-17'});assert(r.local);assert.equal(r.error,'History unavailable');assert.deepEqual(calls,[['/api/reminder-cleanup/history?offset=0&date=2103-04-17']]);
 const unavailable=await cleanupRecovery({api:async()=>({rows:[],total:0}),storage:{getItem(){throw Error();}},vault});assert(unavailable.localError);assert(unavailable.history);
});
test('history presentation escapes original evidence and links exact reviews separately from local choices',()=>{
 const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),routes=[];
 const html=cleanupRecoveryHTML({history:{rows:[{id,date:'2103-04-17',timezone:'<img>',count:2,status:'recorded',confirmedAt:'2103-04-17T18:00:00Z',issues:[]}],total:1},date:'2103-04-17'},escape,(label,route)=>{routes.push(route);return escape(label);});assert(!html.includes('<img>'));assert(html.includes('Recorded dismissal'));assert(html.includes('Original review: 2103-04-17'));assert(routes.some(r=>r.reviewId===id));assert(routes.some(r=>r.type==='cleanup-history'));assert(routes.some(r=>r.type==='reminder-cleanup'&&!r.reviewId));
});
