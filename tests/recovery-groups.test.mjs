import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {recoveryGroups,captureRecovery,localDraftReview,clearReviewedLocalDraft} from '../public/recovery-groups.js';
import {continueDayDrafts} from '../public/continue-day.js';

const storage=entries=>{const m=new Map(entries);return {get length(){return m.size},key:i=>[...m.keys()][i],getItem:k=>m.get(k)??null,setItem(){assert.fail('Recovery must not save');},removeItem(){assert.fail('Recovery must not clear');}};};
test('recovery groups use exact report dates and separate current week, earlier, upcoming and undated work',()=>{
 const rows=[{date:'2105-06-04',id:'today'},{date:'2105-06-01',period:'week',id:'week'},{date:'2105-06-03',id:'old'},{date:'2105-06-05',id:'later'},{date:null,id:'unknown'},{date:'2105-02-30',id:'invalid'}],before=structuredClone(rows);
 const groups=recoveryGroups(rows,'2105-06-04');assert.deepEqual(groups.map(g=>[g.key,g.rows.map(r=>r.id)]),[['today',['today']],['week',['week']],['upcoming',['later']],['earlier',['old']],['undated',['unknown','invalid']]]);assert.deepEqual(rows,before);
});
test('weekly dates use calendar days across year boundaries and missing current day never becomes today',()=>{
 assert.equal(recoveryGroups([{date:'2026-12-28',period:'week'}],'2027-01-03')[0].key,'week');assert.equal(recoveryGroups([{date:'2026-12-28',period:'week'}],'2027-01-04')[0].key,'earlier');
 const r=recoveryGroups([{date:'2026-12-28'},{date:null}],null);assert.equal(r.length,1);assert.equal(r[0].key,'undated');assert.equal(r[0].label,'Current day unavailable');assert.equal(r[0].rows[0].date,'2026-12-28');
});
test('distinct requests sharing a destination remain separate recovery records',()=>{
 const route={type:'evening',date:'2026-11-03'},a={title:'choices',route,date:route.date},b={title:'pending focus request',route,date:route.date};assert.deepEqual(recoveryGroups([a,b],route.date)[0].rows,[a,b]);
});
test('dated editor keys take precedence over conflicting payload dates without rewriting either draft',()=>{
 const v='/vault',s=storage([['aurora-evening-choices:'+v+':2026-11-02',JSON.stringify({date:'2026-11-03'})],['aurora-evening-choices:'+v+':2026-11-02:focus-review-request','{}']]);const r=continueDayDrafts(s,v);assert.equal(r.rows.length,2);assert(r.rows.every(r=>r.date==='2026-11-02'));assert.deepEqual(recoveryGroups(r.rows,'2026-11-03')[0].rows,r.rows);
});
test('schedule discovery preserves invalid drafts and labels the proposed planned date instead of the deadline',()=>{
 const v='/vault',id=randomUUID(),bad=randomUUID(),draft={version:1,task:{id,text:'Original',path:'40 Tasks/a.md',revision:'r',line:0,done:false},fields:{text:'Unsaved <img>',due:'2026-11-05',planDate:'2026-11-03',startTime:'',duration:'25',priority:'normal'}};
 const r=continueDayDrafts(storage([['aurora-schedule-draft:'+v+':'+id,JSON.stringify(draft)],['aurora-schedule-draft:'+v+':'+bad,'{}'],['aurora-schedule-draft:'+v+'-other:'+id,JSON.stringify(draft)]]),v);
 assert.equal(r.rows.length,2);const d=r.rows.find(r=>r.route.taskId===id);assert.equal(d.date,'2026-11-03');assert.equal(d.dateLabel,'Draft planned date');assert.equal(d.text,'Unsaved <img>');assert.equal(d.unreadable,false);assert.equal(d.clearType,'task-schedule');assert(r.rows.find(r=>r.route.taskId===bad).unreadable);assert.equal(r.rows.find(r=>r.route.taskId===bad).clearType,null);
});
const fields={text:'Capture <img>',project:'',duration:'30',due:'2026-11-09',planDate:'2026-11-03',startTime:''};
test('capture recovery separates local edits from the shared draft and never merges differing versions',async()=>{
 const v='/vault',r=await captureRecovery({storage:storage([['aurora-task-capture:'+v+':main',JSON.stringify({version:1,revision:'local',fields:{...fields,text:'Unshared edits',planDate:'2026-11-02'}})]]),vault:v,api:async path=>{assert.equal(path,'/api/task-capture');return {fields,revision:'shared',proposalId:null};}});
 assert.equal(r.drafts.length,2);assert.equal(r.drafts[0].date,'2026-11-02');assert.equal(r.drafts[1].date,'2026-11-03');assert.equal(r.reviews.length,0);
});
test('saved capture receipts are reviews, interrupted saves remain uncertain, and empty capture does not clutter recovery',async()=>{
 const base={fields,proposalId:randomUUID()},args={storage:storage([]),vault:'/vault'};
 let r=await captureRecovery({...args,api:async()=>({...base,proposal:{status:'accepted'}})});assert.equal(r.drafts.length,0);assert.match(r.reviews[0].detail,/already added/);assert.equal(r.reviews[0].date,'2026-11-03');
 r=await captureRecovery({...args,api:async()=>({...base,saveStarted:true,proposal:{status:'pending'}})});assert.match(r.reviews[0].detail,/attempted/);
 r=await captureRecovery({...args,api:async()=>({fields:{...fields,text:'',due:'',planDate:''},proposalId:null})});assert.equal(r.drafts.length+r.reviews.length,0);
});
test('unavailable shared capture and damaged local recovery are visible without deleting or interpreting content',async()=>{
 const r=await captureRecovery({storage:storage([['aurora-task-capture:/vault:main','<img src=x>']]),vault:'/vault',api:async()=>{throw Error('Offline');}});assert.equal(r.warnings.length,1);assert.equal(r.drafts[0].unreadable,true);assert.equal(r.drafts[0].date,null);assert.equal(r.reviews.length,0);
});
test('individual local schedule and capture drafts require exact review; independent and durable records stay intact',async()=>{
 const v='/vault',id=randomUUID(),scheduleKey='aurora-schedule-draft:'+v+':'+id,captureKey='aurora-task-capture:'+v+':main',receiptKey='aurora-reading:'+v+':continue-day';
 const schedule={version:1,task:{id,text:'Original task',path:'40 Tasks/a.md',revision:'r',line:0,done:false},fields:{text:'Unfinished edit',due:'',planDate:'2105-06-04',startTime:'',duration:'25',priority:'normal'}};
 const map=new Map([[scheduleKey,JSON.stringify(schedule)],[captureKey,JSON.stringify({version:1,revision:'shared-r',fields})],[receiptKey,'kept']]);let fail=false;
 const s={get length(){return map.size},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,removeItem:k=>{if(fail)throw Error('storage full');map.delete(k);}};
 const scheduleRow=continueDayDrafts(s,v).rows.find(r=>r.route.type==='task-schedule'),captureRow=(await captureRecovery({storage:s,vault:v,api:async()=>({fields:{text:'',project:'',duration:'30',due:'',planDate:'',startTime:''},proposalId:null})})).drafts[0];
 const original=localDraftReview(s,scheduleRow);assert.equal(original.raw,map.get(scheduleKey));assert.match(original.raw,/Unfinished edit/);
 map.set(scheduleKey,JSON.stringify({...schedule,fields:{...schedule.fields,text:'Another window edit'}}));assert.throws(()=>clearReviewedLocalDraft(s,original),/changed in another window/);assert(map.has(scheduleKey));
 const fresh=localDraftReview(s,scheduleRow);fail=true;assert.throws(()=>clearReviewedLocalDraft(s,fresh),/storage full/);assert(map.has(scheduleKey));fail=false;clearReviewedLocalDraft(s,fresh);assert(!map.has(scheduleKey));assert(map.has(captureKey));assert.equal(map.get(receiptKey),'kept');
 const local=localDraftReview(s,captureRow);clearReviewedLocalDraft(s,local);assert(!map.has(captureKey));assert.equal(map.get(receiptKey),'kept');assert.throws(()=>localDraftReview(s,captureRow),/no longer stored/);
});
test('pending, unreadable and shared capture records cannot enter local clearing review',async()=>{
 const v='/vault',s=storage([['aurora-task-capture:'+v+':main','broken']]);const r=await captureRecovery({storage:s,vault:v,api:async()=>({fields,proposalId:null})});
 assert.throws(()=>localDraftReview(s,r.drafts[0]),/original editor/);assert.throws(()=>localDraftReview(s,r.drafts[1]),/original editor/);
});
test('first-step, outcome and daily summary edits support exact reviewed clearing only without pending requests',()=>{
 const v='/vault',id=randomUUID(),context={date:'2026-11-04',timezone:'Asia/Atyrau',task:{text:'Plan project',path:'40 Tasks/a.md'},project:null,execution:[],dependencyReasons:[]};
 const first={version:1,taskId:id,text:'My next step',mode:'manual',baseRevision:'r1',context};
 const outcome={version:1,taskId:id,cardSequence:2,note:'Need a reply',kind:'blocked',revision:'r1',context,card:{sequence:2,text:'Write outline'}};
 const summary={version:1,date:'2026-11-04',body:'My day',sourceRevision:'r',sourceText:'Source',targetRevision:null,targetContent:null};
 const keys=[`aurora-first-step:${v}:${id}`,`aurora-step-outcome:${v}:${id}:2`,`aurora-summary-draft:${v}:2026-11-04`],map=new Map(keys.map((k,i)=>[k,JSON.stringify([first,outcome,summary][i])]));
 const s={get length(){return map.size},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,removeItem:k=>map.delete(k)};
 const rows=continueDayDrafts(s,v).rows;assert.deepEqual(new Set(rows.map(r=>r.clearType)),new Set(['first-step','step-outcome','daily-summary']));
 for(const row of rows){const reviewed=localDraftReview(s,row);assert.equal(reviewed.raw,map.get(row.localKey));clearReviewedLocalDraft(s,reviewed);assert.equal(map.has(row.localKey),false);}
 assert.equal(map.size,0);
 map.set(keys[0],JSON.stringify({...first,pending:{kind:'save',input:{requestId:id,taskId:id,revision:'r1',acknowledge:true,text:'My next step',mode:'manual'}}}));
 map.set(keys[1],JSON.stringify({...outcome,pending:{requestId:id,taskId:id,cardSequence:2,revision:'r1',note:'Need a reply',kind:'blocked',acknowledge:true}}));
 map.set(keys[2],JSON.stringify({...summary,pending:{requestId:id,date:'2026-11-04',body:'My day',sourceRevision:'r',targetRevision:null}}));
 for(const row of continueDayDrafts(s,v).rows){assert.equal(row.pending,true);assert.equal(row.clearType,null);assert.throws(()=>localDraftReview(s,row),/original editor/);}
});
