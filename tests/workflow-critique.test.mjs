import test from 'node:test';
import assert from 'node:assert/strict';
import {sha} from '../src/vault.mjs';
import {critiqueInput,critiqueReceipt,assertDraftCritique} from '../src/workflow-critique.mjs';
const fixture=()=>{
 const w={version:5,revision:1,goal:'Keep offline editing and export available now.',scope:'Local sources only',directives:[],model:'fixture',generation:{think:true},requirements:{files:[{path:'/work/note.md',sourceReview:true,draftCritique:true,requiredText:['](source.md)']}],commands:[]},operations:[{id:'read',name:'read_system_file',revision:1,status:'completed',arguments:{path:'/work/source.md'},result:{path:'/work/source.md',content:'Export is not available.',revision:sha('Export is not available.')}}]};
 const op={id:'draft',arguments:{path:'/work/note.md',content:'The current offer does not qualify.'},sourceReview:{claims:[{text:'The current offer does not qualify.'}],sources:[{revision:sha('Export is not available.')}]}};
 return {w,op};
};
const assessment=(verdict='ready',explanation='Compared capabilities against the fixed requirements.')=>({verdict,explanation});
const response=(verdict='ready',explanation='Compared capabilities against the fixed requirements.')=>({content:JSON.stringify({coverage:assessment(),claims:[{number:1,text:assessment(verdict,explanation),limits:assessment()}]})});
test('separate critique receives fixed requirements, claim source paths and complete untrusted source text',()=>{
 const {w,op}=fixture(),before=JSON.stringify(w),input=critiqueInput(w,op);assert.equal(input.goal,w.goal);assert.equal(input.sources[0].content,'Export is not available.');assert.deepEqual(input.contentRequirements,[{path:'/work/note.md',requiredText:['](source.md)']}]);assert.equal(JSON.stringify(w),before);
 w.requirements.files[0].finalNewline='required';assert.equal(critiqueInput(w,op).contentRequirements[0].finalNewline,undefined);
 op.sourceReview.claims[0].evidence=[{source:'/work/source.md'}];assert.deepEqual(critiqueInput(w,op).claims[0].selectedSources,['/work/source.md']);
 w.operations[0].result.truncated=true;assert.throws(()=>critiqueInput(w,op),/Read all/);
});
test('critique never silently truncates an oversized goal or source set',()=>{
 const {w,op}=fixture();w.goal='x'.repeat(33000);assert.throws(()=>critiqueInput(w,op),/32,000/);
});
test('critique supplies exact arithmetic with source identities, without inventing units',()=>{
 const {w,op}=fixture(),first=w.operations[0],content='Budget ceiling: 100 credits per month.';
 first.result={path:'/work/source.md',content,revision:sha(content)};
 const other='Price: 90 credits per month.';w.requirements.files[0].requiredText.push('](price.md)');
 w.operations.push({id:'price',name:'read_system_file',revision:1,status:'completed',arguments:{path:'/work/price.md'},result:{path:'/work/price.md',content:other,revision:sha(other)}});
 assert.deepEqual(critiqueInput(w,op).calculatedRelations,[{left:{source:'/work/price.md',value:'90'},right:{source:'/work/source.md',value:'100'},relation:'<',difference:'-10'}]);
});
test('incomplete, duplicate, out-of-order and oversized audits cannot pass',()=>{
 const {w,op}=fixture(),good=JSON.parse(response().content);
 const invalid=[null,{...good,approve:true},{...good,claims:[]},{...good,claims:[...good.claims,...good.claims]},{...good,claims:[{...good.claims[0],number:'1'}]},{...good,claims:[{...good.claims[0],number:2}]},{...good,coverage:{verdict:'ready',explanation:''}},{...good,coverage:{...assessment(),approve:true}},{...good,claims:[{...good.claims[0],text:assessment('unknown')}]},{...good,claims:[{...good.claims[0],limits:assessment('ready','x'.repeat(601))}]}];
 for(const result of invalid)assert.throws(()=>critiqueReceipt(w,op,{content:JSON.stringify(result)}),/Draft critique/);
 for(const content of ['not JSON',JSON.stringify({verdict:'ready',summary:'Old unstructured response',issues:''})])assert.throws(()=>critiqueReceipt(w,op,{content}),/Draft critique/);
 op.draftCritique=critiqueReceipt(w,op,response('revise','Keep export available now as a fixed condition.'));assert.match(op.draftCritique.issues[0],/^Claim 1 \(text\):/);assert.throws(()=>assertDraftCritique(w,op.arguments,op),/fresh successful critique/);
 const missing={...good,coverage:assessment('revise','The requested budget analysis is absent.')};assert.equal(critiqueReceipt(w,op,{content:JSON.stringify(missing)}).verdict,'revise');
});
test('critique binds model, settings, sources, exact draft and full task context',()=>{
 for(const mutate of [({w})=>w.goal+=' changed',({w})=>w.scope+=' changed',({w})=>w.directives.push({instruction:'New condition'}),({w})=>w.requirements.files[0].requiredText.push('New condition'),({w})=>w.requirements.files[0].finalNewline='forbidden',({w})=>w.revision++,({w})=>w.model='other',({w})=>w.generation.think=false,({op})=>op.arguments.content+=' changed',({op})=>op.sourceReview.claims[0].text='Changed claim']){
  const f=fixture();f.op.draftCritique=critiqueReceipt(f.w,f.op,response());assert.equal(assertDraftCritique(f.w,f.op.arguments,f.op),f.op.draftCritique);mutate(f);assert.throws(()=>assertDraftCritique(f.w,f.op.arguments,f.op),/fresh successful critique/);
 }
});
test('a single failed claim rejects the draft even when coverage and every other claim pass',()=>{
 const {w,op}=fixture();op.sourceReview.claims.push({text:'Another claim with a faulty assumption.',limits:'Incorrect assumption.'});
 const body={coverage:assessment(),claims:[{number:1,text:assessment(),limits:assessment()},{number:2,text:assessment(),limits:assessment('revise','The limitation assumes a capability that the source denies.')}]};
 const result=critiqueReceipt(w,op,{content:JSON.stringify(body)});assert.equal(result.verdict,'revise');assert.match(result.issues[0],/^Claim 2 \(limits\):/);assert.equal(result.audit.claims.length,2);
 for(const claims of [[body.claims[1],body.claims[0]],[body.claims[0],body.claims[0]]])assert.throws(()=>critiqueReceipt(w,op,{content:JSON.stringify({...body,claims})}),/every numbered claim in order/);
 body.claims[1].limits.explanation='Changed caller object';assert.notEqual(result.audit.claims[1].limits.explanation,body.claims[1].limits.explanation);
});
test('critique is opt-in for new tasks and older reviewed proposals stay compatible',()=>{
 const {w,op}=fixture();assert.throws(()=>assertDraftCritique(w,op.arguments,op));delete w.requirements.files[0].draftCritique;assert.equal(assertDraftCritique(w,op.arguments,op),null);w.requirements.files[0].draftCritique=true;w.version=4;assert.equal(assertDraftCritique(w,op.arguments,op),null);
});
test('review reporting accepts one assessment and never dispatches an action request',()=>{
 const {w,op}=fixture(),args=JSON.parse(response().content),call=(name,arguments_)=>({function:{name,arguments:arguments_}});
 for(const value of [args,JSON.stringify(args)])assert.equal(critiqueReceipt(w,op,{tool_calls:[call('submit_draft_review',value)]}).verdict,'ready');
 for(const calls of [[call('propose_file_edit',args)],[call('submit_draft_review',args),call('submit_draft_review',args)],[call('submit_draft_review','bad JSON')]])assert.throws(()=>critiqueReceipt(w,op,{content:JSON.stringify(args),tool_calls:calls}),/Draft critique/);
});
