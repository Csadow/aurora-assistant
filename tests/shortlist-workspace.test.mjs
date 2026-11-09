import test from 'node:test';
import assert from 'node:assert/strict';
import {shortlistWorkspace,shortlistWorkspaceHTML} from '../public/shortlist-workspace.js';
import {readPosition,writePosition} from '../public/reading-position.js';
const vault='/fixture',id='10000000-0000-0000-0000-000000000001';
const source={version:1,date:'2092-05-12',timezone:'Asia/Atyrau',rows:[{taskId:id,text:'Task',contextRevision:'r1',task:{id,path:'40 Tasks/Tasks.md',text:'Task',done:false}}]};
const carry={version:1,source,selection:{...source,date:'2092-05-13'},evidenceRevision:'e1'};
const storage=entries=>{const m=new Map(entries);return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),m};};
const e=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const button=(label,route)=>'<button data-route="'+e(route.type)+'">'+e(label)+'</button>';
test('workspace reads original and next-day choices independently and never writes or repairs them',async()=>{
 const s=storage([['aurora-capture-shortlist:'+vault,'broken'],['aurora-shortlist-next:'+vault,JSON.stringify(carry)]]),before=[...s.m];
 const r=await shortlistWorkspace({storage:s,vault,api:()=>assert.fail('No valid original to compare')});assert(r.sourceError);assert.deepEqual(r.carry,carry);assert.deepEqual([...s.m],before);
 const html=shortlistWorkspaceHTML(r,e,button);assert.match(html,/Original shortlist changed or is unavailable/);assert.match(html,/Reopen next-day review/);assert.match(html,/Open day draft/);
});
test('comparison outage keeps both recovery routes and distinguishes unavailable evidence from no save',async()=>{
 const s=storage([['aurora-capture-shortlist:'+vault,JSON.stringify(source)],['aurora-shortlist-next:'+vault,JSON.stringify(carry)]]),before=[...s.m];
 const r=await shortlistWorkspace({storage:s,vault,api:async()=>{throw Error('Offline <img>');}}),html=shortlistWorkspaceHTML(r,e,button);
 assert.match(html,/Comparison unavailable/);assert.match(html,/Offline &lt;img>/);assert.doesNotMatch(html,/<img>/);assert.match(html,/Open original shortlist/);assert.match(html,/Reopen next-day review/);assert.deepEqual([...s.m],before);
});
test('current reservations, pending reviews and changed carry evidence remain distinct',async()=>{
 const r={source,carry,report:{today:'2092-05-14',revision:'e2',historyAvailable:true,warnings:[],rows:[{taskId:id,placement:'scheduled',pendingReview:id}]}};
 const html=shortlistWorkspaceHTML(r,e,button);assert.match(html,/Scheduled · 1/);assert.match(html,/Earlier shortlist/);assert.match(html,/Reopen unsaved planning review/);assert.match(html,/Plan comparison changed/);assert.doesNotMatch(html,/Marked complete · 1/);
 r.report.historyAvailable=false;r.report.rows[0].placement='unplanned';assert.match(shortlistWorkspaceHTML(r,e,button),/Receipt comparison unavailable/);assert.doesNotMatch(shortlistWorkspaceHTML(r,e,button),/No recorded plan save/);
});
test('reading locations survive reopening and damaged bytes require an explicit reset',()=>{
 const s=storage([]),p={version:1,context:'day:2092-05-13',focus:'id:next-day-start',details:['receipt'],scrollTop:234};writePosition(s,'key',p);assert.deepEqual(readPosition(s,'key'),p);
 for(const bad of ['broken','null',JSON.stringify({...p,scrollTop:-1}),JSON.stringify({...p,details:Array(101).fill('x')})]){s.setItem('key',bad);assert.throws(()=>writePosition(s,'key',p),/cannot be read/);assert.equal(s.getItem('key'),bad);}
 s.removeItem('key');writePosition(s,'key',p);assert.deepEqual(readPosition(s,'key'),p);
});
test('storage failures surface without mutating planner drafts or unrelated vault locations',async()=>{
 const r=await shortlistWorkspace({storage:{getItem(){throw Error('Storage blocked');}},vault,api:()=>assert.fail()});assert.equal(r.sourceError,'Storage blocked');assert.equal(r.carryError,'Storage blocked');
 const s=storage([['aurora-capture-shortlist:'+vault+'-other',JSON.stringify(source)],['aurora-next-day-draft:'+vault,'kept']]);assert.equal((await shortlistWorkspace({storage:s,vault,api:()=>assert.fail()})).source,null);assert.equal(s.getItem('aurora-next-day-draft:'+vault),'kept');
});
