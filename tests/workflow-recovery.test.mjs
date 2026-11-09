import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {sha} from '../src/vault.mjs';
import {lineEdit,modelObservation,savedCheck} from '../src/workflow-tools.mjs';
import {diagnosticExcerpt,diagnosticCheck,recoveryReads,repeatedObservations} from '../src/workflow-recovery.mjs';
import {filePatch} from '../src/file-patch.mjs';
const call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});
const until=async fn=>{const end=Date.now()+10000;while(Date.now()<end){const x=await fn();if(x)return x;await new Promise(r=>setTimeout(r,10));}throw Error('Recovery fixture timed out');};
const observed=(content,path='/tmp/file.txt')=>({id:'read',name:'read_system_file',status:'completed',result:{path,content,revision:sha(content),truncated:false}});
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'aurora-recovery-test-')),folder=join(dir,'project');await mkdir(folder);const file=join(folder,'one.txt');await writeFile(file,'before\n');let respond=()=>call('ask_user',{question:'Review the fixture.'});
 const model={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,tools,signal,_c,options)=>{signal.throwIfAborted();return options?.format?.properties.steps?{content:JSON.stringify({steps:[{title:'Repair and verify',check:'Observed content and successful saved check.'}]})}:respond(JSON.parse(m.at(-1).content),tools,m,signal);}};
 const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:model,workflowOptions:{pollMs:10,segmentMs:10000}});
 t.after(async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
 const wait=(id,status)=>until(async()=>{const w=await app.workflows.read(id);return w.status===status&&!app.workflows.running.has(id)?w:null;});
 const start=async extra=>{const w=await app.workflows.start({goal:'Repair and verify the file',...extra});if(extra?.projectId){await wait(w.id,'plan_review');await app.workflows.control(w.id,'approve_plan','',1);}return w;};
 const approve=async id=>{const a=await until(async()=>{const w=await app.workflows.read(id);if(w.status!=='waiting_approval'||app.workflows.running.has(id))return null;const a=await app.store.get('actions',w.operations.at(-1).action);return a.status==='pending'?a:null;});await app.actions.decide(a.id,'approve',a.digest);return a;};
 return {...app,dir,folder,file,wait,start,approve,setReply:r=>respond=r};
}
test('line edits preserve CRLF, final newlines and repeated lines without fuzzy matching',()=>{
 for(const text of ['same\r\nsame\r\nlast\r\n','same\nsame\nlast','same\rsame\rlast\r']){
  const w={operations:[observed(text)]},args=lineEdit(w,{evidence:'E1',line:2,text:'changed',reason:'Fix this line'});
  assert.equal(filePatch(text,args.edits).content,text.replace(/^(same(?:\r\n|\r|\n))same/,'$1changed'));
  assert.match(modelObservation(w,w.operations[0]).numberedLines,/2: same/);
  assert.equal(w.operations[0].result.content,text);
 }
 for(const indentation of ['  ','\t']){
  const original=indentation+'const value=Math.max(a,b);\r\n',w={operations:[observed(original)]};
  const patch=lineEdit(w,{evidence:'E1',line:1,text:'const value=Math.min(a,b);',reason:'Correct expression'});
  assert.equal(filePatch(original,patch.edits).content,indentation+'const value=Math.min(a,b);\r\n');
  assert.throws(()=>lineEdit(w,{evidence:'E1',line:1,text:indentation+'changed'}),/Original indentation/);
 }
 const w={operations:[observed('one\ntwo\n')]};
 for(const args of [{line:0,text:'x'},{line:3,text:'x'},{line:1,text:'x\ny'},{line:1,text:'one'},{line:1,text:'x',path:'/tmp/override'}])assert.throws(()=>lineEdit(w,{evidence:'E1',reason:'Fix',...args}));
 w.operations[0].result.revision=sha('different');assert.throws(()=>lineEdit(w,{evidence:'E1',line:1,text:'x'}),/unredacted/);
});
test('saved check references bind exact arguments and reject overrides',()=>{
 const command={program:'/usr/bin/node',args:['--test','one.test.mjs'],cwd:'/tmp/project'},w={requirements:{commands:[command]}};
 assert.deepEqual(savedCheck(w,{check:'C1',reason:'Verify'}),{...command,reason:'Verify'});
 for(const input of [{check:'C2'},{check:'C1',argv:'--help'},{check:'C1',args:[]},{check:'C01'}])assert.throws(()=>savedCheck(w,input));
});
test('fragment proposals remain exact reviewed writes and preserve their model arguments in history',async t=>{
 const f=await fixture(t),original='\tconst first=a+b,second=c-d;\r\n';await writeFile(f.file,original);let n=0;
 f.setReply((c,tools,m)=>{
  assert(tools.some(t=>t.function.name==='propose_span_edit'));
  if(++n===1)return call('read_system_file',{path:f.file});
  if(n===2)return call('propose_span_edit',{evidence:'E1',line:1,before:'a+b',after:'a-b',reason:'Subtract only the first reserved value'});
  if(n===3){const prior=m.find(x=>x.tool_calls?.[0]?.function.name==='propose_span_edit');assert.equal(prior.tool_calls[0].function.arguments.before,'a+b');return call('read_system_file',{path:f.file});}
  return call('finish_step',{summary:'Corrected the first expression; retained the rest.',evidence:['E3']});
 });
 const w=await f.start(),review=await f.wait(w.id,'waiting_approval'),a=await f.store.get('actions',review.operations.at(-1).action);
 assert.equal(await readFile(f.file,'utf8'),original);assert.equal(a.payload.content,original.replace('a+b','a-b'));assert(a.payload.patch);
 assert.equal(review.operations.at(-1).requestedTool,'propose_span_edit');assert.equal(review.operations.at(-1).requestedArguments.before,'a+b');
 await f.actions.decide(a.id,'approve',a.digest);await f.wait(w.id,'completed');assert.equal(await readFile(f.file,'utf8'),a.payload.content);assert.equal((await f.store.list('actions')).length,1);
});
test('a reviewed fragment cannot overwrite an external change made after proposal',async t=>{
 const f=await fixture(t);let n=0;f.setReply(()=>++n===1?call('read_system_file',{path:f.file}):call('propose_span_edit',{evidence:'E1',line:1,before:'before',after:'after',reason:'Replace the observed text'}));
 const w=await f.start(),review=await f.wait(w.id,'waiting_approval'),a=await f.store.get('actions',review.operations.at(-1).action);await writeFile(f.file,'external\n');
 await f.actions.decide(a.id,'approve',a.digest);const failed=await until(async()=>{const current=await f.store.get('actions',a.id);return current.status==='failed'?current:null;});assert.match(failed.result.content,/changed|stale/i);assert.equal(await readFile(f.file,'utf8'),'external\n');assert.equal((await f.store.list('actions')).length,1);
});
test('project prompts include observed source once while retaining the complete goal and fixed checks',async t=>{
 const f=await fixture(t),source='// unique_project_context_sentinel\nconst a=1;\n';await writeFile(f.file,source);
 const p=await f.projectWorkspaces.save({name:'Fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Check',program:'node',args:['--version'],cwd:f.folder,outputIncludes:'v'}]});let n=0;
 f.setReply((c,_tools,m)=>{
  if(++n===1)return call('read_system_file',{path:f.file});
  assert.equal(JSON.stringify(m).split('unique_project_context_sentinel').length-1,1);
  assert.equal(c.goal,'Repair and verify the file');assert.equal(c.outputRequirements.commands.length,1);assert.equal(c.outputRequirements.files[0].path,f.file);
  assert.equal(c.fileObservations[0].numbered,true);assert.equal(c.fileObservations[0].excerpt,undefined);assert.equal(c.fileObservations[0].inRecentToolResult,true);const read=m.find(x=>x.role==='tool'&&x.tool_name==='read_system_file');assert.match(JSON.parse(read.content).result.numberedLines,/2: const a=1;/);assert.equal(c.fileObservations[0].needsFreshRead,false);
  return call('ask_user',{question:'Fixture inspection complete.'});
 });
 const w=await f.start({projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check'],requirements:{files:[{path:f.file,lineEndings:'lf',finalNewline:'required'}],commands:[]}}),done=await f.wait(w.id,'waiting_input');
 assert.equal(done.operations[0].result.content,source);assert.equal((await f.store.list('actions')).length,0);
});
test('saved repair lists persist through a pending-action restart and cannot be cited as completion evidence',async t=>{
 const f=await fixture(t),p=await f.projectWorkspaces.save({name:'Fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Check',program:'node',args:['--version'],cwd:f.folder,outputIncludes:'v'}]});let n=0;
 f.setReply(c=>{
  if(++n===1)return call('read_system_file',{path:f.file});
  if(n===2)return call('record_repair_plan',{repairs:[{file:f.file,line:1,before:'before',after:'after',reason:'Correct the fixture text.'}]});
  if(n===3){assert.equal(c.repairPlan.repairs[0].state,'remaining');assert(!c.evidenceForCompletion.some(e=>e.id==='E2'));return call('finish_step',{summary:'Claim only',evidence:['E2']});}
  if(n===4)return call('propose_repair',{repair:c.repairPlan.repairs[0].id});
  assert.equal(c.repairPlan.repairs.length,0);assert.equal(c.completedEdits.length,1);assert.equal(c.completedEdits[0].repair,'R2.1');return call('ask_user',{question:'Fixture stopped after the reviewed edit.'});
 });
 const w=await f.start({projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check'],requirements:{files:[{path:f.file,lineEndings:'lf',finalNewline:'required'}],commands:[]}}),pending=await f.wait(w.id,'waiting_approval'),a=await f.store.get('actions',pending.operations.at(-1).action);
 assert.equal(pending.repairPlan.repairs[0].state,'awaiting_action');assert.match(pending.operations[2].result.error,/not successful observations/);assert.equal(a.payload.content,'after\n');assert(a.payload.patch);assert.equal(await readFile(f.file,'utf8'),'before\n');
 await f.workflows.control(w.id,'pause');await f.workflows.close();await f.workflows.init();assert.deepEqual(await f.store.get('actions',a.id),a);assert.equal((await f.workflows.read(w.id)).repairPlan.repairs[0].state,'awaiting_action');await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/Resume/);
 await f.workflows.control(w.id,'resume');await f.actions.decide(a.id,'approve',a.digest);const done=await f.wait(w.id,'waiting_input');assert.equal(done.repairPlan.repairs[0].state,'edit_applied');assert.equal(await readFile(f.file,'utf8'),'after\n');assert.equal((await f.store.list('actions')).length,1);assert(done.inputUsage.every(u=>u.bytes<=24000));
});
for(const [label,question] of [
 ['open review','The exact source correction is ready. Would you like me to open the exact edit review now?'],
 ['named proposal','The exact source correction is ready. Ready for your approval: propose_repair for the saved correction?']
])test('a local project rejects chat permission to '+label+' and proceeds to the action review',async t=>{
 const f=await fixture(t),project=await f.projectWorkspaces.save({name:'Fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Check',program:'node',args:['--version'],cwd:f.folder,outputIncludes:'v'}]});let calls=0;
 f.setReply(c=>{
  if(++calls===1)return call('read_system_file',{path:f.file});
  if(calls===2)return call('record_repair_plan',{repairs:[{file:f.file,line:1,before:'before',after:'after',reason:'Correct the observed fixture.'}]});
  if(calls===3){assert.equal(c.projectProgress.next.tool,'propose_repair');return call('ask_user',{question});}
  return call('propose_repair',{repair:c.repairPlan.repairs[0].id});
 });
 const w=await f.start({projectId:project.id,projectRevision:project.revision,projectCheckNames:['Check'],requirements:{files:[{path:f.file,lineEndings:'lf',finalNewline:'required'}],commands:[]}}),pending=await f.wait(w.id,'waiting_approval');
 assert.equal(calls,4);assert.equal(pending.operations[2].name,'ask_user');assert.equal(pending.operations[2].status,'failed');assert.match(pending.operations[2].result.error,/Call propose_repair to open that review/);assert.equal(pending.question,undefined);
 const action=await f.store.get('actions',pending.operations.at(-1).action);assert.equal(action.kind,'write');assert.equal(action.status,'pending');assert.equal(action.payload.path,f.file);assert.equal(await readFile(f.file,'utf8'),'before\n');
});
test('expression examples are persisted calculations, never completion evidence or write approval',async t=>{
 const f=await fixture(t),before='const width=Math.max(a,b);\n';await writeFile(f.file,before);
 const p=await f.projectWorkspaces.save({name:'Fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Check',program:'node',args:['--version'],cwd:f.folder,outputIncludes:'v'}]});let n=0;
 f.setReply((c,tools,m)=>{
  if(++n===1)return call('read_system_file',{path:f.file});
  if(n===2)return call('select_project_tools',{group:'files'});
  if(n===3)return call('record_repair_plan',{repairs:[{file:f.file,line:1,before:'Math.max(a,b)',after:'Math.min(a,b)',reason:'Bound the width.'}]});
  if(n===4){assert.equal(c.toolGroup,'project');assert(tools.some(t=>t.function.name==='check_repair_expression'));return call('check_repair_expression',{repair:c.repairPlan.repairs[0].id,cases:[{inputs:{a:700,b:1280},expected:700}]});}
  if(n===5){assert.equal(c.repairPlan.repairs[0].expressionCheck.examplesMatch,true);assert(!c.evidenceForCompletion.some(e=>e.id==='E4'));assert(m.some(x=>x.role==='tool'&&x.tool_name==='check_repair_expression'));return call('finish_step',{summary:'Only examples checked.',evidence:['E4']});}
  if(n===6)return call('propose_repair',{repair:c.repairPlan.repairs[0].id});
  return call('ask_user',{question:'Inspect the saved correction.'});
 });
 const w=await f.start({projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check'],requirements:{files:[{path:f.file,lineEndings:'lf',finalNewline:'required'}],commands:[]}}),review=await f.wait(w.id,'waiting_approval');
 assert.match(review.operations[4].result.error,/not successful observations/);assert.equal(review.operations[3].action,undefined);assert.equal(await readFile(f.file,'utf8'),before);
 const a=await f.store.get('actions',review.operations.at(-1).action);assert.equal(a.payload.content,before.replace('Math.max','Math.min'));assert.equal(a.status,'pending');
 await f.workflows.control(w.id,'pause');await f.workflows.close();await f.workflows.init();const paused=await f.workflows.read(w.id);assert.equal(paused.repairPlan.repairs[0].expressionCheck.currentSource,false);assert.equal(paused.repairPlan.repairs[0].expressionCheck.matched,1);
 await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/Resume/);await f.workflows.control(w.id,'resume');await f.actions.decide(a.id,'approve',a.digest);await f.wait(w.id,'waiting_input');assert.equal(await readFile(f.file,'utf8'),a.payload.content);assert.equal((await f.store.list('actions')).length,1);
});
test('focused project follows saved progress through an argument correction and finishes after one check',async t=>{
 const f=await fixture(t),p=await f.projectWorkspaces.save({name:'Fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Check',program:'node',args:['--version'],cwd:f.folder,outputIncludes:'v'}]});let n=0,commandEvidence;
 const encodedRepairs=JSON.stringify([{file:f.file,line:1,before:'before',after:'after',reason:'Correct the fixture.'}]);
 f.setReply((c,tools)=>{
  const progress=c.projectProgress;
  if(++n===1)return call(progress.next.tool,progress.next.arguments);
  if(n===2){assert.equal(progress.files[0].path,f.file);return call('record_repair_plan',{repairs:encodedRepairs});}
  if(n===3){assert.equal(progress.phase,'repair');return call(progress.next.tool,progress.next.arguments);}
  if(n===4){assert.equal(progress.phase,'check');return call(progress.next.tool,progress.next.arguments);}
  if(n===5){assert.equal(progress.phase,'verify');commandEvidence=progress.next.arguments.evidence;return call('verify_outcome',{...progress.next.arguments,expected:'An invented marker'});}
  if(n===6){assert.equal(progress.phase,'verify');assert.equal(progress.next.arguments.evidence,commandEvidence);return call(progress.next.tool,progress.next.arguments);}
  if(n===7){assert.equal(progress.phase,'read');return call(progress.next.tool,progress.next.arguments);}
  assert.equal(progress.readyToFinish,true);assert(!tools.some(t=>['propose_check','read_system_file','verify_outcome'].includes(t.function.name)));return call('finish_step',{summary:'Saved the exact correction and verified the check and file.',evidence:progress.finishEvidence});
 });
 const w=await f.start({projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check'],requirements:{files:[{path:f.file,lineEndings:'lf',finalNewline:'required'}],commands:[]}});
 await f.approve(w.id);await f.approve(w.id);const result=await f.wait(w.id,'completed');assert.equal(n,8);assert.equal(await readFile(f.file,'utf8'),'after\n');assert.equal((await f.store.list('actions')).length,2);assert.equal(result.operations.filter(o=>o.status==='failed').length,1);assert.equal(result.projectProgress.readyToFinish,true);
 const savedPlan=result.operations.find(o=>o.name==='record_repair_plan'&&o.status==='completed');assert.equal(savedPlan.arguments.repairs,encodedRepairs);assert.equal(savedPlan.result.inputEncoding,'json_string');
});
test('file-bound repair feedback preserves source-matched siblings and exact approvals across restart',async t=>{
 const f=await fixture(t);await writeFile(f.file,'first bad\nsecond bad\n');
 const p=await f.projectWorkspaces.save({name:'Fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Check',program:'node',args:['--version'],cwd:f.folder,outputIncludes:'v'}]});let n=0;
 const items=[{file:f.file,line:1,before:'first bad',after:'first good',reason:'Correct first line'},{file:f.file,line:2,before:'second bad',after:'second good',reason:'Correct second line'}];
 f.setReply((c,_tools,m)=>{
  if(++n===1)return call('read_system_file',{path:f.file});
  if(n===2)return call('record_repair_plan',{repairs:[items[0],{...items[1],after:'second good\nextra'}]});
  if(n===3){const result=JSON.parse(m.find(x=>x.role==='tool'&&x.tool_name==='record_repair_plan').content).result;assert.deepEqual(result.repairFeedback.matchedItems,[1]);assert.equal(result.repairFeedback.issues[0].field,'after');assert.equal(c.repairPlan,null);assert.equal(c.projectProgress.phase,'repair');return call('record_repair_plan',{repairs:items});}
  if(n===4)return call('propose_repair',{repair:c.repairPlan.repairs[0].id});
  if(n===5)return call('read_system_file',{path:f.file});
  if(n===6){assert.equal(c.completedEdits.length,1);assert.equal(c.repairPlan.repairs.length,1);return call('propose_repair',{repair:c.repairPlan.repairs[0].id});}
  return call('ask_user',{question:'Inspect both saved corrections.'});
 });
 const w=await f.start({projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check'],requirements:{files:[{path:f.file,lineEndings:'lf',finalNewline:'required'}],commands:[]}});
 const first=await f.approve(w.id),pending=await until(async()=>{const x=await f.workflows.read(w.id);return x.status==='waiting_approval'&&!f.workflows.running.has(w.id)&&x.operations.at(-1).action!==first.id?x:null;}),a=await f.store.get('actions',pending.operations.at(-1).action);assert.equal(await readFile(f.file,'utf8'),'first good\nsecond bad\n');assert.equal(pending.repairFeedback,null);assert.equal(a.payload.content,'first good\nsecond good\n');
 await f.workflows.control(w.id,'pause');await f.workflows.close();await f.workflows.init();assert.deepEqual(await f.store.get('actions',a.id),a);await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/Resume/);await f.workflows.control(w.id,'resume');await f.actions.decide(a.id,'approve',a.digest);await f.wait(w.id,'waiting_input');assert.equal(await readFile(f.file,'utf8'),'first good\nsecond good\n');assert.equal((await f.store.list('actions')).length,2);
});
test('expression argument feedback survives restart and a corrected example still needs exact approval',async t=>{
 const f=await fixture(t),before='const width=Math.max(a,b);\n';await writeFile(f.file,before);
 const p=await f.projectWorkspaces.save({name:'Fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Check',program:'node',args:['--version'],cwd:f.folder,outputIncludes:'v'}]});let n=0,feedbackReady=false;
 f.setReply((c,_tools,m,signal)=>{
  if(++n===1)return call('read_system_file',{path:f.file});
  if(n===2)return call('record_repair_plan',{repairs:[{file:f.file,line:1,before:'Math.max(a,b)',after:'Math.min(a,b)',reason:'Bound width'}]});
  const repair=c.repairPlan.repairs[0];
  if(n===3)return call('check_repair_expression',{repair:repair.id,cases:[{inputs:{a:700,b:1280},expected:{width:700}}]});
  if(n===4){const r=JSON.parse(m.find(x=>x.tool_name==='check_repair_expression').content).result;assert.equal(r.expressionFeedback.field,'cases[0].expected');assert.equal(repair.expressionCheck,null);feedbackReady=true;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
  if(n===5){assert.equal(repair.expressionFeedback.currentSource,false);return call('read_system_file',{path:f.file});}
  if(n===6)return call('check_repair_expression',{repair:repair.id,cases:[{inputs:{a:700,b:1280},expected:700}]});
  if(n===7){assert.equal(repair.expressionFeedback,null);assert.equal(repair.expressionCheck.hasFailedExamples,false);return call('propose_repair',{repair:repair.id});}
  return call('ask_user',{question:'Fixture correction saved through exact approval.'});
 });
 const w=await f.start({projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check'],requirements:{files:[{path:f.file,lineEndings:'lf',finalNewline:'required'}],commands:[]}});await until(()=>feedbackReady);const first=await f.workflows.read(w.id);
 assert.equal(first.repairPlan.repairs[0].expressionFeedback.currentSource,true);assert.equal((await f.store.list('actions')).length,0);
 await f.workflows.control(w.id,'pause');await f.workflows.close();await f.workflows.init();assert.equal((await f.workflows.read(w.id)).repairPlan.repairs[0].expressionFeedback.currentSource,false);
 await f.workflows.control(w.id,'resume');const pending=await f.wait(w.id,'waiting_approval');assert.equal(await readFile(f.file,'utf8'),before);assert.equal(pending.operations.filter(o=>o.name==='record_repair_plan').length,1);
 const action=await f.approve(w.id);await f.wait(w.id,'waiting_input');assert.equal(await readFile(f.file,'utf8'),before.replace('Math.max','Math.min'));assert.equal((await f.store.list('actions')).length,1);assert.equal(action.payload.content,before.replace('Math.max','Math.min'));
});
test('only an ordinary failed selected check can trigger bounded diagnostic recovery',()=>{
 const c={program:'/usr/bin/node',args:['--test','a.mjs'],cwd:'/tmp/p'},op={id:'failure',command:c},w={version:4,revision:1,project:{checks:[c]},requirements:{commands:[c],files:[{path:'/tmp/p/a.mjs'}]},operations:[op]},a={kind:'command',status:'failed',workflow:{revision:1},payload:c,result:{code:1,content:'assertion failed'}};
 assert(diagnosticCheck(w,op,a));
 for(const result of [{code:0},{code:null},{signal:'SIGTERM'},{stopped:true},{truncated:true},{error:'unknown'},{content:''}])assert.equal(diagnosticCheck(w,op,{...a,result:{...a.result,...result}}),null);
 for(const change of [{version:3},{revision:2},{project:{checks:[]}},{requirements:{commands:[],files:[]}}])assert.equal(diagnosticCheck({...w,...change},op,a),null);
 assert.equal(diagnosticCheck(w,op,{...a,payload:{...c,args:['--help']}}),null);
 w.checkRecoveries=[diagnosticCheck(w,op,a)];assert.deepEqual(recoveryReads(w),['/tmp/p/a.mjs']);w.operations.push(observed('fresh','/tmp/p/a.mjs'));assert.deepEqual(recoveryReads(w),[]);
});
test('saved checks return to project tools across approval/restart on both pass and failure',async t=>{
 for(const expected of [1,2]){
  const f=await fixture(t);await writeFile(join(f.folder,'check.test.mjs'),`import assert from 'node:assert/strict';\nassert.equal(1,${expected});\n`);
  const p=await f.projectWorkspaces.save({name:'Check menu fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Check',program:'node',args:['--test','check.test.mjs'],cwd:f.folder,outputIncludes:'pass 1'}]});let n=0;
  f.setReply((c,tools)=>{
   if(++n===1)return call('select_project_tools',{group:'files'});
   if(n===2){assert.equal(c.toolGroup,'files');return call('propose_check',{check:'C1',reason:'Run the selected project check.'});}
   assert.equal(c.toolGroup,'project');assert(!tools.some(t=>t.function.name==='propose_file_patch'));assert(tools.some(t=>t.function.name==='select_project_tools'));if(expected===2)assert(c.diagnosticCheck);
   return call('ask_user',{question:'The exact selected check is recorded.'});
  });
  const w=await f.start({projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check'],requirements:{files:[{path:f.file,lineEndings:'lf',finalNewline:'required'}],commands:[]}}),pending=await f.wait(w.id,'waiting_approval'),action=await f.store.get('actions',pending.operations.at(-1).action);
  assert.equal(pending.projectToolGroup,'project');assert.equal(action.status,'pending');assert.equal(await readFile(f.file,'utf8'),'before\n');
  await f.workflows.control(w.id,'pause');await f.workflows.close();await f.workflows.init();assert.deepEqual(await f.store.get('actions',action.id),action);assert.deepEqual((await f.workflows.read(w.id)).requirements,pending.requirements);
  await assert.rejects(f.actions.decide(action.id,'approve',action.digest),/Resume/);await f.workflows.control(w.id,'resume');await f.actions.decide(action.id,'approve',action.digest);await f.wait(w.id,'waiting_input');
  const actions=await f.store.list('actions');assert.equal(actions.length,1);assert.equal(actions[0].status,expected===1?'completed':'failed');assert.equal(await readFile(f.file,'utf8'),'before\n');
 }
});
test('bounded diagnostics retain beginning and end with an explicit gap and leave the complete record intact',()=>{
 const short='First failure\nLast failure';assert.equal(diagnosticExcerpt(short),short);
 const output='FIRST expected width 700\n'+'stack detail\n'.repeat(800)+'LAST expected width 320';
 for(const limit of [2000,6000]){const view=diagnosticExcerpt(output,limit);assert.equal(view.length,limit);assert(view.startsWith('FIRST expected width 700'));assert(view.endsWith('LAST expected width 320'));assert.match(view,/middle omitted; full check output remains/);}
 const c={program:'/usr/bin/node',args:['--test','a.mjs'],cwd:'/tmp/p'},op={id:'failure',command:c},w={version:6,revision:1,project:{checks:[c]},requirements:{commands:[c],files:[{path:'/tmp/p/a.mjs'}]},operations:[op]},a={kind:'command',status:'failed',workflow:{revision:1},payload:c,result:{code:1,content:output}};
 const saved=diagnosticCheck(w,op,a);assert(saved.outputTruncated);assert(saved.output.endsWith('LAST expected width 320'));assert.equal(a.result.content,output);
});
for(const malformed of ['{"argv":','null','[]'])test('malformed arguments are journaled and can be corrected: '+malformed,async t=>{
 const f=await fixture(t);f.setReply((c,_tools,m)=>{assert(m.filter(x=>x.role==='assistant').every(x=>x.tool_calls[0].function.arguments&&typeof x.tool_calls[0].function.arguments==='object'&&!Array.isArray(x.tool_calls[0].function.arguments)));return !c.recentEvidence.length?call('propose_command',malformed):c.evidenceForCompletion.length?call('finish_step',{summary:'Observed the source; no command executed.',evidence:['E2']}):call('read_system_file',{path:f.file});});
 const w=await f.start(),done=await f.wait(w.id,'completed');assert.equal(done.operations[0].status,'failed');assert.equal(done.operations[0].result.expectedArguments.fields.args.type,'array');assert.equal((await f.store.list('actions')).length,0);
});
test('output limits get one persisted generation-only retry, retain usage, then pause across restart',async t=>{
 const f=await fixture(t);let calls=0;f.setReply(()=>{calls++;throw Object.assign(Error('The model reached its output limit'),{code:'model_output_limit',metrics:{tokens:6144,promptTokens:5000}});});
 const w=await f.start(),paused=await f.wait(w.id,'paused');assert.equal(calls,2);assert.equal(paused.focusedReasoning,true);assert.equal(paused.generationFailures.length,2);assert.equal(paused.pauseReason.kind,'model_output_limit');assert.equal(paused.localUsage.filter(u=>u.stage==='incomplete step').length,2);assert.equal(paused.operations.length,0);
 await f.workflows.close();await f.workflows.init();await f.workflows.control(w.id,'resume');const again=await f.wait(w.id,'paused');assert.equal(calls,3);assert.equal(again.generationFailures.length,3);assert.equal((await f.store.list('actions')).length,0);
});
test('one malformed local tool reply retries generation without executing a partial call',async t=>{
 const f=await fixture(t);let calls=0;
 f.setReply(()=>++calls===1?Promise.reject(Object.assign(Error('XML syntax error on line 5'),{code:'model_tool_parse_error'})):call('ask_user',{question:'Review the fixture.'}));
 const w=await f.start(),waiting=await f.wait(w.id,'waiting_input');assert.equal(calls,2);assert.equal(waiting.toolFormatFailures.length,1);assert.equal(waiting.toolFormatFailures[0].call,2);assert.equal(waiting.operations.length,1);assert.equal(waiting.operations[0].name,'ask_user');assert.equal((await f.store.list('actions')).length,0);
 const review=await f.workflows.changes(w.id);assert.equal(review.toolFormatFailures.length,1);
});
test('repeated malformed local tool replies pause and retain the retry limit across restart',async t=>{
 const f=await fixture(t);let calls=0;f.setReply(()=>{calls++;throw Object.assign(Error('XML syntax error on line 5'),{code:'model_tool_parse_error'});});
 const w=await f.start(),paused=await f.wait(w.id,'paused');assert.equal(calls,2);assert.equal(paused.toolFormatFailures.length,2);assert.equal(paused.pauseReason.kind,'model_tool_parse_error');assert.equal(paused.operations.length,0);
 await f.workflows.close();await f.workflows.init();await f.workflows.control(w.id,'resume');const again=await f.wait(w.id,'paused');assert.equal(calls,3);assert.equal(again.toolFormatFailures.length,3);assert.equal(again.operations.length,0);assert.equal((await f.store.list('actions')).length,0);
});
test('failed saved check requires fresh observations and exact approvals before repair and success',async t=>{
 const f=await fixture(t);await writeFile(join(f.folder,'check.mjs'),"import {readFileSync} from 'node:fs';process.exitCode=readFileSync('one.txt','utf8')==='after\\n'?0:1;console.log(process.exitCode?'wrong content':'pass fixture');\n");
 const p=await f.projectWorkspaces.save({name:'Fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Check',program:'node',args:['check.mjs'],cwd:f.folder,outputIncludes:'pass fixture'}]});let n=0;
 f.setReply(c=>{
  n++;if(n===1)return call('read_system_file',{path:f.file});if(n===2)return call('propose_check',{check:'C1',reason:'Check current file'});
  if(n===3){assert.equal(c.diagnosticCheck.readsNeeded.length,1);return call('propose_line_edit',{evidence:'E1',line:1,text:'after',reason:'Must first reread'});}
  if(n===4)return call('read_system_file',{path:f.file});if(n===5)return call('propose_line_edit',{evidence:'E4',line:1,text:'after',reason:'Fix observed mismatch'});
  if(n===6){assert.equal(c.diagnosticCheck.state,'run_fresh_check');assert.equal(c.diagnosticCheck.output,undefined);return call('propose_check',{check:'C1',reason:'Check corrected file'});}if(n===7){assert.equal(c.diagnosticCheck.state,'passed');assert.equal(c.diagnosticCheck.output,undefined);return call('verify_outcome',{evidence:'E6',kind:'command_output',expected:'pass fixture'});}
  if(n===8)return call('read_system_file',{path:f.file});return call('finish_step',{summary:'Corrected file and check passed.',evidence:['E7','E8']});
 });
 const w=await f.start({projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check'],requirements:{files:[{path:f.file,lineEndings:'lf',finalNewline:'required'}],commands:[]}});
 await f.approve(w.id);await f.approve(w.id);await f.approve(w.id);const done=await f.wait(w.id,'completed');
 assert.equal(done.checkRecoveries.length,1);assert.match(done.operations[2].result.error,/Inspect these files/);assert.equal(done.operations[2].action,undefined);assert(done.requirementChecks.every(c=>c.passed));assert.equal(await readFile(f.file,'utf8'),'after\n');assert.equal((await f.store.list('actions')).length,3);
 const review=await f.workflows.changes(w.id);assert.match(review.files[0].observation.diff,/- before\n\+ after/);assert.equal(review.files[0].observation.changedSinceLastEdit,false);
 await writeFile(f.file,'external change\n');const newer=await f.workflows.changes(w.id);assert.equal(newer.files[0].observation.changedSinceLastEdit,true);assert.equal((await f.workflows.read(w.id)).operations.length,done.operations.length,'review is not task evidence');
});
test('three failed selected checks pause for help without a fourth command',async t=>{
 const f=await fixture(t);const p=await f.projectWorkspaces.save({name:'Fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Fail',program:'node',args:['-e','console.log("failed");process.exit(1)'],cwd:f.folder,outputIncludes:'passed'}]});
 f.setReply(c=>!c.recentEvidence.length||c.diagnosticCheck?.readsNeeded.length?call('read_system_file',{path:f.file}):call('propose_check',{check:'C1',reason:'Check current state'}));
 const w=await f.start({projectId:p.id,projectRevision:p.revision,projectCheckNames:['Fail']});await f.approve(w.id);await f.approve(w.id);await f.approve(w.id);const stopped=await f.wait(w.id,'needs_help');assert.equal(stopped.checkRecoveries.length,3);assert.equal((await f.store.list('actions')).length,3);assert.match(stopped.error,/Three saved checks/);
});
test('change review identifies stale pending edits and reports missing files without changing approvals',async t=>{
 const f=await fixture(t);f.setReply(()=>call('propose_file_edit',{path:f.file,content:'after\n',reason:'Fixture edit'}));const w=await f.start();await f.wait(w.id,'waiting_approval');
 await writeFile(f.file,'external\n');let review=await f.workflows.changes(w.id);assert.equal(review.files[0].pending[0].stale,true);assert.equal(review.files[0].observation.changedSinceLastEdit,null);
 await rm(f.file);review=await f.workflows.changes(w.id);assert.equal(review.files[0].pending[0].stale,null);assert.match(review.files[0].observation.error,/not found/);assert.equal((await f.store.list('actions'))[0].status,'pending');
 await new Promise(r=>f.server.listen(0,'127.0.0.1',r));const r=await fetch('http://127.0.0.1:'+f.server.address().port+'/api/workflow-changes?id='+w.id);assert.equal(r.status,200);assert.equal((await r.json()).id,w.id);
});

