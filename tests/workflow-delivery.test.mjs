import test from 'node:test';
import assert from 'node:assert/strict';
import {sha} from '../src/vault.mjs';
import {sourcedDelivery,guardDelivery,deliveryTools} from '../src/workflow-delivery.mjs';
const path='/work/note.md',content='Reviewed decision\n';
const fixture=()=>({version:5,revision:1,steps:[{}],requirements:{files:[{path,sourceReview:true,draftCritique:true}],commands:[]},operations:[{id:'saved',revision:1,name:'propose_file_edit',status:'completed',action:'approved',arguments:{path,content},sourceReview:{draftRevision:sha(content)},draftCritique:{verdict:'ready'},expected:{path,revision:sha(content)}}]});
const read=w=>w.operations.push({id:'read',revision:1,name:'read_system_file',status:'completed',arguments:{path},result:{path,content,revision:sha(content)}});
test('a saved reviewed note moves from output readback to completion without refreshing sources',()=>{
 const w=fixture();assert.equal(sourcedDelivery(w).phase,'readback');assert.throws(()=>guardDelivery(w,'propose_file_edit',{path,content}),/already saved/);assert.throws(()=>guardDelivery(w,'read_system_file',{path:'/work/source.md'}));guardDelivery(w,'read_system_file',{path});
 read(w);assert.equal(sourcedDelivery(w).phase,'ready');assert.equal(sourcedDelivery(w).evidence,'E2');guardDelivery(w,'finish_step',{});
});
test('a concrete correction with current readback reopens work without authorizing writes',()=>{
 const w=fixture();read(w);for(const args of [{evidence:'E1',issue:'The required export conclusion is missing.'},{evidence:'E2',issue:'Restyle'},{evidence:'E2',issue:'The required export conclusion is missing.',approve:true}])assert.throws(()=>guardDelivery(w,'reopen_sourced_output',args));
 guardDelivery(w,'reopen_sourced_output',{evidence:'E2',issue:'The required export conclusion is missing.'});w.operations.push({name:'reopen_sourced_output',revision:1,status:'completed'});assert.equal(sourcedDelivery(w),null);assert.equal(w.operations.filter(o=>o.action).length,1);
});
test('stale revisions, failed or partial readback, changed files and later actions release checkpoint for recovery',()=>{
 for(const mutate of [w=>w.requirements.browser={url:'https://example.com/'},w=>w.requirements.window={title:'note.md'},w=>w.revision++,w=>w.version=4,w=>w.steps.push({}),w=>w.requirements.commands.push({}),w=>w.operations[0].status='failed',w=>w.operations[0].expected.revision='wrong',w=>w.operations[1].result.content='Changed externally',w=>w.operations[1].result.truncated=true,w=>w.operations[1].arguments.offset=1,w=>w.operations[1].status='failed',w=>w.operations.push({name:'propose_command',action:'test',status:'failed'})]){const w=fixture();read(w);mutate(w);assert.equal(sourcedDelivery(w),null);}
});
test('offered checkpoint tools include only readback, completion and explicit correction',()=>{
 const w=fixture(),tools=['read_system_file','finish_step','propose_sourced_file','computer_action','verify_outcome','request_help'].map(name=>({type:'function',function:{name,parameters:{properties:{path:{type:'string'}}}}}));
 assert.deepEqual(deliveryTools(w,tools).map(t=>t.function.name),['read_system_file','finish_step','request_help']);read(w);assert(deliveryTools(w,tools).some(t=>t.function.name==='reopen_sourced_output'));assert.deepEqual(deliveryTools(w,tools)[0].function.parameters.properties.path.enum,[path]);
});
test('a prior browser outcome keeps observation tools available until its own verification passes',()=>{
 const w=fixture();w.operations.unshift({id:'browser',name:'computer_action',status:'completed',arguments:{operation:'open_url'},result:{url:'https://example.test/',title:'Source page',text:'Observed source'}});
 assert.equal(sourcedDelivery(w),null);guardDelivery(w,'computer_action',{operation:'browser_read'});
 w.operations.push({id:'browser-check',name:'verify_outcome',status:'completed',result:{kind:'browser_title',expected:'Source page',evidence:'browser'}});
 assert.equal(sourcedDelivery(w).phase,'readback');assert.throws(()=>guardDelivery(w,'verify_outcome',{}),/unnecessary/);
});

test('source-only notes keep their checkpoint without an experimental critique',()=>{const w=fixture();delete w.requirements.files[0].draftCritique;delete w.operations[0].draftCritique;assert.equal(sourcedDelivery(w).phase,'readback');read(w);assert.equal(sourcedDelivery(w).phase,'ready');});
