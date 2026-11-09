import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceValues,compareSourceValues,comparisonContext,comparisonTools} from '../src/workflow-calculations.mjs';
import {sha} from '../src/vault.mjs';
const read=(id,content,path='/sources/'+id+'.md')=>({id,name:'read_system_file',revision:1,status:'completed',arguments:{path},result:{path,content,revision:sha(content),offset:0,truncated:false}});
const state=(a='Catalog price: 110 credits.',b='Budget ceiling: 120 credits.')=>({revision:1,requirements:{files:[]},operations:[read('source',a),read('limit',b)]});
const args={left:'E1:N1',right:'E2:N1'};
test('source comparison proves the observed budget relation and preserves source receipts without mutation',()=>{
 const w=state(),before=JSON.stringify(w),r=compareSourceValues(w,args);assert.equal(r.expression,'110 < 120');assert.equal(r.difference,'-10');assert.equal(r.left.source,'/sources/source.md');assert.equal(r.right.sourceRevision,sha('Budget ceiling: 120 credits.'));assert.equal(r.left.excerpt,'Catalog price: 110 credits.');assert.equal(JSON.stringify(w),before);assert.equal(comparisonTools(w).length,1);
 assert.equal(compareSourceValues(state('Quote price: 140 credits.'),args).expression,'140 > 120');
});
test('decimal arithmetic handles equality, negatives and large exact fractional differences without float rounding',()=>{
 for(const [a,b,expression,difference] of [['0.1','0.3','0.1 < 0.3','-0.2'],['-1.25','-0.5','-1.25 < -0.5','-0.75'],['+120.00','120','+120.00 = 120','0'],['999999999999.999999','999999999999.999998','999999999999.999999 > 999999999999.999998','0.000001']]){const r=compareSourceValues(state(a,b),args);assert.equal(r.expression,expression);assert.equal(r.difference,difference);}
});
test('number handles distinguish repeated occurrences and reject unsupported or partial numeric spellings',()=>{
 const values=sourceValues(state('First 110.\nSecond 110.','1,000 1e3 qwen3.5 2026-10-14 1234567890123 0.1234567'));assert.equal(values.length,2);assert.deepEqual(values.map(x=>[x.id,x.value,x.line]),[['E1:N1','110',1],['E1:N2','110',2]]);
 assert.throws(()=>compareSourceValues(state(),{...args,left:'110'}));assert.throws(()=>compareSourceValues(state(),{...args,formula:'110+120'}));assert.throws(()=>compareSourceValues(state(),{...args,left:'E1:N99'}));
});
test('calculations reject old, partial, redacted, failed and superseded reads, including after effects',()=>{
 for(const mutate of [w=>w.revision=2,w=>w.operations[0].result.truncated=true,w=>w.operations[0].result.revision='wrong',w=>w.operations[0].result.offset=10,w=>w.operations[0].arguments.offset=10,w=>w.operations[0].status='failed',w=>w.operations.push({...read('reread','Changed 90.','/sources/source.md'),status:'failed'}),w=>w.operations.push({name:'propose_command',status:'failed',action:'started'})]){const w=state();mutate(w);assert.throws(()=>compareSourceValues(w,args));}
 const w=state();w.operations.push({name:'propose_command',status:'failed'});assert.equal(compareSourceValues(w,args).relation,'<');
});
test('declared outputs and files written by this workflow cannot masquerade as source evidence',()=>{
 const w=state();w.requirements.files=[{path:'/sources/source.md'}];assert.throws(()=>compareSourceValues(w,args));
 const other=state();other.operations.unshift({id:'write',name:'propose_file_edit',action:'saved',status:'completed',arguments:{path:'/sources/source.md'}});assert(!sourceValues(other).some(v=>v.source==='/sources/source.md'));
});
test('comparison context retains the exact result but marks superseded operands for fresh reads',()=>{
 const w=state();w.operations.push({id:'comparison',name:'compare_source_values',revision:1,status:'completed',result:compareSourceValues(w,args)});assert.equal(comparisonContext(w)[0].needsFreshRead,false);w.operations.push(read('new','Budget ceiling: 80 credits.','/sources/limit.md'));assert.equal(comparisonContext(w)[0].needsFreshRead,true);assert.equal(comparisonContext(w)[0].expression,'110 < 120');
});
test('source number context is bounded and never reassigns old observation handles',()=>{
 const w=state();w.operations=Array.from({length:9},(_,i)=>read('source'+i,'0 1 2 3 4 5 6 7 8 9'));const values=sourceValues(w);assert.equal(values.length,24);assert.equal(new Set(values.map(v=>v.id)).size,24);assert(values.every(v=>/^E[7-9]:N[1-8]$/.test(v.id)));
});
