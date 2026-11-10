import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sha} from '../src/vault.mjs';
import {createApp} from '../src/server.mjs';
import {prepareRequirements} from '../src/workflow-requirements.mjs';
import {claimSources,buildClaimReview,sourcedDraft,assertClaimReview,rebindClaimReview,checkClaimFiles} from '../src/workflow-claims.mjs';

const sentence='Vega requires an internet connection for editing.';
const read=(id,path,content)=>({id,name:'read_system_file',revision:1,status:'completed',arguments:{path},result:{path,content,revision:sha(content)}});
const rule=path=>({path,finalNewline:'required',lineEndings:'lf',sourceReview:true,requiredText:['](source.md)','](other.md)']});
const state=()=>({revision:1,requirements:{files:[rule('/work/note.md')],commands:[]},operations:[read('a','/work/source.md',sentence+'\nCost: 90 credits per month.'),read('b','/work/other.md','Vega supports offline editing. Cost: 900 credits per year.')]});
const claim=()=>({text:sentence,kind:'source_statement',evidence:[{source:'E1',quote:sentence}],limits:'This source explicitly requires internet. Monthly and yearly prices have different periods.'});
const content=sentence+'\n[source](source.md) [other](other.md)\n';
test('claim receipts bind exact draft passages and source excerpts without certifying entailment',()=>{
 const w=state(),r=buildClaimReview(w,'/work/note.md',content,[claim()]);assert.equal(r.draftRevision,sha(content));assert.equal(r.claims[0].evidence[0].revision,w.operations[0].result.revision);assert.equal(r.claims[0].evidence[0].line,1);assert.match(r.notice,/not a factual correctness certificate/);
 // Deliberately unsupported paraphrases are not magically understood by a literal checker.
 const misleading={...claim(),text:'Vega works offline.'};assert.equal(buildClaimReview(w,'/work/note.md',misleading.text,[misleading]).claims[0].text,misleading.text);
});
test('fabricated or negation-altered quotes, absent claims, extra fields and out-of-scope sources fail closed',()=>{
 const w=state();
 for(const c of [{...claim(),text:'A claim not in the draft.'},{...claim(),evidence:[{source:'E2',quote:sentence}]},{...claim(),evidence:[{source:'E1',quote:'Vega does not require an internet connection for editing.'}]},{...claim(),limits:''},{...claim(),verified:true},{...claim(),evidence:[{source:'E1',quote:sentence,revision:'forged'}]}])assert.throws(()=>buildClaimReview(w,'/work/note.md',content,[c]),/Source review/);
 assert.throws(()=>buildClaimReview(w,'/work/note.md',content,Array(13).fill(claim())));assert.throws(()=>buildClaimReview(w,'/work/note.md',content,[claim(),claim()]));
});
test('source review identifies citation-only claims before the count limit without creating a review',()=>{
 const w=state(),marker={...claim(),text:'(source.md)'},tooMany=[claim(),marker,...Array(11).fill(claim())];
 assert.throws(()=>buildClaimReview(w,'/work/note.md',content,tooMany),/Claim 2 is only a source filename or citation marker.*added to the generated note automatically/);
 assert.throws(()=>buildClaimReview(w,'/work/note.md',content,[{...marker,text:'[Source](source.md)'}]),/citation marker/);
 assert.throws(()=>buildClaimReview(w,'/work/note.md',content,Array(13).fill(claim())),/You supplied 13 claims; the limit is 12/);
 assert.equal(w.operations.length,2);
});
test('conflicts require distinct observed sources; unknown and inference remain explicit assessments',()=>{
 const w=state(),c={...claim(),kind:'conflict'};assert.throws(()=>buildClaimReview(w,'/work/note.md',content,[c]),/two distinct/);
 c.evidence.push({source:'E2',quote:'Vega supports offline editing.'});assert.equal(buildClaimReview(w,'/work/note.md',content,[c]).claims[0].kind,'conflict');
 const unknown={text:'Migration duration is not established in these sources.',kind:'unknown',evidence:[],limits:'Only the two linked files were searched.'},r=buildClaimReview(w,'/work/note.md',unknown.text,[unknown]);assert.equal(r.sources.length,2);assert.equal(r.claims[0].evidence.length,0);
 assert.equal(buildClaimReview(w,'/work/note.md',unknown.text,[{...unknown,kind:'inference'}]).claims[0].unsupported,true);
 assert.throws(()=>buildClaimReview(w,'/work/note.md',unknown.text,[{...unknown,kind:'source_statement'}]),/need observed excerpts/);
});
test('stale, failed, partial, redacted, superseded and generated source observations are unavailable',()=>{
 for(const mutate of [w=>w.revision++,w=>w.operations[0].result.truncated=true,w=>w.operations[0].arguments.offset=1,w=>w.operations[0].result.offset=1,w=>w.operations[0].result.content='[redacted]',w=>w.operations.push({...read('later','/work/source.md',sentence),status:'failed'}),w=>w.operations.push({id:'write',name:'propose_file_edit',status:'completed',action:'action',arguments:{path:'/work/source.md'}}),w=>w.operations.push({id:'command',name:'propose_command',status:'failed',action:'action'})]){const w=state();mutate(w);assert.throws(()=>buildClaimReview(w,'/work/note.md',content,[claim()]),/Read every linked source/);}
 const w=state();w.operations.push(read('fresh','/work/source.md',sentence));assert.throws(()=>buildClaimReview(w,'/work/note.md',content,[claim()]),/current complete linked source/);assert.equal(claimSources(w,'/work/note.md')[0].evidence,'fresh');
});
test('repairs can retain unchanged claims but edits to claims and new observations invalidate old receipts',()=>{
 const w=state(),args={path:'/work/note.md',content,reason:'test'},review=buildClaimReview(w,args.path,content,[claim()]),op={id:'proposal',sourceReview:review};
 assert.equal(assertClaimReview(w,args,op),review);assert.throws(()=>assertClaimReview(w,{...args,content:content+'new'},op),/exact draft/);
 const repaired=rebindClaimReview(w,review,{...args,content:content+'\n> Additional quotation\n'});assert.notEqual(repaired.draftRevision,review.draftRevision);
 assert.throws(()=>rebindClaimReview(w,review,{...args,content:'Replaced the entire claim.'}),/absent verbatim/);
 w.operations.push(read('new','/work/other.md','New finding.'));assert.throws(()=>assertClaimReview(w,args,op),/observations changed/);
});
test('source-review settings reject exact text, self-citations, output dependencies and missing source links',async()=>{
 const system={path:async p=>p};assert((await prepareRequirements({files:[rule('/work/note.md')],commands:[]},system)).files[0].sourceReview);
 for(const file of [{...rule('/work/note.md'),sourceReview:'true'},{...rule('/work/note.md'),draftCritique:'true'},{...rule('/work/note.md'),sourceReview:false,draftCritique:true},{...rule('/work/note.md'),requiredText:[]},{...rule('/work/note.md'),requiredText:['](https://example.com)']},{...rule('/work/note.md'),requiredText:['](note.md)']},{...rule('/work/note.md'),exactText:content}])await assert.rejects(prepareRequirements({files:[file],commands:[]},system));
 await assert.rejects(prepareRequirements({files:[rule('/work/note.md'),{path:'/work/source.md',finalNewline:'any',lineEndings:'any'}],commands:[]},system),/another output/);
});
test('approval checks actual source content and refuses deletion, changed text and canonical-path changes',async()=>{
 const w=state(),review=buildClaimReview(w,'/work/note.md',content,[claim()]);
 await checkClaimFiles(review,{read:async path=>w.operations.find(o=>o.result.path===path).result});
 for(const read of [async()=>{throw Error('missing');},async()=>({path:'/work/source.md',content:'changed',revision:sha('changed')}),async()=>({...w.operations[0].result,path:'/work/alias.md'})])await assert.rejects(checkClaimFiles(review,{read}),/reviewed source/);
});
test('flat claim fields generate one note and matching receipt with exact source links and scoped unknowns',()=>{
 const w=state(),claims=[{...claim(),evidence:'E1',quote:sentence},{text:'The sources disagree about offline support.',kind:'conflict',evidence:'E1',quote:sentence,counterEvidence:'E2',counterQuote:'Vega supports offline editing.',limits:'The excerpts disagree; neither is established as authoritative.'},{text:'The launch date is not established here.',kind:'unknown',evidence:'',quote:'',limits:'Only the listed sources were searched.'}];
 const result=sourcedDraft(w,{path:'/work/note.md',reason:'Review source differences',claims});assert.equal(result.review.draftRevision,sha(result.arguments.content));for(const c of claims)assert(result.arguments.content.includes(c.text));assert(result.arguments.content.includes('[source.md](source.md)'));assert(result.arguments.content.includes('[other.md](other.md)'));assert.equal(result.review.claims[1].evidence.length,2);assert.equal(result.review.claims[2].evidence.length,0);
 for(const c of [{...claims[0],counterEvidence:'not a source'},{...claims[0],counterQuote:'Missing handle'},{...claims[0],evidence:claim().evidence},{...claims[0],evidence:''}])assert.throws(()=>buildClaimReview(w,'/work/note.md',sentence,[c]));
});
test('source-handle lists attach exact short files, while long sources, bad handles and mixed quotation targets fail closed',()=>{
 const w=state(),text='The sources disagree about offline editing.',c={text,kind:'conflict',evidence:'E1:E2',limits:'Different claims are retained; authority is unresolved.'},r=buildClaimReview(w,'/work/note.md',text,[c]);
 assert.deepEqual(r.claims[0].evidence.map(e=>e.quote),w.operations.map(o=>o.result.content));assert.equal(r.claims[0].evidence[0].line,1);
 for(const evidence of ['E1 E99','E1 therefore E2','E0','E999','source.md','E1:E1'])assert.throws(()=>buildClaimReview(w,'/work/note.md',text,[{...c,evidence}]));
 assert.throws(()=>buildClaimReview(w,'/work/note.md',text,[{...c,quote:'This quote is absent.'}]),/exactly one selected source/);
 for(const quote of ['Vega','Missing quotation'])assert.throws(()=>buildClaimReview(w,'/work/note.md',text,[{...c,quote}]),/exactly one selected source/);
 const routed=buildClaimReview(w,'/work/note.md',text,[{...c,quote:sentence}]);assert.equal(routed.claims[0].evidence[0].quote,sentence);assert.equal(routed.claims[0].evidence[1].quote,w.operations[1].result.content);
 w.operations[0]=read('a','/work/source.md',sentence+' '+'.'.repeat(1200));assert.throws(()=>buildClaimReview(w,'/work/note.md',text,[c]),/exceeds 1,200/);assert.throws(()=>buildClaimReview(w,'/work/note.md',text,[{...c,quote:sentence}]),/complete short sources/);
 assert(buildClaimReview(w,'/work/note.md',sentence,[{...claim(),evidence:'E1',quote:sentence}]).claims[0].evidence.length);
});

