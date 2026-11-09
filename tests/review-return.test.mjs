import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {reviewReturnRoute,markPlanningReview,createReviewReturn} from '../public/review-return.js';

test('review return retains only supported read-only destinations and original dates',()=>{
 assert.deepEqual(reviewReturnRoute({type:'evening',date:'2104-05-05',workloadOffset:10,acknowledge:true}),{type:'evening',date:'2104-05-05',workloadOffset:10});
 const id=randomUUID();assert.deepEqual(reviewReturnRoute({type:'reminder-cleanup',reviewId:id,selected:['other']}),{type:'reminder-cleanup',reviewId:id});
 for(const r of [{type:'evening',date:'2104-02-30'},{type:'weekly',date:'today'},{type:'cleanup-history',offset:-1},{type:'reminder-cleanup',reviewId:'bad'},{type:'proposal'},{type:'workload-next',proposalId:id},{type:'execution',id},null])assert.equal(reviewReturnRoute(r),null);
});
function fixture(){
 let owner={},focused=0;const listeners={},heading={focus(){focused++;}},details=[{id:'details',open:true}],panel={open:true,scrollTop:145,addEventListener:(n,f)=>listeners[n]=f},button={};
 const body={contains:n=>n===owner,querySelectorAll:sel=>sel==='details[open]'?details.filter(x=>x.open):sel==='details'?details:[],querySelector:sel=>sel==='h2'?heading:null};
 const show=(route,label='review')=>{owner={};markPlanningReview(body,owner,route,label);};
 let fail=false;const visited=[];const nav=createReviewReturn({body,panel,button,dispatch:async r=>{if(fail)throw Error('Unavailable');visited.push(r);show(r);}});
 return {body,panel,button,details,show,nav,visited,listeners,set fail(v){fail=v;},get focused(){return focused;},detour(){owner={};}};
}
test('back restores the exact dated review and cosmetic position without saving editor inputs',async()=>{
 const f=fixture(),route={type:'evening',date:'2104-05-05'};f.show(route,'evening review · 2104-05-05');f.nav.capture();route.date='2104-05-09';f.detour();f.nav.sync();assert.equal(f.button.hidden,false);assert.match(f.button.textContent,/2104-05-05/);f.panel.scrollTop=0;f.details[0].open=false;await f.nav.back();f.nav.settle();assert.deepEqual(f.visited,[{type:'evening',date:'2104-05-05'}]);assert.equal(f.panel.scrollTop,145);assert(f.details[0].open);assert.equal(f.focused,1);assert(f.button.hidden);
});
test('failed return keeps its destination for retry and a closed dialog clears its temporary trail',async()=>{
 const f=fixture();f.show({type:'briefing'});f.nav.capture();f.detour();f.fail=true;await assert.rejects(f.nav.back(),/Unavailable/);assert.equal(f.button.hidden,false);f.fail=false;await f.nav.back();assert.equal(f.visited.length,1);f.show({type:'cleanup-history',offset:20});f.nav.capture();f.detour();f.panel.open=false;f.listeners.close();assert(f.button.hidden);await f.nav.back();assert.equal(f.visited.length,1);
});
test('duplicate captures do not add clicks and the return trail is bounded to ten reviews',async()=>{
 const f=fixture();for(let i=0;i<12;i++){f.show({type:'cleanup-history',offset:i*10});f.nav.capture();f.nav.capture();}
 f.detour();for(let i=0;i<10;i++)await f.nav.back();assert.equal(f.visited.length,10);assert.deepEqual(f.visited.map(r=>r.offset),[110,100,90,80,70,60,50,40,30,20]);assert(f.button.hidden);
});
test('opening a new primary view clears a stale return destination',async()=>{
 const f=fixture();f.show({type:'evening',date:'2104-05-05'},'evening review');f.nav.capture();f.detour();f.nav.sync();assert.equal(f.button.hidden,false);
 f.show({type:'briefing'},'briefing');f.nav.clear();assert.equal(f.button.hidden,true);await f.nav.back();assert.deepEqual(f.visited,[]);
});
