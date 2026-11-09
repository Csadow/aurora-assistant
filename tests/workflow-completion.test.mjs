import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureCompletion,completionReview} from '../src/workflow-completion.mjs';
import {checkpointProject} from '../src/workflow-checkpoint.mjs';
import {sha} from '../src/vault.mjs';
import {createApp} from '../src/server.mjs';

const at='2026-10-24T10:00:00.000Z',path='/tmp/report.md',text='## Result\n',url='https://example.com/final';
const operation=(id,name,result,extra={})=>({id,name,status:'completed',started:at,finished:at,result,...extra});
function task(){return {id:'workflow',version:19,revision:2,status:'completed',completed:at,updated:at,current:1,steps:[{title:'Prepare result',status:'completed',summary:'My assessment <b>ready</b>',evidence:['read','page','windows']}],requirements:{files:[{path,finalNewline:'required',lineEndings:'lf',requiredText:['## Result']}],commands:[{program:'/usr/bin/node',args:['--test'],cwd:'/tmp',outputIncludes:'pass 1'}],browser:{url,title:'Final'},window:{title:'report.md — Editor',app:'Editor'}},operations:[
 operation('failure','propose_command',{code:1,content:'A prior test failed'},{status:'failed'}),
 operation('write','propose_file_edit',{},{expected:{path,revision:sha(text)},action:'edit'}),
 operation('command','propose_command',{code:0,content:'pass 1'},{action:'check',command:{program:'/usr/bin/node',args:['--test'],cwd:'/tmp'}}),
 operation('read','read_system_file',{path,content:text,revision:sha(text)}),
 operation('page','computer_action',{url,title:'Final',text:'Ready'},{arguments:{operation:'browser_read'}}),
 operation('windows','computer_action',{windows:[{id:'win',app:'Editor',title:'report.md — Editor'}]},{arguments:{operation:'windows'}})
]};}
test('completion groups file, command, page and same-window evidence without model conclusions becoming checks',()=>{
 const w=task(),r=captureCompletion(w);assert.deepEqual(r.checks.map(c=>[c.kind,c.passed]),[['file',true],['command',true],['browser',true],['window',true]]);
 assert.deepEqual(r.checks[0].references.map(x=>[x.id,x.label]),[['read','E4'],['write','E2']]);assert.equal(r.checks[0].observed.revision,sha(text));assert.equal(r.checks[1].observed.code,0);assert.equal(r.checks[2].observed.url,url);assert.equal(r.checks[3].observed.id,'win');
 assert.equal(r.steps[0].summary,w.steps[0].summary);assert.equal(r.failures[0].references[0].id,'failure');assert.equal(r.mode,'recorded');assert.match(r.limits,/judgment/);
});
test('recorded completion survives later journal/input mutations and returned-object edits',()=>{
 const w=task();w.completionReceipt=captureCompletion(w);const saved=structuredClone(w.completionReceipt);
 w.operations.push(operation('later','computer_action',{}, {arguments:{operation:'open_url'}}));w.requirements.browser.url='https://example.com/later';w.steps[0].summary='Changed';
 assert.deepEqual(completionReview(w),saved);const view=completionReview(w);view.checks[0].rule.requiredText.push('Changed');view.steps[0].summary='Edited view';assert.deepEqual(w.completionReceipt,saved);
});
test('older completed tasks are reconstructed read-only and an absent receipt is never silently backfilled',()=>{
 const w=task(),before=structuredClone(w);const r=completionReview(w);assert.equal(r.mode,'legacy');assert.match(r.notice,/not a new verification/);assert.deepEqual(w,before);
 const other={...w,completionReceipt:{...captureCompletion(w),workflow:'another-task'}};assert.equal(completionReview(other).mode,'legacy');
});
test('paused, partial, cancelled and interrupted states never receive a completion snapshot',()=>{
 for(const status of ['paused','running','waiting_approval','needs_verification','cancelled']){
  const w=task();w.status=status;w.steps[0].status='running';w.current=0;w.error='Still unfinished';w.operations.push(operation('pending','computer_action',{}, {status:'waiting_approval',arguments:{operation:'open_path'}}));
  assert.throws(()=>captureCompletion(w));const r=completionReview(w);assert.equal(r.mode,'progress');assert.equal(r.pending[0].references[0].id,'pending');assert.equal(r.error,'Still unfinished');assert.match(r.notice,/not completed/);
 }
});
test('interruption and later effects retain unmet requirements instead of recycling a historical pass',()=>{
 const w=task();w.status='paused';checkpointProject(w,'pause');assert(completionReview(w).checks.every(c=>!c.passed));
 w.operations.push(operation('fresh-read','read_system_file',{path,content:text,revision:sha(text)}),operation('fresh-page','computer_action',{url,title:'Final',text:'Ready'},{arguments:{operation:'browser_read'}}));
 const r=completionReview(w);assert.deepEqual(r.checks.map(c=>c.passed),[true,false,true,false]);assert.equal(r.checks[2].references[0].id,'fresh-page');assert.equal(r.checks[3].observed,null);
});
test('failed/latest or wrong page and split window matches do not become verified receipt items',()=>{
 const w=task();w.operations.push(operation('wrong-page','computer_action',{url:url+'/other',title:'Final',text:'Ready'},{arguments:{operation:'browser_read'}}));w.operations.at(-2).result.windows=[{id:'a',app:'Wrong',title:'report.md — Editor'},{id:'b',app:'Editor',title:'Other'}];
 const r=captureCompletion(w);assert.deepEqual(r.checks.slice(2).map(c=>c.passed),[false,false]);assert(r.checks.slice(2).every(c=>!c.references.length&&!c.observed));
});
test('written files without explicit requirements need complete matching readback and keep their write reference',()=>{
 const w=task();w.requirements.files=[];const good=captureCompletion(w).checks.find(c=>c.kind==='file');assert.equal(good.origin,'write');assert(good.passed);assert.equal(good.rule,null);
 w.operations.find(o=>o.id==='read').result.truncated=true;const bad=captureCompletion(w).checks.find(c=>c.kind==='file');assert(!bad.passed);assert.deepEqual(bad.references.map(r=>r.id),['write']);
});
test('source limitations and recovery observations are labeled assessments, not automatic proof',()=>{
 const w=task();w.operations.find(o=>o.id==='write').sourceReview={claims:[{kind:'unknown',text:'Cause unknown',limits:'Only these sources were read.'}]};w.operations.push(operation('user','user_verification',{content:'I saw a window.'}));
 const r=captureCompletion(w);assert.deepEqual(r.assessments[0].claims,[{kind:'unknown',text:'Cause unknown',limits:'Only these sources were read.'}]);assert.equal(r.userObservations[0].text,'I saw a window.');assert.equal(r.checks.length,4);
});
test('model-selected checks revalidate their observations and keep separate failed-attempt history',()=>{
 const w=task();w.operations.push(operation('verify','verify_outcome',{verified:true,evidence:'page',kind:'browser_url',expected:url}));assert(captureCompletion(w).outcomes[0].passed);
 w.operations.push(operation('changed','computer_action',{url:url+'/later',title:'Later',text:'Changed'},{arguments:{operation:'browser_read'}}));const r=captureCompletion(w);assert(!r.outcomes[0].passed);assert.equal(r.outcomes[0].references[1].id,'page');assert.equal(r.failures.length,1);
});

