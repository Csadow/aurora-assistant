import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {prepareRequirements,requirementStatus,hasRequirements} from '../src/workflow-requirements.mjs';
import {checkpointProject} from '../src/workflow-checkpoint.mjs';
import {verifyOutcome} from '../src/workflow-evidence.mjs';

const page={url:'https://example.com/report?week=6#summary',title:'Weekly report',text:'Ready'};
const window={id:'0x42',app:'Editor',title:'report.md — Editor'};
const rules={files:[],commands:[],browser:{url:page.url,title:page.title},window:{title:window.title,app:window.app}};
const op=(id,operation,result)=>({id,name:'computer_action',arguments:{operation},status:'completed',result});
const task=()=>({version:19,status:'paused',requirements:structuredClone(rules),operations:[op('page','browser_read',page),op('windows','windows',{windows:[window]})]});
const statuses=w=>requirementStatus(w).map(c=>c.passed);

test('desktop conditions are optional, bounded literal inputs and do not grant an action',async()=>{
 assert.deepEqual(await prepareRequirements(undefined),{files:[],commands:[]});assert.deepEqual(await prepareRequirements({files:[],commands:[]}),{files:[],commands:[]});
 assert.deepEqual(await prepareRequirements(rules),rules);assert(hasRequirements({requirements:rules}));
 assert.equal((await prepareRequirements({files:[],commands:[],browser:{url:'HTTPS://EXAMPLE.COM'}})).browser.url,'https://example.com/');
 for(const browser of [null,[],{}, {...rules.browser,extra:true},{url:'file:///tmp/a'},{url:'javascript:alert(1)'},{url:'https://user:pass@example.com/'},{url:'https://example.com/\n'},{url:'https://example.com/',title:''},{url:'https://example.com/',title:'x'.repeat(501)}])await assert.rejects(prepareRequirements({...rules,browser}));
 for(const window of [null,[],{}, {title:' '},{title:'x',app:''},{title:'x',app:'a'.repeat(201)},{title:'x\ny'},{title:'x',contains:true}])await assert.rejects(prepareRequirements({...rules,window}));
});

test('exact page and same-window conditions reject unrelated easy strings, suffixes, split matches and user claims',()=>{
 assert.deepEqual(statuses(task()),[true,true]);
 for(const change of [{url:'https://example.com/other'}, {url:page.url+'&different'}, {title:page.title+' draft'}, {title:page.title.toLowerCase()}]){
  const w=task();w.operations[0].result={...page,...change};
  // An ordinary model-selected check may pass; the declared requirement cannot.
  const result=verifyOutcome(w,{evidence:'page',kind:'browser_text',expected:'Ready'});
  w.operations.push({id:'generic',name:'verify_outcome',status:'completed',result},{id:'user',name:'user_verification',status:'completed',result:{content:'I checked it'}});
  assert.deepEqual(statuses(w),[false,true]);
 }
 for(const windows of [[{...window,title:'another-report.md — Editor'}],[{...window,title:window.title+' backup'}],[{...window,title:'Other'}, {...window,id:'0x43',app:'Other'}],[{...window,app:'Other'}],[]]){
  const w=task();w.operations[1].result={windows};assert.deepEqual(statuses(w),[true,false]);
 }
 const w=task();delete w.requirements.window.app;delete w.requirements.browser.title;w.operations[0].result={...page,title:'Dynamic title'};w.operations[1].result={windows:[{...window,app:'Other'}]};assert.deepEqual(statuses(w),[true,true]);
});

test('latest observations, native input, commands and uncertain actions invalidate declared outcomes',()=>{
 for(const operation of ['browser_fill','browser_click','browser_key','browser_back','open_url','open_path','open_app','close_window','type_text','key','click','scroll']){
  for(const state of ['completed','failed','interrupted']){
   const w=task();w.operations.push({...op('effect',operation,{}),status:state,action:'a'});assert.deepEqual(statuses(w),[false,false],operation+' '+state);
   w.operations.push(op('fresh-page','browser_read',page),op('fresh-windows','windows',{windows:[window]}));assert.deepEqual(statuses(w),[true,true]);
  }
 }
 const edited=task();edited.operations.push({id:'save',name:'propose_file_edit',status:'completed',action:'write',result:{}});assert.deepEqual(statuses(edited),[false,false]);
 const w=task();w.operations.push({id:'cmd',name:'propose_command',status:'failed',action:'a',result:{code:1}});assert.deepEqual(statuses(w),[false,false]);
 for(const [operation,result,expected] of [['browser_read',{...page,url:'https://example.com/wrong'},[false,true]],['windows',{windows:[]},[true,false]]]){
  const x=task();x.operations.push(op('latest',operation,result));assert.deepEqual(statuses(x),expected);
  x.operations.at(-1).status='failed';assert.deepEqual(statuses(x),expected);
 }
 const rejected=task();rejected.operations.push({...op('no-action','browser_fill',{error:'invalid arguments'}),status:'failed'});assert.deepEqual(statuses(rejected),[true,true]);
});