test('a failed check reconciled while pausing remains paused across restart and blocks stale approval paths',async t=>{
 const f=await fixture(t);clearInterval(f.workflows.timer);f.workflows.pollMs=60000;
 const p=await f.projectWorkspaces.save({name:'Fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Fail',program:'node',args:['-e','console.log("failure");process.exit(1)'],cwd:f.folder,outputIncludes:'passed'}]});let n=0;
 f.setReply(()=>++n===1?call('read_system_file',{path:f.file}):n===2?call('propose_check',{check:'C1',reason:'Inspect check'}):call('ask_user',{question:'Review the failure.'}));
 const w=await f.start({projectId:p.id,projectRevision:p.revision,projectCheckNames:['Fail']});await f.approve(w.id);await until(async()=>(await f.store.list('actions'))[0].status==='failed');await f.workflows.control(w.id,'pause');
 let paused=await f.workflows.read(w.id);assert.equal(paused.status,'paused');assert.equal(paused.checkRecoveries.length,1);assert.equal(n,2);
 await f.workflows.close();await f.workflows.init();paused=await f.workflows.read(w.id);assert.equal(paused.status,'paused');assert.equal(paused.checkRecoveries.length,1);assert.equal(n,2);
 await assert.rejects(f.actions.propose('write',{path:f.file,content:'after\n',reason:'Stale state'},null,null,{id:w.id,revision:1}),/Inspect these files/);
 const command=(await f.store.list('actions'))[0];await assert.rejects(f.actions.workflowGuard({...command,kind:'write',payload:{path:f.file,content:'after\n'}}),/Inspect these files/);
 assert.equal((await f.store.list('actions')).length,1);
});