const call=(name,args)=>({content:'',tool_calls:[{function:{name,arguments:args}}]});
const wait=async fn=>{const until=Date.now()+6000;while(Date.now()<until){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,10));}throw Error('Claim fixture timed out');};
for(const mode of ['save','without_critique','legacy_critique','changed','restart','repair','bypass','claim_patch','rendered','paused_system','paused_workflow','critique_revise','critique_repeat','critique_tamper','duplicate_write','critique_cancel','reopen_correction'])test('sourced workflow '+mode+' preserves exact review and file safety',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-claims-')),source=join(dir,'source.md'),other=join(dir,'other.md'),path=join(dir,'note.md');await writeFile(source,sentence);await writeFile(other,'Alternative claim.');await writeFile(path,'Original output');let sent=false,critiques=0,reopened=false;
 const client={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[]}),chat:async(m,tools,_s,_c,opts)=>{
  if(tools?.[0]?.function.name==='submit_draft_review'){assert.equal(opts,undefined);assert.equal(tools.length,1);critiques++;if(mode==='critique_cancel')return new Promise((resolve,reject)=>{_s.addEventListener('abort',()=>reject(_s.reason),{once:true});});const revise=mode==='critique_repeat'||mode==='critique_revise'&&critiques===1;return call('submit_draft_review',{coverage:{verdict:'ready',explanation:'Fixture critique <reviewed>.'},claims:JSON.parse(m.at(-1).content).claims.map((c,i)=>({number:i+1,text:{verdict:revise?'revise':'ready',explanation:revise?'Explain all required capabilities without dropping the offline condition.':'Fixture content assessment.'},limits:{verdict:'ready',explanation:'Fixture limits.'}}))});}if(opts?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Write sourced note',check:'Read it back.'}]})};const c=JSON.parse(m.at(-1).content),last=c.recentEvidence.map(JSON.parse).at(-1),sources=c.sourceClaimReview[0]?.sources||[];
  if(mode==='reopen_correction'&&c.savedOutput?.phase==='ready'&&!reopened){reopened=true;return call('reopen_sourced_output',{evidence:c.savedOutput.evidence,issue:'Add the missing explanation of the current limitation.'});}
  if(mode==='duplicate_write'&&c.savedOutput?.phase==='ready'&&last?.name!=='propose_file_edit')return call('propose_sourced_file',{path,reason:'Unnecessary rewrite',claims:[claim()]});
  if(mode==='duplicate_write'&&last?.name==='propose_file_edit'&&last.status==='failed')return call('finish_step',{summary:'Kept the approved note unchanged.',evidence:[c.savedOutput.evidence]});
  if(mode==='bypass')return last?.status==='failed'?call('request_help',{reason:'Review required',question:'Need source review.'}):call('propose_file_edit',{path,content,reason:'Bypass attempt'});
  if(last?.name==='propose_file_edit'&&last.status==='completed')return call('read_system_file',{path});
  if(last?.name==='read_system_file'&&last.result.path===path)return call('finish_step',{summary:'Read the saved note.',evidence:[last.id]});
  const missing=sources.find(s=>s.needsRead);if(missing)return call('read_system_file',{path:missing.path});
  if(mode==='claim_patch'&&c.repairableDraft){assert(tools.some(t=>t.function.name==='propose_draft_patch'));assert(last.result.error.includes(sentence));return call('propose_draft_patch',{draft:c.repairableDraft.evidence,edits:[{before:'VEga',after:'Vega'}],reason:'Correct the draft spelling; preserve claims'});}
  if(mode==='critique_revise'&&c.repairableDraft){assert.deepEqual(c.repairableDraft.claims, [{...claim(),evidence:[{source:sources.find(s=>s.path===source).evidence,quote:sentence}]}]);assert(c.repairableDraft.claims[0].limits.includes('Monthly and yearly'));}
  if(c.repairableDraft?.availableRepair)return call(c.repairableDraft.availableRepair.tool,c.repairableDraft.availableRepair.arguments);
  assert(tools.some(t=>t.function.name==='propose_sourced_file'));assert(!tools.some(t=>t.function.name==='propose_formatted_file'));sent=true;
  if(mode==='rendered'){assert(!tools.find(t=>t.function.name==='propose_sourced_file').function.parameters.properties.content);return call('propose_sourced_file',{path,reason:'Build the note from claims once',claims:[{...claim(),evidence:sources.find(s=>s.path===source).evidence,quote:sentence}]});}
  return call('propose_sourced_file',{path,content:mode==='claim_patch'?content.replace('Vega','VEga'):mode==='repair'?content:content+'Mandatory quotation.\n'+(reopened?'Additional explanation of the limitation.\n':''),reason:'Source review',claims:[{...claim(),evidence:[{source:sources.find(s=>s.path===source).evidence,quote:sentence}]}]});
 }};
 const f=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:client,workflowOptions:{pollMs:10,segmentMs:10000}});
 t.after(async()=>{await f.workflows.close();f.actions.stopAll();await wait(()=>!f.actions.running.size);await rm(dir,{recursive:true,force:true});});
 if(mode==='repair')await writeFile(other,'Alternative claim. Mandatory quotation.');
 const w=await f.workflows.start({goal:'Sourced note',requirements:{files:[{...rule(path),...(mode!=='without_critique'?{draftCritique:true}:{}),...(mode==='repair'?{requiredText:[...rule(path).requiredText,'Mandatory quotation.']}:{})}],commands:[]}});await wait(async()=>(await f.workflows.read(w.id)).status==='plan_review'&&!f.workflows.running.has(w.id));if(mode==='legacy_critique'){const legacy=await f.store.get('workflows',w.id);legacy.version=4;await f.store.put('workflows',legacy);await assert.rejects(f.workflows.updateRequirements(w.id,{revision:legacy.revision,requirements:legacy.requirements}),/Start a new workflow/);assert.equal((await f.store.list('actions')).length,0);return;}await f.workflows.control(w.id,'approve_plan','',w.revision);
 if(mode==='critique_cancel'){await wait(()=>critiques===1);await f.workflows.control(w.id,'pause');assert.equal((await f.workflows.read(w.id)).status,'paused');assert.equal((await f.store.list('actions')).length,0);assert.equal(await readFile(path,'utf8'),'Original output');return;}
 const ready=await wait(async()=>{const r=await f.workflows.read(w.id);return !f.workflows.running.has(w.id)&&['waiting_approval','needs_help'].includes(r.status)&&r;});const actions=await f.store.list('actions');assert.equal(await readFile(path,'utf8'),'Original output');
 if(mode==='critique_repeat'){assert.equal(actions.length,0);assert.equal(critiques,3);assert.equal(ready.status,'needs_help');assert(ready.operations.filter(o=>o.draftCritique).every(o=>o.draftCritique.verdict==='revise'));return;}
 if(mode==='bypass'){assert.equal(actions.length,0);assert.match(ready.operations[0].result.error,/propose_sourced_file/);return;}
 if(mode==='critique_revise')assert.equal(critiques,2);
 assert(sent);assert.equal(actions.length,1);const a=actions[0];assert.equal(a.payload.requirementsCheck.sourceReview.draftRevision,sha(a.payload.content));
 if(mode==='without_critique'){assert.equal(critiques,0);assert.equal(a.payload.requirementsCheck.draftCritique,undefined);}else assert.equal(a.payload.requirementsCheck.draftCritique.verdict,'ready');
 if(mode==='critique_tamper'){const saved=await f.store.get('workflows',w.id);saved.operations.at(-1).draftCritique.summary='Changed assessment';await f.store.put('workflows',saved);await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/critique changed/);assert.equal(await readFile(path,'utf8'),'Original output');return;}
 if(mode==='paused_system'||mode==='paused_workflow'){
  if(mode==='paused_system')f.settings.value.systemEnabled=false;else await f.workflows.control(w.id,'pause');
  let reads=0;const read=f.system.read.bind(f.system);f.system.read=(...args)=>{reads++;return read(...args);};
  await assert.rejects(f.actions.decide(a.id,'approve',a.digest),mode==='paused_system'?/System access is paused/:/Resume/);assert.equal(reads,0);assert.equal(await readFile(path,'utf8'),'Original output');return;
 }
 if(mode==='changed'){await writeFile(source,'New source contents');await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/source changed/);assert.equal(await readFile(path,'utf8'),'Original output');return;}
 if(mode==='restart'){await f.workflows.close();await f.workflows.init();assert.equal((await f.workflows.read(w.id)).status,'paused');await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/Resume/);await f.workflows.control(w.id,'resume');}
 await f.actions.decide(a.id,'approve',a.digest);let finalAction=a;
 if(mode==='reopen_correction'){const again=await wait(async()=>{const r=await f.workflows.read(w.id);return !f.workflows.running.has(w.id)&&r.status==='waiting_approval'&&r.operations.at(-1).action!==a.id&&r;});const second=await f.store.get('actions',again.operations.at(-1).action);assert(reopened);assert.notEqual(second.payload.content,a.payload.content);assert.equal(await readFile(path,'utf8'),a.payload.content);assert(!f.workflows.completionRefs(again).items.enum.includes('E'+(again.operations.findIndex(o=>o.name==='reopen_sourced_output')+1)));await f.actions.decide(second.id,'approve',second.digest);finalAction=second;}
 const done=await wait(async()=>{const r=await f.workflows.read(w.id);return r.status==='completed'&&r;});assert.equal(await readFile(path,'utf8'),finalAction.payload.content);assert.equal((await f.store.list('actions')).length,mode==='reopen_correction'?2:1);assert(done.operations.some(o=>o.name==='read_system_file'&&o.result?.path===path));assert.equal(await readFile(source,'utf8'),sentence);
 if(mode==='claim_patch')assert(done.operations.some(o=>o.requestedTool==='propose_draft_patch'&&o.sourceReview));
 if(mode==='repair')assert(done.operations.some(o=>o.requestedTool==='propose_draft_repair'&&o.sourceReview));
});
