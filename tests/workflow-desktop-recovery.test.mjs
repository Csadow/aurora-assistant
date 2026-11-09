import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {AppError,sha} from '../src/vault.mjs';
import {checkpointProject,projectCheckpointContext,beforeCheckpoint} from '../src/workflow-checkpoint.mjs';
import {verifyOutcome,missingOutcomes} from '../src/workflow-evidence.mjs';
import {unverifiedWrites} from '../src/workflow-health.mjs';
import {modelObservation} from '../src/workflow-tools.mjs';
import {checkpointHTML} from '../public/workflow-review.js';

const page={url:'https://example.com/',title:'Fixture title',text:'Fixture text',revision:'snapshot'};
const op=(id,name,args,result)=>({id,name,arguments:args,result,status:'completed',started:'2026-01-01T01:00:00Z',finished:'2026-01-01T01:00:01Z'});
const fixture=version=>({version,status:'paused',requirements:{files:[],commands:[]},operations:[
  op('browser','computer_action',{operation:'open_url'},page),
  op('write','propose_file_edit',{path:'/fixture/title.txt'},{content:'saved'}),
  op('file','read_system_file',{path:'/fixture/title.txt'},{path:'/fixture/title.txt',content:'Fixture title\n',revision:sha('Fixture title\n')}),
  op('open','computer_action',{operation:'open_path',path:'/fixture/title.txt'},{content:'Requested opening'}),
  op('windows','computer_action',{operation:'windows'},{windows:[{id:'0x42',app:'Editor',title:'title.txt'}]}),
  op('screen','inspect_desktop',{}, {content:'Editor visible'})
]});

test('desktop interruption invalidates browser, window, screen and file observations while preserving the old contract',()=>{
 for(const version of [17,18]){
  const w=fixture(version);w.operations[1].expected={path:'/fixture/title.txt',revision:sha('Fixture title\n')};w.operations[2].started='2026-01-02';
  const contract=JSON.stringify(w.requirements),journal=JSON.stringify(w.operations);checkpointProject(w,'restart');
  assert.equal(JSON.stringify(w.requirements),contract);assert.equal(JSON.stringify(w.operations),journal);
  for(const [evidence,kind,expected] of [['browser','browser_title','Fixture title'],['windows','window_title','title.txt'],['screen','screen_text','Editor'],['file','file_text','Fixture title']]){
   if(version===18)assert.throws(()=>verifyOutcome(w,{evidence,kind,expected}),/interruption/);
   else assert(verifyOutcome(w,{evidence,kind,expected}).verified);
  }
  if(version===17){assert.equal(w.projectCheckpoint,undefined);continue;}
  assert.equal(projectCheckpointContext(w).kind,'desktop');assert.equal(projectCheckpointContext(w).lastObserved.length,3);assert.equal(unverifiedWrites(w).length,1);
  assert(missingOutcomes(w).every(x=>!x.availableObservation));assert.equal(modelObservation(w,w.operations[0]).historical,true);
  const checkpoint=JSON.stringify(w.projectCheckpoint);checkpointProject(w,'resume');assert.equal(JSON.stringify(w.projectCheckpoint),checkpoint);
  w.operations.push(op('fresh-browser','computer_action',{operation:'browser_read'},page),op('fresh-windows','computer_action',{operation:'windows'},w.operations[4].result),op('fresh-screen','inspect_desktop',{},w.operations[5].result));
  for(const [evidence,kind,expected] of [['fresh-browser','browser_title','Fixture title'],['fresh-windows','window_title','title.txt'],['fresh-screen','screen_text','Editor']])assert(verifyOutcome(w,{evidence,kind,expected}).verified);
 }
});

test('a pending browser read executed after resume is fresh only for that interruption',()=>{
 const w=fixture(18),pending=op('pending','computer_action',{operation:'browser_read'},null);pending.status='waiting_approval';pending.action='action';w.operations.push(pending);checkpointProject(w,'pause');const id=w.projectCheckpoint.id;
 assert(beforeCheckpoint(w,pending));pending.status='completed';pending.result=page;pending.executionCheckpoint=id;
 assert(!beforeCheckpoint(w,pending));assert(verifyOutcome(w,{evidence:pending.id,kind:'browser_title',expected:'Fixture title'}).verified);
 checkpointProject(w,'restart');assert.notEqual(w.projectCheckpoint.id,id);assert(beforeCheckpoint(w,pending));
});