const until=async fn=>{const end=Date.now()+10000;while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,10));}throw Error('Completion fixture timeout');};
const call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});
test('final step and completion receipt persist atomically, survive restart and ignore external file changes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-completion-')),output=join(dir,'output.md');await writeFile(output,'Before\n');let stage=0;
 const client={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[]}),chat:async(messages,_t,_s,_c,options)=>{
  if(options?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Save the document',check:'Read the exact saved result'}]})};const c=JSON.parse(messages.at(-1).content);stage++;
  if(stage===1)return call('read_system_file',{path:output});
  if(stage===2)return call('propose_file_edit',{path:output,content:text,reason:'Requested edit'});
  if(stage===4)return call('read_system_file',{path:output});
  return call('finish_step',{summary:'The requested result was read back.',evidence:c.evidenceForCompletion.map(x=>x.id)});
 }};
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:client,workflowOptions:{pollMs:10}});
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);await rm(dir,{recursive:true,force:true});});
 const saved=[],put=app.store.put.bind(app.store);app.store.put=async(kind,w)=>{if(kind==='workflows')saved.push(structuredClone(w));return put(kind,w);};
 const w=await app.workflows.start({goal:'Save the exact fixture result',requirements:{files:[{path:output,exactText:text,finalNewline:'required',lineEndings:'lf'}],commands:[]}});
 await until(async()=>!app.workflows.running.has(w.id)&&(await app.workflows.read(w.id)).status==='plan_review');await app.workflows.control(w.id,'approve_plan','',1);
 await until(async()=>!app.workflows.running.has(w.id)&&(await app.workflows.read(w.id)).status==='waiting_approval');assert.equal((await app.store.get('workflows',w.id)).completionReceipt,undefined);
 const action=(await app.store.list('actions'))[0];await app.actions.decide(action.id,'approve',action.digest);
 const done=await until(async()=>{const r=await app.workflows.read(w.id);return !app.workflows.running.has(w.id)&&r.status==='completed'?r:null;});
 assert.equal(done.completionReview.mode,'recorded');assert.equal(done.completionReview.checks[0].passed,true);assert(done.completionReview.failures.some(x=>x.name==='finish_step'));assert(saved.filter(x=>x.current===x.steps.length&&x.steps.length).every(x=>x.status==='completed'&&x.completionReceipt));
 const receipt=structuredClone(done.completionReceipt),actions=await app.store.list('actions');await app.workflows.close();await writeFile(output,'Changed externally\n');await app.workflows.init();const reopened=await app.workflows.read(w.id);assert.deepEqual(reopened.completionReview,receipt);assert.deepEqual(await app.store.list('actions'),actions);assert.equal(await readFile(output,'utf8'),'Changed externally\n');
 const legacy=await app.store.get('workflows',w.id);delete legacy.completionReceipt;await put('workflows',legacy);const before=await readFile(app.store.file('workflows',w.id),'utf8');assert.equal((await app.workflows.read(w.id)).completionReview.mode,'legacy');assert.equal(await readFile(app.store.file('workflows',w.id),'utf8'),before);
 // Simulate a pre-snapshot release interrupted after persisting its last step.
 legacy.status='paused';delete legacy.completed;legacy.requirements.browser={url};legacy.operations.push(operation('historical-page','computer_action',{url,title:'Final',text:'Ready'},{arguments:{operation:'browser_read'}}));checkpointProject(legacy,'restart');await put('workflows',legacy);
 const callsBefore=stage;await app.workflows.control(w.id,'resume');const blocked=await until(async()=>{const r=await app.workflows.read(w.id);return !app.workflows.running.has(w.id)&&['paused','completed'].includes(r.status)?r:null;});
 assert.equal(blocked.status,'paused','An older interrupted final step must not bypass fresh verification');assert.match(blocked.error,/fresh final verification/);assert.equal(blocked.completionReceipt,undefined);assert.equal(blocked.completionReview.mode,'progress');assert.equal(stage,callsBefore);assert.deepEqual(await app.store.list('actions'),actions);

});
