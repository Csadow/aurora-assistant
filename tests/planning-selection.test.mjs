import test from 'node:test';
import assert from 'node:assert/strict';
import {readSelection,selectionRows} from '../public/planning-selection.js';
import {planningCapacity} from '../src/planning-capacity.mjs';
const row={taskId:'stable-task',text:'Original',contextRevision:'one',task:{duration:30},issue:null};
const draft={version:1,date:'2026-10-13',timezone:'UTC',start:'09:00',end:'18:00',gap:10,rows:[{...row,selected:true}]};
test('stored selections preserve date, hours and request identity without mutating storage',()=>{
 const value=JSON.stringify({...draft,pending:{requestId:'stable-request'}}),storage={getItem:()=>value,setItem:()=>assert.fail('Read must not write')};assert.deepEqual(readSelection(storage,'key'),JSON.parse(value));assert.equal(readSelection({getItem:()=>null},'key'),null);
});
test('malformed saved selections fail visibly instead of resetting or selecting new tasks',()=>{
 for(const value of ['bad',JSON.stringify({...draft,date:'2026-02-31'}),JSON.stringify({...draft,rows:[...draft.rows,...draft.rows]}),JSON.stringify({...draft,rows:[{...row,selected:'true'}]})])assert.throws(()=>readSelection({getItem:()=>value},'key'),/cannot be read/);
});
test('changed tasks compare by stable ID, preserve the old snapshot, and do not adopt a new context implicitly',()=>{
 const changed={...row,text:'Changed',contextRevision:'two'},result=selectionRows(draft,[changed]);assert.equal(result[0].stale,true);assert.equal(result[0].saved.text,'Original');assert.equal(result[0].current.text,'Changed');assert.equal(result[0].saved.contextRevision,'one');assert.equal(draft.rows[0].contextRevision,'one');
});
test('missing selected tasks stay visible and newly eligible tasks are not automatically added to a restored draft',()=>{
 const result=selectionRows(draft,[{...row,taskId:'new'}],true);assert.equal(result[0].saved.selected,false);assert.equal(result[1].saved.taskId,'stable-task');assert.equal(result[1].current,null);assert.equal(result[1].saved.selected,true);
 const fresh=selectionRows(null,[row,{...row,taskId:'held',issue:'Fixed'}],true);assert.equal(fresh[0].saved.selected,true);assert.equal(fresh[1].saved.selected,false);
});
test('capacity clips split windows, merges overlapping busy blocks and reports fragmented time honestly',()=>{
 const r=planningCapacity({date:'2026-10-13',now:new Date(2026,9,12,8),start:'09:00',end:'18:00',windows:[['09:00','12:00'],['14:00','16:00']],gap:10,busy:[[600,660],[630,690],[850,880]],placed:[[540,570]]});
 assert.deepEqual(r,{windowMinutes:300,busyMinutes:120,bufferMinutes:40,availableMinutes:140,largestSlotMinutes:70,remainingMinutes:100});
});
test('capacity uses the current five-minute start floor and an explicit day off has zero capacity',()=>{
 const input={date:'2026-10-12',now:new Date(2026,9,12,10,10),start:'09:00',end:'12:00',gap:10,busy:[]};assert.equal(planningCapacity(input).availableMinutes,105);assert.equal(planningCapacity({...input,windows:[]}).availableMinutes,0);assert.equal(planningCapacity({...input,now:new Date(2026,9,12,19)}).availableMinutes,0);
});