test('repeated unchanged reads pause without consuming the task budget; new state and reviewed continuation reset the window',async t=>{
 const f=await fixture(t);f.setReply(()=>call('read_system_file',{path:f.file}));const w=await f.start(),paused=await f.wait(w.id,'needs_help');assert.equal(paused.operations.length,6);assert.match(paused.error,/Five repeated file observations/);assert.equal((await f.store.list('actions')).length,0);
 assert.equal(repeatedObservations({...paused,operations:[...paused.operations,observed('changed',f.file)]}),false);
 assert.equal(repeatedObservations({...paused,operations:[...paused.operations,{id:'effect',action:'reviewed',status:'completed'}]}),false);
 f.setReply(c=>call('finish_step',{summary:'Current file observed.',evidence:[c.evidenceForCompletion.at(-1).id]}));await f.workflows.control(w.id,'resume');assert.equal((await f.wait(w.id,'completed')).calls,paused.calls+1);
});

test('selected project checks constrain planning to one outcome; invalid plans cannot reach approval',async t=>{
 const f=await fixture(t),base=f.assistant.ollama.chat,limits=[];
 f.assistant.ollama.chat=async(...args)=>{if(args[4]?.format?.properties.steps){limits.push(args[4].format.properties.steps.maxItems);return {content:JSON.stringify({steps:[{title:'Inspect',check:'Read the file'},{title:'Fix',check:'Verify the result'}]})};}return base(...args);};
 const p=await f.projectWorkspaces.save({name:'Fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Check',program:'node',args:['--version'],cwd:f.folder,outputIncludes:'v'}]});
 const w=await f.workflows.start({goal:'Verify this project',projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check']});const failed=await f.wait(w.id,'needs_help');assert.match(failed.error,/one outcome step/);assert.equal(failed.operations.length,0);assert.equal((await f.store.list('actions')).length,0);
 const ordinary=await f.start();assert.equal((await f.wait(ordinary.id,'waiting_input')).steps.length,2);assert.deepEqual(limits,[1,4]);
});

