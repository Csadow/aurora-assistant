import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readShortlist,writeShortlist,shortlistEntry,localCaptureDraftIds,mergeShortlist} from '../public/capture-shortlist.js';
const memory=()=>{const map=new Map();return {map,get length(){return map.size;},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
const row=(text='Captured')=>{const taskId=randomUUID();return {taskId,text,task:{id:taskId,text,path:'40 Tasks/Tasks.md',done:false,duration:30},contextRevision:'context-'+taskId,issue:null};};
const selection=rows=>({version:1,date:'2091-04-10',timezone:'Asia/Atyrau',rows:rows.map(shortlistEntry)});
const report=rows=>({date:'2091-04-10',today:'2091-04-10',timezone:'Asia/Atyrau',rows});
test('shortlist bounds, shape and optimistic storage writes protect retained original choices',()=>{
 const storage=memory(),a=row(),d=selection([a]);writeShortlist(storage,'key',d,null);assert.deepEqual(readShortlist(storage,'key'),d);const raw=storage.getItem('key');assert.throws(()=>writeShortlist(storage,'key',selection([row()]),null),/changed in another/);assert.equal(storage.getItem('key'),raw);
 for(const bad of ['broken',JSON.stringify({...d,rows:[...d.rows,...d.rows]}),JSON.stringify(selection(Array.from({length:11},()=>row()))),JSON.stringify({...d,date:'2091-02-30'}),JSON.stringify({...d,date:'0001-01-01'}),JSON.stringify({...d,date:'2200-01-01'}),JSON.stringify({...d,rows:[{...d.rows[0],task:null}]})]){storage.setItem('key',bad);assert.throws(()=>readShortlist(storage,'key'),/cannot be read/);assert.equal(storage.getItem('key'),bad);}
});
test('local status filtering includes independent damaged and pending editor drafts only in this vault',()=>{
 const s=memory(),a=randomUUID(),b=randomUUID();s.setItem('aurora-first-step:/vault:'+a,'damaged');s.setItem('aurora-schedule-draft:/vault:'+b,'{}');s.setItem('aurora-first-step:/other:'+randomUUID(),'{}');s.setItem('aurora-first-step:/vault:not-an-id','{}');assert.deepEqual(new Set(localCaptureDraftIds(s,'/vault')),new Set([a,b]));
});
test('merging a shortlist keeps hours and existing selected snapshots, and adds each task once',()=>{
 const a=row(),b=row(),c=row(),d=selection([a,b]),original={version:1,date:d.date,timezone:d.timezone,start:'10:30',end:'16:45',gap:15,rows:[{...shortlistEntry(a),contextRevision:'retained-older-context',selected:true},{...shortlistEntry(c),selected:false}]},before=structuredClone(original);
 const merged=mergeShortlist(original,d,report([a,b,c]));assert.equal(merged.start,'10:30');assert.equal(merged.end,'16:45');assert.equal(merged.gap,15);assert.equal(merged.rows.find(r=>r.taskId===a.taskId).contextRevision,'retained-older-context');assert.equal(merged.rows.filter(r=>r.selected).length,2);assert.equal(merged.rows.find(r=>r.taskId===c.taskId).selected,false);assert.deepEqual(original,before);assert.deepEqual(mergeShortlist(merged,d,report([a,b,c])),merged);
});
test('merging refuses pending previews, a different date, changed sources and unavailable tasks without mutation',()=>{
 const a=row(),d=selection([a]),base=mergeShortlist(null,d,report([a])),before=structuredClone(base);
 for(const existing of [{...base,pending:{requestId:'keep'}},{...base,date:'2091-04-11'},{...base,timezone:'UTC'}])assert.throws(()=>mergeShortlist(existing,d,report([a])));
 for(const rows of [[],[{...a,contextRevision:'changed'}],[{...a,issue:'Waiting on prerequisite'}]])assert.throws(()=>mergeShortlist(base,d,report(rows)));assert.throws(()=>mergeShortlist(base,d,{...report([a]),today:'2091-04-11'}));assert.deepEqual(base,before);
});
test('read and write failures retain the previous shortlist and combined day-plan bound is enforced',()=>{
 const s=memory(),a=row(),d=selection([a]);s.setItem('key',JSON.stringify(d));const raw=s.getItem('key');s.setItem=()=>{throw Error('No storage');};assert.throws(()=>writeShortlist(s,'key',selection([row()]),raw),/No storage/);assert.equal(s.getItem('key'),raw);
 const many=Array.from({length:100},()=>({...shortlistEntry(row()),selected:true})),base={...d,start:'09:00',end:'18:00',gap:10,rows:many};assert.throws(()=>mergeShortlist(base,d,report([a])),/exceeds 100/);assert.throws(()=>shortlistEntry({...a,issue:'Fixed commitment'}),/Fixed commitment/);
});
