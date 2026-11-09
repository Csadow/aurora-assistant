import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceArithmetic,arithmeticContext} from '../src/workflow-arithmetic.mjs';
import {sha} from '../src/vault.mjs';
const state=()=>({revision:1,requirements:{files:[{path:'/sources/note.md',requiredText:['](budget.md)','](quote.md)','](catalog.md)','](alternative.md)']}]},operations:['Budget: 120 credits.','Vendor quote: 140 credits.','Conflicting catalog: 110 credits.','Alternative: 90 credits.'].map((content,i)=>{const path='/sources/'+['budget','quote','catalog','alternative'][i]+'.md';return {id:String(i),name:'read_system_file',revision:1,status:'completed',arguments:{path},result:{path,content,revision:sha(content)}};})});
test('small explicitly linked source sets provide both conflicting budget alternatives as exact arithmetic',()=>{
 const w=state(),before=JSON.stringify(w),results=sourceArithmetic(w);assert.equal(results.length,6);for(const expression of ['140 > 120','110 < 120','90 < 120'])assert(results.some(c=>c.expression===expression));assert(results.every(c=>c.automatic&&c.left.sourceRevision&&c.right.sourceRevision));assert.equal(arithmeticContext(w).comparisons.length,6);assert.equal(JSON.stringify(w),before);
});
test('automatic arithmetic needs explicit current source reads and stays bounded without inferring facts',()=>{
 for(const change of [w=>w.requirements.files[0].requiredText=[],w=>w.requirements.files[0].exactText='Fixed note',w=>w.revision=2,w=>w.operations.push({name:'propose_command',status:'failed',action:'effect'})]){const w=state();change(w);assert.deepEqual(sourceArithmetic(w),[]);assert.equal(arithmeticContext(w),null);}
 const w=state();w.operations[0].result.content='1 2 3 4 5 6 7';w.operations[0].result.revision=sha(w.operations[0].result.content);assert.deepEqual(sourceArithmetic(w),[]);
});