test('reviewed examples persist across restart and still require exact write, saved test and final readback',async t=>{
 const f=await fixture(t),source='const w=720,left=10,right=10;\nexport const width=w+left+right;\n';await writeFile(f.file,source);
 const check=join(f.folder,'check.mjs');await writeFile(check,"import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';assert(readFileSync('one.txt','utf8').includes('width=w-left-right'));console.log('example repair passed');\n");
 const p=await f.projectWorkspaces.save({name:'Review fixture',notePath:'20 Projects/Example Project.md',folders:[f.folder],checks:[{name:'Check',program:'node',args:['check.mjs'],cwd:f.folder,outputIncludes:'example repair passed'}]});let n=0;
 f.setReply(c=>{
  n++;
  if(n===1||n===6||n===10)return call('read_system_file',{path:f.file});
  if(n===2)return call('record_repair_plan',{repairs:[{file:f.file,line:2,before:'w+left+right',after:'w-left-right',reason:'Subtract margins'}]});
  if(n===3||n===4)return call('check_repair_expression',{repair:c.repairPlan.repairs[0].id,cases:[{inputs:{w:n===3?1280:720,left:10,right:10},expected:700}]});
  if(n===5)return call('request_help',{reason:'Example uses the wrong width.',question:'Review the logical width example.'});
  if(n===7)return call('propose_repair',{repair:c.repairPlan.repairs[0].id});
  if(n===8)return call('propose_check',{check:'C1',reason:'Test the actual file'});
  if(n===9)return call('verify_outcome',{kind:'command_output',expected:'example repair passed',evidence:c.outcomeChecksNeeded.find(x=>x.group==='command').availableObservation.evidence});
  return call('finish_step',{summary:'Saved and tested the correction.',evidence:c.evidenceForCompletion.map(o=>o.id)});
 });
 const w=await f.start({goal:'720 minus 10 on each side gives 700. Repair and run the saved check.',projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check'],requirements:{files:[{path:f.file,lineEndings:'lf',finalNewline:'required'}],commands:[]}}),paused=await f.wait(w.id,'needs_help'),r=paused.repairPlan.repairs[0],entry=r.exampleLedger.cases[0];
 const input={operation:'preview',revision:1,repair:r.id,caseId:entry.id,inputs:{w:720,left:10,right:10},expected:700,reason:'The goal uses logical width 720.',provenance:{kind:'goal',quote:'720 minus 10 on each side gives 700'}};
 const preview=await f.workflows.exampleReview(w.id,input);await f.workflows.exampleReview(w.id,{...input,operation:'apply',token:preview.token});assert.equal(n,5);assert.equal(await readFile(f.file,'utf8'),source);assert.equal((await f.store.list('actions')).length,0);
 await f.workflows.close();await f.workflows.init();const restored=await f.workflows.read(w.id);assert.equal(restored.repairPlan.repairs[0].exampleLedger.failed,0);assert.equal(restored.repairPlan.repairs[0].exampleLedger.cases[0].original.matches,false);assert.equal(n,5);
 await f.workflows.control(w.id,'resume');const pending=await f.wait(w.id,'waiting_approval');assert.equal(await readFile(f.file,'utf8'),source);assert(pending.operations.some(o=>o.name==='review_repair_example'&&o.actor==='user'));
 await f.approve(w.id);await f.approve(w.id);const done=await f.wait(w.id,'completed');assert.equal(await readFile(f.file,'utf8'),source.replace('w+left+right','w-left-right'));assert.equal((await f.store.list('actions')).length,2);assert(done.operations.some(o=>o.name==='propose_command'&&o.result.code===0));assert(done.requirementChecks.every(c=>c.passed));assert.equal(done.operations.filter(o=>o.name==='review_repair_example').length,1);
});