test('restart requires fresh declared observations; pending reads can execute after reviewed resume',()=>{
 const w=task(),original=structuredClone(w.requirements);checkpointProject(w,'restart');assert.deepEqual(statuses(w),[false,false]);assert.deepEqual(w.requirements,original);
 w.operations.push(op('fresh-page','browser_read',page),op('fresh-windows','windows',{windows:[window]}));assert.deepEqual(statuses(w),[true,true]);
 const x=task();x.operations[1].status='waiting_approval';x.operations[1].action='pending';checkpointProject(x,'pause');x.operations[1].status='completed';x.operations[1].executionCheckpoint=x.projectCheckpoint.id;assert.deepEqual(statuses(x),[false,true]);checkpointProject(x,'restart');assert.deepEqual(statuses(x),[false,false]);
});

const call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});
const until=async fn=>{const end=Date.now()+12000;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('Desktop requirements fixture timeout');};
test('wrong page and document block final completion, survive restart and task updates, then pass on fresh exact observations',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-outcomes-'));let mode='wrong',stage=0;const contexts=[];
 const client={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[]}),chat:async(messages,_t,_s,_c,options)=>{
  if(options?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Verify the requested page and document',check:'Match saved exact outcomes'}]})};
  const c=JSON.parse(messages.at(-1).content);contexts.push(c);stage++;
  return [()=>call('computer_action',{operation:'browser_read'}),()=>call('computer_action',{operation:'windows'}),()=>call('finish_step',{summary:'The page and document are ready',evidence:c.evidenceForCompletion.map(o=>o.id)}),()=>call('request_help',{reason:'Saved checks failed',question:'The observed page and window do not match. Please check the task.'})][stage-1]();
 }};
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:client,workflowOptions:{pollMs:10}});
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);await rm(dir,{recursive:true,force:true});});
 app.computer.request=async(method,input)=>method==='prepare'?input:input.operation==='browser_read'?{...page,...mode==='wrong'?{url:'https://example.com/wrong'}:{}}:{windows:[{...window,...mode==='wrong'?{title:'wrong.md — Editor'}:{}}]};
 const w=await app.workflows.start({goal:'Check the saved exact page and document conditions.',requirements:rules});
 const wait=status=>until(async()=>{const r=await app.workflows.read(w.id);return r.status===status&&!app.workflows.running.has(w.id)?r:null;});
 const planned=await wait('plan_review');assert.equal(planned.operations.length,0);assert.equal((await app.store.list('actions')).length,0);
 await app.workflows.control(w.id,'approve_plan','',1);const blocked=await wait('needs_help');assert(blocked.operations.some(o=>o.name==='finish_step'&&o.status==='failed'&&o.result.error.includes('Output requirements')));assert.deepEqual(statuses(blocked),[false,false]);
 await app.workflows.close();await app.workflows.init();assert.deepEqual((await app.workflows.read(w.id)).requirements,rules);
 await app.workflows.steer(w.id,'Keep the same requested outcomes and inspect again.',1);const replanned=await wait('plan_review');assert.deepEqual(replanned.requirements,rules);
 mode='right';stage=0;await app.workflows.control(w.id,'approve_plan','',replanned.revision);const done=await wait('completed');assert.deepEqual(statuses(done),[true,true]);assert(contexts.every(c=>JSON.stringify(c.outputRequirements)===JSON.stringify(rules)));assert.equal((await app.store.list('actions')).filter(a=>a.kind!=='computer').length,0);
});

test('adding explicit desktop conditions to older tasks opts into fresh interruption checks without changing their version',()=>{
 for(const version of [1,5,6,17,18]){
  const w=task();w.version=version;checkpointProject(w,'pause');assert.equal(w.projectCheckpoint.kind,'desktop');assert.deepEqual(statuses(w),[false,false]);assert.equal(w.version,version);
  w.operations.push(op('new-page','browser_read',page),op('new-windows','windows',{windows:[window]}));assert.deepEqual(statuses(w),[true,true]);
 }
});
