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
import {DayPlanning} from '../src/day-planning.mjs';
import {taskLine} from '../src/task-meta.mjs';
import {shortlistReview,shortlistReviewOptions} from '../src/shortlist-review.mjs';
import {shortlistEntry,readShortlistCarry,validateShortlistCarry,verifyShortlistCarry,mergeShortlist} from '../public/capture-shortlist.js';
import {shortlistEvidenceHTML,shortlistBriefing} from '../public/shortlist-follow.js';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-shortlist-follow-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data')),clock={now:new Date(2091,3,10,8)};await vault.init();await store.init();
 const history=new TaskHistory({vault,data:store.root,now:()=>clock.now.toISOString()});await history.init();
 const opts={vault,store,now:()=>clock.now},day=new DayPlanning(opts);day.dailyFocus=new DailyFocus({...opts,history,data:store.root});
 for(const name of ['One','Two','Three'])await vault.save('40 Tasks/'+name+'.md','- [ ] '+taskLine(name,{duration:30}),null);
 const ids=(await vault.tasks()).map(t=>t.id),date='2091-04-11';
 const review=()=>shortlistReview(day,{date,selectedIds:ids});
 const plan=async(extra={})=>{const r=await day.nextDay(date);return day.nextDayPreview({requestId:randomUUID(),date,today:r.today,timezone:r.timezone,selected:r.rows.map(r=>({taskId:r.taskId,contextRevision:r.contextRevision})),...extra});};
 return {vault,store,history,clock,day,ids,date,review,plan};
}
test('shortlist reports held previews separately from recorded reservations without mutating its sources',async t=>{
 const f=await fixture(t),p=await f.plan({start:'09:00',end:'10:00',gap:0}),before=await f.vault.list(),hist=await f.history.read(),proposals=await f.store.list('proposals');
 const r=await f.review();assert.equal(r.rows.filter(r=>r.placement==='held').length,1);assert.equal(r.rows.filter(r=>r.placement==='preview').length,2);assert(r.rows.every(r=>!r.receipt));assert(r.rows.every(r=>!r.preview.contextChanged));
 assert.deepEqual(await f.vault.list(),before);assert.deepEqual(await f.history.read(),hist);assert.deepEqual(await f.store.list('proposals'),proposals);
 await f.day.decide(p.id,'accept');const saved=await f.review();assert.equal(saved.rows.filter(r=>r.placement==='scheduled').length,2);assert.equal(saved.rows.filter(r=>r.receipt).length,2);assert.equal(saved.rows.filter(r=>r.placement==='held').length,1);assert(saved.rows.every(r=>!r.receiptChanged&&!r.pendingReview));assert.equal(saved.revision,(await f.review()).revision);
});
test('partial plans and dismissed remaining changes expose only successful note-save receipts',async t=>{
 const f=await fixture(t),p=await f.plan(),save=f.vault.save.bind(f.vault);let n=0;f.vault.save=async(...args)=>{if(++n===2)throw Error('Interrupted notes');return save(...args);};await assert.rejects(f.day.decide(p.id,'accept'));f.vault.save=save;
 let r=await f.review();assert.equal(r.rows.filter(r=>r.receipt).length,1);assert.equal(r.rows.filter(r=>r.pendingReview).length,2);
 await f.day.decide(p.id,'dismiss');r=await f.review();assert.equal(r.rows.filter(r=>r.receipt).length,1);assert(r.rows.every(r=>!r.pendingReview));assert.equal(r.rows.filter(r=>r.placement==='preview').length,2);
});
test('lost history confirmation stays unknown until reconciliation and retains recovered provenance',async t=>{
 const f=await fixture(t),p=await f.plan(),commit=f.history.committed.bind(f.history);f.history.committed=async()=>{throw Error('Lost receipt');};await assert.rejects(f.day.decide(p.id,'accept'));f.history.committed=commit;
 let r=await f.review();assert(r.warnings.some(w=>w.includes('reconciliation')));assert.equal(r.rows.filter(r=>r.receipt).length,0);assert.equal(r.rows.filter(r=>r.placement==='scheduled').length,1);
 await f.history.report();r=await f.review();assert.equal(r.rows.filter(r=>r.receipt?.source==='recovered_save').length,1);await f.day.decide(p.id,'accept');assert.equal((await f.review()).rows.filter(r=>r.receipt).length,3);
});
test('current completion, external changes and missing tasks retain the original recorded plan',async t=>{
 const f=await fixture(t);await f.day.decide((await f.plan()).id,'accept');let tasks=await f.vault.tasks();await f.vault.scheduleTask({...tasks[0],duration:45,planDate:'2091-04-12',startTime:null});tasks=await f.vault.tasks();await f.vault.toggleTask(tasks[1].path,tasks[1].line,tasks[1].revision,true);const note=await f.vault.read(tasks[2].path);await f.vault.save(note.path,'# Missing task\n',note.revision);
 const r=await f.review();assert.deepEqual(r.rows.map(r=>r.placement),['changed','complete','unavailable']);assert(r.rows.every(r=>r.receiptChanged));assert(r.rows.every(r=>r.receipt.task.duration===30&&!r.receipt.task.done));
});
test('external reservations and later pending reviews cannot masquerade as saved plan receipts',async t=>{
 const f=await fixture(t),p=await f.plan();await f.day.decide(p.id,'dismiss');const tasks=await f.vault.tasks();await f.vault.scheduleTask({...tasks[0],planDate:f.date,startTime:'13:00'});const r=await f.review();assert.equal(r.rows[0].placement,'scheduled');assert.equal(r.rows[0].receipt,null);
 const next=await f.day.nextDay('2091-04-12');await f.day.nextDayPreview({requestId:randomUUID(),date:next.date,today:next.today,timezone:next.timezone,selected:[{taskId:next.rows[1].taskId,contextRevision:next.rows[1].contextRevision}]});assert((await f.review()).rows[1].pendingReview);
});
test('calendar and unreadable evidence are explicit and read-only; revision tracks comparison changes',async t=>{
 const f=await fixture(t),calendar={enabled:true,complete:true,revision:'a',from:'2091-04-01',to:'2091-05-01',events:[]};f.day.calendar={context:async()=>calendar,fresh:async()=>calendar};await f.plan();const a=await f.review();calendar.revision='b';let b=await f.review();assert.notEqual(a.revision,b.revision);assert(b.rows.every(r=>r.preview.calendar==='changed'));f.day.calendar.fresh=async()=>{throw Error('Must not refresh on read');};assert.equal((await f.review()).revision,b.revision);
 calendar.complete=false;b=await f.review();assert(b.rows.every(r=>r.preview.calendar==='unavailable'));f.history.read=async()=>{throw Error('Unreadable history');};const list=f.store.list.bind(f.store);f.store.list=async kind=>{if(kind==='proposals')throw Error('Unreadable proposals');return list(kind);};b=await f.review();assert.equal(b.historyAvailable,false);assert.equal(b.proposalsAvailable,false);assert(b.warnings.length>=3);assert(b.rows.every(r=>r.task));
});
test('next-day review keeps original choices and blocks new source, evidence and pending-plan conflicts',async t=>{
 const f=await fixture(t),r=await f.review(),source={version:1,date:r.date,timezone:r.timezone,rows:r.rows.map(shortlistEntry)},carry={version:1,source:structuredClone(source),evidenceRevision:r.revision,selection:{...source,date:'2091-04-12',rows:source.rows.slice(0,1)}},before=structuredClone(carry);
 assert.deepEqual(verifyShortlistCarry(carry,source,r),carry.selection);const target=await f.day.nextDay(carry.selection.date),merged=mergeShortlist(null,carry.selection,target);assert.equal(merged.rows.length,1);assert.deepEqual(carry,before);
 assert.throws(()=>verifyShortlistCarry(carry,{...source,date:'2091-04-10'},r),/original shortlist changed/);assert.throws(()=>verifyShortlistCarry(carry,source,{...r,revision:'changed'}),/evidence changed/);
 assert.throws(()=>verifyShortlistCarry(carry,source,{...r,rows:r.rows.map(x=>({...x,pendingReview:'pending'}))}),/unsaved changes/);assert.throws(()=>verifyShortlistCarry(carry,source,{...r,historyAvailable:false}),/unavailable/);
 for(const bad of [{...carry,selection:{...carry.selection,date:source.date}},{...carry,selection:{...carry.selection,rows:[{...source.rows[0],taskId:randomUUID()}]}}])assert.throws(()=>validateShortlistCarry(bad));
 for(const raw of ['broken',JSON.stringify({...carry,selection:null})]){const storage={getItem:()=>raw};assert.throws(()=>readShortlistCarry(storage,'key'));assert.equal(storage.getItem('key'),raw);}
});
test('shortlist briefing escapes sources, separates failed evidence and preserves malformed local choices',async t=>{
 const f=await fixture(t),r=await f.review(),e=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');r.rows[0].text='<img src=x>';r.rows[0].task.text='<img src=x>';const s={version:1,date:r.date,timezone:r.timezone,rows:r.rows.map(shortlistEntry)},raw=JSON.stringify(s),storage={getItem:()=>raw};
 const html=await shortlistBriefing({api:async()=>r,vault:'/test',escape:e,storage});assert(html.includes('&lt;img'));assert(!html.includes('<img'));assert(html.includes('data-shortlist-follow'));assert.equal(storage.getItem('key'),raw);
 const bad=await shortlistBriefing({api:async()=>{throw Error('Should not call');},vault:'/test',escape:e,storage:{getItem:()=>'{broken'}});assert(bad.includes('cannot be read'));const unknown=shortlistEvidenceHTML(r.rows[0],{...r,historyAvailable:false},e);assert(!unknown.includes('No recorded day-plan save'));assert(unknown.includes('comparison unavailable'));
});
test('shortlist evidence options reject malformed IDs, unsupported dates and unbounded input',()=>{
 for(const data of [null,[],true,{}, {date:'2200-01-01',selectedIds:[]},{date:'2091-02-30',selectedIds:[]},{date:'2091-04-10',selectedIds:['bad']},{date:'2091-04-10',selectedIds:Array.from({length:11},()=>randomUUID())}])assert.throws(()=>shortlistReviewOptions(data));const id=randomUUID();assert.throws(()=>shortlistReviewOptions({date:'2091-04-10',selectedIds:[id,id]}));
});