test('desktop checkpoint review escapes historical titles and does not turn uncertainty into confirmation',()=>{
 const w=fixture(18),evil='<img src=x onerror=alert(1)>';w.operations[0].result={...page,title:evil,url:'https://example.com/'+evil};w.operations.push({...op('lost','computer_action',{operation:'browser_click'},{error:'lost reply'}),status:'failed',action:'uncertain'});checkpointProject(w,'uncertain_action');
 const escape=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');const html=checkpointHTML(projectCheckpointContext(w),escape);
 assert(html.includes('data-desktop-checkpoint'));assert(html.includes('Last observed before interruption'));assert(html.includes('does not resolve'));assert(!html.includes('<img'));assert(html.includes('&lt;img'));
});

const call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});
const until=async fn=>{const end=Date.now()+12000;while(Date.now()<end){const x=await fn();if(x)return x;await new Promise(r=>setTimeout(r,10));}throw Error('Recovery fixture timed out');};
test('lost editor acknowledgement survives runner restart and resumes with fresh evidence without reopening or rewriting',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'aurora-desktop-recovery-')),path=join(dir,'title.txt');let opens=0,reads=0,resuming=false,step=0,after=0;
 const client={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[]}),chat:async(messages,_t,_s,_c,options)=>{
  if(options?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Save and open title',check:'Verify the saved file and visible editor'}]})};
  const c=JSON.parse(messages.at(-1).content),find=name=>c.evidenceForCompletion.findLast(e=>e.name===name)?.id;
  if(!resuming){step++;return [()=>call('computer_action',{operation:'open_url',url:page.url}),()=>call('verify_outcome',{evidence:find('computer_action'),kind:'browser_title',expected:page.title}),()=>call('propose_file_edit',{path,content:page.title+'\n',reason:'Save observed title'}),()=>call('read_system_file',{path}),()=>call('computer_action',{operation:'open_path',path})][step-1]();}
  after++;assert.equal(c.projectRecovery.kind,'desktop');assert(c.evidenceForCompletion.every(e=>!['E1','E2','E3','E4','E5'].includes(e.id)));
  return [()=>call('computer_action',{operation:'browser_read'}),()=>call('verify_outcome',{evidence:find('computer_action'),kind:'browser_title',expected:page.title}),()=>call('computer_action',{operation:'windows'}),()=>call('verify_outcome',{evidence:find('computer_action'),kind:'window_title',expected:'title.txt'}),()=>call('read_system_file',{path}),()=>call('finish_step',{summary:'Fresh browser, file and window checks completed; no repeated effects.',evidence:c.evidenceForCompletion.map(e=>e.id)})][after-1]();
 }};
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:client,workflowOptions:{pollMs:10}});
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);await rm(dir,{recursive:true,force:true});});
 app.computer.request=async(method,input)=>{
  if(method==='prepare')return input;
  if(['open_url','browser_read'].includes(input.operation)){reads++;return {...page};}
  if(input.operation==='open_path'){opens++;throw new AppError('Editor opened, but the desktop reply was lost.');}
  if(input.operation==='windows')return {windows:[{id:'0x42',app:'Editor',title:'title.txt'}]};throw Error('Unexpected operation');
 };
 const w=await app.workflows.start({goal:'Save the observed browser title and open the saved file',requirements:{files:[{path,finalNewline:'required',lineEndings:'lf'}],commands:[]}});
 const wait=status=>until(async()=>{const r=await app.workflows.read(w.id);return r.status===status&&!app.workflows.running.has(w.id)?r:null;});
 await wait('plan_review');await app.workflows.control(w.id,'approve_plan','',1);await wait('waiting_approval');
 const write=await until(async()=>(await app.store.list('actions')).find(a=>a.kind==='write'&&a.status==='pending'));await app.actions.decide(write.id,'approve',write.digest);await wait('needs_verification');
 assert.equal(opens,1);assert.equal(await readFile(path,'utf8'),page.title+'\n');await app.workflows.close();await app.actions.init();await app.workflows.init();
  const stopped=await wait('needs_verification');assert.equal(stopped.projectRecovery.completedEdits.length,1);assert.equal(stopped.projectRecovery.uncertainActions,1);await assert.rejects(app.workflows.control(w.id,'resume'),/uncertain result/);
 assert(missingOutcomes(stopped).some(x=>x.group==='window'&&!x.availableObservation),'a lost open receipt still needs a fresh window check');
 // Explicit simulated user observation; reconnecting/initializing did not resolve it.
 await app.workflows.control(w.id,'resolve','I checked the editor: title.txt is already open. Do not reopen it.');resuming=true;await app.workflows.control(w.id,'resume');const done=await wait('completed');
 assert.equal(opens,1);assert.equal(reads,2);assert.equal((await app.store.list('actions')).filter(a=>a.kind==='write').length,1);assert.deepEqual(missingOutcomes(done),[]);assert.deepEqual(unverifiedWrites(done),[]);assert(done.requirementChecks.every(c=>c.passed));assert.equal(done.projectRecovery.uncertainActions,0);
});
