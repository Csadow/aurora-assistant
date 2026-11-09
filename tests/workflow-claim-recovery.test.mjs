import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';

const call=(name,args)=>({content:'',tool_calls:[{function:{name,arguments:args}}]});
async function wait(fn){for(let n=0;n<500;n++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,10));}throw Error('Recovery fixture timeout');}
test('a late rejected limitation can be corrected, reviewed, approved and read back without losing other claims',async t=>{
 const saved=JSON.parse(await readFile(new URL('./fixtures/critique-replay/invented_tiers.json',import.meta.url),'utf8'));
 const dir=await mkdtemp(join(tmpdir(),'aurora-claim-recovery-')),path=join(dir,'decision.md'),sources=saved.workflow.operations.filter(o=>o.name==='read_system_file').map(o=>({path:join(dir,basename(o.arguments.path)),content:o.result.content}));
 for(const s of sources)await writeFile(s.path,s.content);await writeFile(path,'Original output');
 let reviews=0,receivedComplete=false;
 const client={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[]}),chat:async(messages,tools,_s,_c,opts)=>{
  if(opts?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Correct sourced note',check:'Read back the approved output.'}]})};
  const c=JSON.parse(messages.at(-1).content);
  if(tools?.[0]?.function.name==='submit_draft_review'){
   reviews++;assert.equal(c.representation,'complete_claims');assert.equal(c.claims.length,12);
   if(reviews===1){assert.match(c.claims[10].limits,/both tiers/);return call('submit_draft_review',{coverage:{verdict:'ready',explanation:'Fixture coverage.'},claims:c.claims.map((c,i)=>({number:i+1,text:{verdict:i>=10?'revise':'ready',explanation:i===10?'Sources do not establish tiers.':i===11?'Preserve the offline requirement.':'Fixture assessment.'},limits:{verdict:'ready',explanation:'Fixture limits.'}}))});}
   assert.doesNotMatch(c.claims[10].limits,/both tiers/);assert.match(c.claims[11].text,/cannot meet/);return call('submit_draft_review',{coverage:{verdict:'ready',explanation:'Fixture correction received.'},claims:c.claims.map((c,i)=>({number:i+1,text:{verdict:'ready',explanation:'Fixture correction.'},limits:{verdict:'ready',explanation:'Fixture correction.'}}))});
  }
  if(c.savedOutput)return c.savedOutput.phase==='readback'?call('read_system_file',{path}):call('finish_step',{summary:'Read the approved correction back.',evidence:[c.savedOutput.evidence]});
  const available=c.sourceClaimReview[0].sources,missing=available.find(s=>s.needsRead);if(missing)return call('read_system_file',{path:missing.path});
  let claims;
  if(c.repairableDraft){
   claims=c.repairableDraft.claims;assert.equal(claims.length,12);assert.match(claims[10].limits,/both tiers/);assert(!c.repairableDraft.content.includes(claims[10].limits));receivedComplete=true;
   claims[10].text='The sources give conflicting prices for one Orion offer; they do not establish separate tiers.';claims[10].limits='Neither source establishes price authority or separate packages.';
   claims[11].text='Vega cannot meet the fixed offline requirement. Orion matches the capabilities, but budget qualification remains unresolved.';claims[11].limits='At 140 Orion exceeds the ceiling by 20; at 110 it is 10 below. Vega at 90 is 30 below but requires internet.';
  }else claims=saved.workflow.operations.at(-1).sourceReview.claims.map(c=>({text:c.text,kind:c.kind,limits:c.limits,evidence:c.evidence.map(e=>({source:available.find(s=>basename(s.path)===basename(e.source)).evidence,quote:e.quote}))}));
  return call('propose_sourced_file',{path,reason:'Complete source-backed correction',claims});
 }};
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:client,workflowOptions:{pollMs:10,segmentMs:10000}});
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await wait(()=>!app.actions.running.size);await rm(dir,{recursive:true,force:true});});
 const w=await app.workflows.start({goal:'Compare the offers without dropping fixed capabilities.',requirements:{files:[{path,sourceReview:true,draftCritique:true,requiredText:sources.map(s=>']('+basename(s.path)+')'),finalNewline:'required',lineEndings:'lf'}],commands:[]}});
 await wait(async()=>(await app.workflows.read(w.id)).status==='plan_review'&&!app.workflows.running.has(w.id));await app.workflows.control(w.id,'approve_plan','',w.revision);
 const ready=await wait(async()=>{const x=await app.workflows.read(w.id);return x.status==='waiting_approval'&&!app.workflows.running.has(w.id)&&x;});assert(receivedComplete);assert.equal(reviews,2);assert.equal(await readFile(path,'utf8'),'Original output');
 const actions=await app.store.list('actions');assert.equal(actions.length,1);const a=actions[0];assert.equal(a.payload.requirementsCheck.sourceReview.claims.length,12);assert.equal(a.payload.requirementsCheck.draftCritique.representation,'complete_claims');assert.doesNotMatch(a.payload.content,/both tiers/);
 await app.actions.decide(a.id,'approve',a.digest);await wait(async()=>(await app.workflows.read(w.id)).status==='completed');assert.equal(await readFile(path,'utf8'),a.payload.content);assert.equal(ready.operations.filter(o=>o.draftCritique?.verdict==='revise').length,1);
});
