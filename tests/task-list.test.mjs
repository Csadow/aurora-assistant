import test from 'node:test';
import assert from 'node:assert/strict';
import {readTaskListState,taskListModel} from '../mobile/web/task-list-core.js';
const date='2026-10-27',alpha='20 Projects/Alpha.md',beta='20 Projects/Beta.md';
const tasks=[
 {id:'one',path:'40 Tasks/A.md',line:1,text:'Read discrete mathematics',done:false,planDate:date,project:alpha},
 {id:'two',path:'40 Tasks/B.md',line:2,text:'Write the introduction',done:false,planDate:null,project:beta},
 {id:'three',path:'40 Tasks/C.md',line:3,text:'Exercise <img src=x>',done:true,planDate:date,project:alpha},
 {id:'four',path:'40 Tasks/D.md',line:4,text:'Book a room',done:false,planDate:null},
 {id:'five',path:'40 Tasks/E.md',line:5,text:'Tomorrow’s revision',done:false,planDate:'2026-10-28',project:alpha}
];
const notes=[{path:alpha,title:'University studies'},{path:beta,title:'Research project'}];
const state={version:1,query:'',project:'all',status:'open',date,scrollTop:400,focus:{key:'id:one',action:'Task details'}};
const model=(s={},t=tasks,n=notes)=>taskListModel(t,n,{...state,...s});
const ids=r=>r.rows.map(r=>r.task.id);
test('task search combines words across task, project title and source path without changing source order',()=>{assert.deepEqual(ids(model({query:' UNIVERSITY read A.md '})),['one']);assert.deepEqual(ids(model({query:'write university'})),[]);});
test('query markup and regular-expression characters are treated literally',()=>{assert.deepEqual(ids(model({status:'all',query:'<img src=x>'})),['three']);assert.deepEqual(ids(model({query:'.*'})),[]);});
test('Unicode search normalizes width and case',()=>{assert.deepEqual(ids(model({query:'ＲＥＡＤ DisCreTe'})),['one']);});
test('status and project filters intersect instead of hiding completed work by default in all',()=>{assert.deepEqual(ids(model({status:'all',project:alpha})),['one','three','five']);assert.deepEqual(ids(model({status:'done',project:alpha})),['three']);assert.deepEqual(ids(model({project:'none'})),['four']);});
test('selected-date filtering uses the explicit date and excludes completion',()=>{assert.deepEqual(ids(model({status:'today'})),['one']);assert.deepEqual(ids(model({status:'today',date:'2026-10-28'})),['five']);});
test('without a planned date excludes timed-date tasks and unknown damaged metadata',()=>{assert.deepEqual(ids(model({status:'unscheduled'},[...tasks,{id:null,text:'broken',path:'bad.md',line:0,scheduleError:true}])),['two','four']);});
test('metadata and duplicate-ID problems remain visible when no search results match',()=>{const t=[...tasks,{...tasks[0],path:'copy.md'},{id:null,text:'broken',path:'bad.md',line:0,scheduleError:true}];const r=model({query:'no matches'},t);assert.equal(r.rows.length,0);assert.equal(r.problems.length,3);assert.equal(new Set(r.problems.map(x=>x.key)).size,3);});
test('a missing selected project stays selectable instead of silently broadening the list',()=>{const r=model({project:'20 Projects/Removed.md'});assert.equal(r.rows.length,0);assert.deepEqual(r.projects.find(p=>p.path.endsWith('Removed.md')),{path:'20 Projects/Removed.md',title:'20 Projects/Removed.md',missing:true});});
test('archived or draft project notes are labelled unavailable but task associations remain',()=>{const r=model({project:alpha},tasks,[{path:alpha,title:'Hidden project',status:'archived'}]);assert.deepEqual(ids(r),['one','five']);assert.equal(r.projects.find(p=>p.path===alpha).missing,true);});
test('stable return keys follow a uniquely identified task when its source line moves',()=>{const a=model().rows[0],b=model({},[{...tasks[0],line:90,path:'new.md'}]).rows[0];assert.equal(a.key,b.key);});
test('task-list queries do not change task notes, project notes, relationships or completion',()=>{const a=structuredClone(tasks),b=structuredClone(notes);model({query:'exercise',status:'all'});assert.deepEqual(tasks,a);assert.deepEqual(notes,b);});
test('saved filters are scoped to a vault and retain only the supported navigation fields',()=>{const m=new Map([['aurora-task-list:/one',JSON.stringify({...state,extra:'ignored'})]]),storage={getItem:k=>m.get(k)??null};assert.deepEqual(readTaskListState(storage,'/one'),state);assert.equal(readTaskListState(storage,'/two'),null);});
test('malformed saved filters retain their original bytes for explicit reset',()=>{for(const raw of ['bad',JSON.stringify({...state,status:'unknown'}),JSON.stringify({...state,date:'2026-02-30'}),JSON.stringify({...state,scrollTop:Infinity}),JSON.stringify({...state,focus:{key:3,action:'Task details'}}),JSON.stringify({...state,query:'x'.repeat(501)})]){const m=new Map([['aurora-task-list:/one',raw]]);assert.throws(()=>readTaskListState({getItem:k=>m.get(k)},'/one'),/kept/);assert.equal(m.get('aurora-task-list:/one'),raw);}});
test('unavailable storage propagates an error rather than pretending there were no saved filters',()=>{assert.throws(()=>readTaskListState({getItem:()=>{throw Error('Unavailable');}},'/one'),/Unavailable/);});
