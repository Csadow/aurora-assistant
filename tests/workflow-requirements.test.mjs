import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {sha} from '../src/vault.mjs';
import {prepareRequirements,proposalRequirements,textMismatches,requirementStatus} from '../src/workflow-requirements.mjs';

const call=(name,args)=>({content:'',tool_calls:[{function:{name,arguments:args}}]});
const until=async fn=>{const end=Date.now()+6000;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('Requirement fixture timed out');};
const rule=path=>({path,exactText:'after\n',finalNewline:'required',lineEndings:'lf'});
async function fixture(t,respond){
  const dir=await mkdtemp(join(tmpdir(),'aurora-requirements-')),project=join(dir,'project');await mkdir(project);const path=join(project,'note.txt');await writeFile(path,'before');
  const model={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,_t,signal,_c,options)=>{signal.throwIfAborted();return options?.format?.properties.steps?{content:JSON.stringify({steps:[{title:'Produce the required output',check:'Read exact text and verify required checks.'}]})}:respond(JSON.parse(m.at(-1).content),{path,project});}};
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),embedding:'',projects:[],ollamaClient:model,workflowOptions:{pollMs:10,segmentMs:10000}});
  t.after(async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
  const wait=(id,status)=>until(async()=>{const w=await app.workflows.read(id);return w.status===status&&!app.workflows.running.has(id)?w:null;});
  const plan=async input=>{const w=await app.workflows.start({goal:'Produce the required output',...input});const ready=await wait(w.id,'plan_review');assert.equal(ready.operations.length,0);await app.workflows.control(w.id,'approve_plan','',ready.revision);return w;};
  const pending=async id=>until(async()=>{const w=await app.workflows.read(id);if(w.status!=='waiting_approval'||app.workflows.running.has(id))return null;return (await app.store.list('actions')).find(a=>a.workflow?.id===id&&a.status==='pending');});
  const approve=async id=>{const a=await pending(id);await app.actions.decide(a.id,'approve',a.digest);return a;};
  return Object.assign(app,{dir,project,path,wait,plan,pending,approve});
}

test('exact UTF-8 text, LF/CRLF, final newline, empty text and contradictions are checked literally',async t=>{
  assert.equal(textMismatches(rule('/x'),'after\n').length,0);assert.match(textMismatches(rule('/x'),'after').join(' '),/Missing required final newline/);
  assert.match(textMismatches({...rule('/x'),exactText:'é\n'},'e\n')[0],/byte 1.*3 bytes.*2/);
  assert(textMismatches({...rule('/x'),exactText:'after\r\n'},'after\r\n').some(x=>x.includes('carriage')));
  const crlf={finalNewline:'required',lineEndings:'crlf'};assert.deepEqual(textMismatches(crlf,'a\r\nb\r\n'),[]);assert(textMismatches(crlf,'a\nb\r\n').length);assert(textMismatches(crlf,'a\r\nb\r').length);
  assert.deepEqual(textMismatches({exactText:'',finalNewline:'forbidden',lineEndings:'lf'},''),[]);
  const f=await fixture(t,()=>{});
  await assert.rejects(prepareRequirements({files:[{...rule(f.path),exactText:'after'}],commands:[]},f.system),/contradicts/);
  for(const input of [null,[],{files:[],commands:[],extra:1},{files:Array(5).fill(rule(f.path)),commands:[]},{files:[{...rule(f.path),exactText:'x'.repeat(4001)}],commands:[]},{files:[],commands:[{program:'node',args:[],cwd:f.project,outputIncludes:''}]}])await assert.rejects(prepareRequirements(input,f.system));
});

test('targets are canonical, duplicate aliases rejected, and proposal conditions cannot be bypassed by a different path or command',async t=>{
  const f=await fixture(t,()=>{}),alias=join(f.project,'alias.txt');await symlink(f.path,alias);
  const requirements=await prepareRequirements({files:[rule(alias)],commands:[{program:'node',args:['--version'],cwd:f.project,outputIncludes:'v'}]},f.system);
  assert.equal(requirements.files[0].path,f.path);const w={requirements,revision:1};
  await assert.rejects(prepareRequirements({files:[rule(alias),rule(f.path)],commands:[]},f.system),/only once/);
  assert.throws(()=>proposalRequirements(w,'write',{path:join(f.project,'other'),content:'after\n'}),/allowed output/);
  assert.throws(()=>proposalRequirements(w,'write',{path:f.path,content:'after'}),/Missing required final newline/);
  const c=requirements.commands[0];assert(proposalRequirements(w,'command',c).checks.length);assert.throws(()=>proposalRequirements(w,'command',{...c,args:['--version','--help']}),/exactly match/);
  assert.equal(proposalRequirements(w,'computer',{operation:'open_app'}),null);
});

test('missing newline is rejected without an action; the corrected bytes alone reach approval',async t=>{
  const f=await fixture(t,c=>{const ops=c.recentEvidence.map(JSON.parse),last=ops.at(-1);if(!last)return call('propose_file_edit',{path:c.outputRequirements.files[0].path,content:'after',reason:'Omitted newline fixture'});if(last.status==='failed')return call('propose_file_edit',{path:c.outputRequirements.files[0].path,content:'after\n',reason:'Corrected bytes'});if(last.name==='propose_file_edit')return call('read_system_file',{path:c.outputRequirements.files[0].path});return call('finish_step',{summary:'Exact output observed.',evidence:c.evidenceForCompletion.map(o=>o.id)});});
  const w=await f.plan({requirements:{files:[rule(f.path)],commands:[]}}),a=await f.pending(w.id),waiting=await f.workflows.read(w.id);
  assert.equal((await f.store.list('actions')).length,1);assert.equal(await readFile(f.path,'utf8'),'before');assert.equal(waiting.operations[0].status,'failed');assert(!waiting.operations[0].action);assert(waiting.operations[0].result.requirementFailures.length);assert.equal(a.payload.content,'after\n');assert(a.payload.requirementsCheck.checks.includes('Exact text matches'));
  await f.actions.decide(a.id,'approve',a.digest);const done=await f.wait(w.id,'completed');assert(done.requirementChecks.every(x=>x.passed));assert.equal(await readFile(f.path,'utf8'),'after\n');
});

test('the model can explicitly stage saved exact text without regenerating it; generated mismatches remain rejected',async t=>{
  const f=await fixture(t,c=>call('propose_required_file',{path:c.outputRequirements.files[0].path,reason:'Stage the saved exact user text'}));
  const w=await f.plan({requirements:{files:[rule(f.path)],commands:[]}}),a=await f.pending(w.id);assert.equal(a.payload.content,'after\n');assert.equal((await f.workflows.read(w.id)).operations[0].contentSource,'saved exact-text requirement');assert.deepEqual((await f.workflows.read(w.id)).operations[0].requestedArguments,{path:f.path,reason:'Stage the saved exact user text'});assert.equal(await readFile(f.path,'utf8'),'before');
  await f.actions.decide(a.id,'approve',a.digest);await until(()=>!f.actions.running.size);await f.workflows.control(w.id,'pause');assert.equal(await readFile(f.path,'utf8'),'after\n');
  assert.throws(()=>proposalRequirements(w,'write',{path:f.path,content:'after'}),/Missing required final newline/);
  const withoutExact={...rule(f.path)};delete withoutExact.exactText;const other=await f.plan({requirements:{files:[withoutExact],commands:[]}});const stopped=await f.wait(other.id,'needs_help');assert(stopped.operations.every(o=>!o.action));assert.equal((await f.store.list('actions')).length,1);
});

test('repeated bad proposals pause for help without creating approvals or changing files',async t=>{
  const f=await fixture(t,c=>call('propose_file_edit',{path:c.outputRequirements.files[0].path,content:'after'}));const w=await f.plan({requirements:{files:[rule(f.path)],commands:[]}});const stopped=await f.wait(w.id,'needs_help');assert.equal(stopped.operations.filter(o=>o.result?.requirementFailures).length,3);assert.equal((await f.store.list('actions')).length,0);assert.equal(await readFile(f.path,'utf8'),'before');
});

test('saved-text staging rejects supplied content instead of silently replacing it',async t=>{
  const f=await fixture(t,c=>call('propose_required_file',{path:c.outputRequirements.files[0].path,content:'different generated text',reason:'Invalid saved-text request'}));
  const w=await f.plan({requirements:{files:[rule(f.path)],commands:[]}}),stopped=await f.wait(w.id,'needs_help');
  assert.equal(stopped.operations.length,3);assert(stopped.operations.every(o=>o.status==='failed'&&!o.action&&/Omit content/.test(o.result.error)));assert.equal((await f.store.list('actions')).length,0);assert.equal(await readFile(f.path,'utf8'),'before');
});

test('interleaved reads cannot reset the repeated requirement failure limit',async t=>{
  const f=await fixture(t,c=>{const last=c.recentEvidence.map(JSON.parse).at(-1),path=c.outputRequirements.files[0].path;return last?.result?.requirementFailures?call('read_system_file',{path}):call('propose_file_edit',{path,content:'after'});});
  const w=await f.plan({requirements:{files:[rule(f.path)],commands:[]}}),stopped=await f.wait(w.id,'needs_help');assert.equal(stopped.operations.filter(o=>o.result?.requirementFailures).length,3);assert.match(stopped.error,/Three proposals/);assert.equal((await f.store.list('actions')).length,0);assert.equal(await readFile(f.path,'utf8'),'before');
  await f.workflows.control(w.id,'resume');const retried=await f.wait(w.id,'needs_help');assert.equal(retried.operations.filter(o=>o.result?.requirementFailures).length,6);assert(retried.calls>stopped.calls);assert.equal((await f.store.list('actions')).length,0);
});

test('required command uses exact arguments, real output, and a fresh file read after execution',async t=>{
  const f=await fixture(t,c=>{const ops=c.recentEvidence.map(JSON.parse),last=ops.at(-1),file=c.outputRequirements.files[0].path,cmd=c.outputRequirements.commands[0];
    if(!last)return call('propose_file_edit',{path:file,content:'after\n'});
    if(last.name==='propose_file_edit')return call('read_system_file',{path:file});
    if(last.name==='read_system_file'&&!ops.some(o=>o.name==='propose_command'))return call('propose_command',{...cmd,args:['wrong']});
    if(last.name==='propose_command'&&last.status==='failed')return call('propose_command',cmd);
    if(last.name==='propose_command')return call('verify_outcome',{evidence:last.id,kind:'command_output',expected:'CHECK PASSED'});
    if(last.name==='finish_step'&&last.status==='failed'){assert.match(last.result.error,/Read this output file|Read back/);return call('read_system_file',{path:file});}
    return call('finish_step',{summary:'The check and file contents were observed.',evidence:c.evidenceForCompletion.map(o=>o.id)});
  });
  const w=await f.plan({requirements:{files:[rule(f.path)],commands:[{program:'printf',args:['CHECK PASSED'],cwd:f.project,outputIncludes:'CHECK PASSED'}]}});await f.approve(w.id);const check=await f.approve(w.id);assert.equal(check.kind,'command');const done=await f.wait(w.id,'completed');assert(done.requirementChecks.every(x=>x.passed));assert.equal((await f.store.list('actions')).length,2);assert(done.operations.some(o=>o.name==='finish_step'&&o.status==='failed'));assert.equal(done.operations.filter(o=>o.name==='read_system_file').length,2);
});

test('stale, partial, redacted and failed observations cannot satisfy requirements',()=>{
  const requirements={files:[rule('/x')],commands:[{program:'/usr/bin/node',args:['--test'],cwd:'/p',outputIncludes:'pass 1'}]},read={id:'read',name:'read_system_file',status:'completed',result:{path:'/x',content:'after\n',revision:sha('after\n'),truncated:false}},cmd={id:'cmd',name:'propose_command',action:'a',command:requirements.commands[0],status:'completed',result:{code:0,content:'pass 1'}};
  assert(requirementStatus({requirements,operations:[read,cmd]}).some(x=>!x.passed));assert(requirementStatus({requirements,operations:[cmd,read]}).every(x=>x.passed));
  for(const change of [{truncated:true},{revision:'other'},{content:'after'}])assert.equal(requirementStatus({requirements,operations:[cmd,{...read,result:{...read.result,...change}}]})[0].passed,false);
  for(const change of [{code:1},{truncated:true},{stopped:true},{content:'no tests'}])assert.equal(requirementStatus({requirements,operations:[{...cmd,result:{...cmd.result,...change}},read]})[1].passed,false);
  assert.equal(requirementStatus({requirements,operations:[cmd,read,{...cmd,id:'failed',status:'failed',result:{code:1}}]})[0].passed,false);
});

test('editing requirements retires prior approval, survives restart and requires current plan review',async t=>{
  const f=await fixture(t,c=>call('propose_file_edit',{path:c.outputRequirements.files[0].path,content:c.outputRequirements.files[0].exactText}));
  const w=await f.plan({requirements:{files:[rule(f.path)],commands:[]}}),a=await f.pending(w.id);
  const updated={files:[{...rule(f.path),exactText:'changed\n'}],commands:[]};await f.workflows.updateRequirements(w.id,{revision:1,requirements:updated});await f.wait(w.id,'plan_review');
  assert.equal((await f.store.get('actions',a.id)).status,'dismissed');await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/already/);await assert.rejects(f.workflows.updateRequirements(w.id,{revision:1,requirements:updated}),/plan changed/);
  await f.workflows.close();await f.workflows.init();const restored=await f.workflows.read(w.id);assert.equal(restored.status,'plan_review');assert.equal(restored.requirements.files[0].exactText,'changed\n');assert.equal(restored.planHistory[0].requirements.files[0].exactText,'after\n');await assert.rejects(f.workflows.control(w.id,'approve_plan','',1),/plan changed/);await assert.rejects(f.workflows.control(w.id,'resume'),/Approve plan/);assert.equal(await readFile(f.path,'utf8'),'before');
});

test('requirements are checked again at approval, including metadata covered by the action digest',async t=>{
  const f=await fixture(t,c=>call('propose_file_edit',{path:c.outputRequirements.files[0].path,content:'after\n'}));const w=await f.plan({requirements:{files:[rule(f.path)],commands:[]}}),a=await f.pending(w.id);
  const saved=await f.store.get('workflows',w.id);saved.requirements.files[0].exactText='different\n';await f.workflows.save(saved);await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/Exact text differs/);assert.equal(await readFile(f.path,'utf8'),'before');
  saved.requirements.files[0].exactText='after\n';await f.workflows.save(saved);a.payload.requirementsCheck.checks=['Tampered'];await f.store.put('actions',a);await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/action changed/);
});

test('requirement API requires authentication and malformed conditions create no workflow',async t=>{
  const f=await fixture(t,()=>{});await new Promise(r=>f.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.server.address().port,token=(await(await fetch(base+'/api/bootstrap')).json()).token;
  const post=(path,data,key)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(key?{'X-Aster-Token':key}:{})},body:JSON.stringify(data)});
  assert.equal((await post('/api/workflow-requirements',{})).status,403);assert.equal((await post('/api/workflow-start',{goal:'Bad conditions',requirements:{files:[{...rule(f.path),exactText:'no newline'}],commands:[]}},token)).status,400);assert.equal((await f.store.list('workflows')).length,0);
});

test('formatted drafts apply only saved whitespace rules and preserve all other generated text',async()=>{
 const {formattedFile}=await import('../src/workflow-requirements.mjs');
 const file={path:'/output',finalNewline:'required',lineEndings:'lf'},w={requirements:{files:[file],commands:[]}},input={path:'/output',content:'  α\r\nb \t',reason:'Requested note'};
 assert.equal(formattedFile(w,input).content,'  α\nb \t\n');assert.equal(input.content,'  α\r\nb \t');
 assert.equal(formattedFile({requirements:{files:[{...file,lineEndings:'crlf'}]}},input).content,'  α\r\nb \t\r\n');
 assert.equal(formattedFile({requirements:{files:[{...file,finalNewline:'forbidden',lineEndings:'any'}]}},{...input,content:' a\r\nb \n\n'}).content,' a\r\nb ');
 assert.equal(formattedFile({requirements:{files:[{...file,finalNewline:'any',lineEndings:'any'}]}},input).content,input.content);
 assert.equal(formattedFile(w,{...input,content:''}).content,'\n');
 for(const args of [{...input,path:'/other'},{...input,finalNewline:'forbidden'},{...input,content:null}])assert.throws(()=>formattedFile(w,args));
 assert.throws(()=>formattedFile({requirements:{files:[{...file,exactText:'exact\n'}]}},input),/no exact-text/);
});

test('formatted workflow tool stages normalized bytes for exact review, retains original arguments and does not write before acceptance',async t=>{
 const f=await fixture(t,c=>{const last=c.recentEvidence.map(JSON.parse).at(-1),path=c.outputRequirements.files[0].path;if(!last)return call('propose_formatted_file',{path,content:'Sourced text',reason:'Write the requested note'});if(last.name==='propose_file_edit')return call('read_system_file',{path});return call('finish_step',{summary:'Read the reviewed normalized file.',evidence:c.evidenceForCompletion.map(o=>o.id)});});
 const requirements={files:[{path:f.path,finalNewline:'required',lineEndings:'lf'}],commands:[]},w=await f.plan({requirements});
 const a=await f.pending(w.id),record=await f.workflows.read(w.id);assert.equal(a.payload.content,'Sourced text\n');assert.equal(await readFile(f.path,'utf8'),'before');assert.equal(record.operations[0].requestedTool,'propose_formatted_file');assert.equal(record.operations[0].requestedArguments.content,'Sourced text');assert.equal(record.operations[0].arguments.content,'Sourced text\n');assert(f.workflows.toolsFor(record).some(t=>t.function.name==='propose_formatted_file'));
 await f.actions.decide(a.id,'approve',a.digest);await f.wait(w.id,'completed');assert.equal(await readFile(f.path,'utf8'),'Sourced text\n');
});

test('required snippets are bounded, literal, and checked before approval and after readback',async t=>{
 const f=await fixture(t,()=>{}),r={path:f.path,finalNewline:'required',lineEndings:'lf',requiredText:['[Source](source.md)','Budget is 120.']};
 const requirements=await prepareRequirements({files:[r],commands:[]},f.system),w={requirements,revision:1};
 assert.throws(()=>proposalRequirements(w,'write',{path:f.path,content:'Budget is 120.\n'}),/Missing required text.*Source/);
 const content='Budget is 120. [Source](source.md)\n';assert(proposalRequirements(w,'write',{path:f.path,content}).checks.includes('2 required text snippets present'));
 assert.equal(requirementStatus({...w,operations:[{id:'read',name:'read_system_file',status:'completed',result:{path:f.path,content:'Budget is 120.\n',revision:sha('Budget is 120.\n')}}]})[0].passed,false);
 assert.equal(requirementStatus({...w,operations:[{id:'read',name:'read_system_file',status:'completed',result:{path:f.path,content,revision:sha(content)}}]})[0].passed,true);
 for(const requiredText of [null,'one',[''],['same','same'],['two\nlines'],['x'.repeat(501)],Array.from({length:13},(_,i)=>'x'+i)])await assert.rejects(prepareRequirements({files:[{...r,requiredText}],commands:[]},f.system),/snippets/);
 await assert.rejects(prepareRequirements({files:[{...r,exactText:'No required snippets\n'}],commands:[]},f.system),/contradicts/);
});

test('formatting cannot invent required content and rejected output remains unsaved',async t=>{
 const f=await fixture(t,c=>{const last=c.recentEvidence.map(JSON.parse).at(-1),path=c.outputRequirements.files[0].path;if(!last)return call('propose_formatted_file',{path,content:'Missing citation',reason:'Fixture'});if(last.status==='failed')return call('propose_draft_patch',{draft:c.repairableDraft.evidence,edits:[{before:'Missing citation',after:'Observed fact [Source](source.md)'}],reason:'Corrected citation'});if(last.name==='propose_file_edit')return call('read_system_file',{path});return call('finish_step',{summary:'Required citation is present.',evidence:c.evidenceForCompletion.map(o=>o.id)});});
 const w=await f.plan({requirements:{files:[{path:f.path,finalNewline:'required',lineEndings:'lf',requiredText:['[Source](source.md)']}],commands:[]}}),a=await f.pending(w.id),r=await f.workflows.read(w.id);
 assert.equal(r.operations[0].status,'failed');assert(!r.operations[0].action);assert.match(r.operations[0].result.error,/Missing required text/);assert.equal((await f.store.list('actions')).length,1);assert.equal(await readFile(f.path,'utf8'),'before');assert.equal(a.payload.content,'Observed fact [Source](source.md)\n');await f.actions.decide(a.id,'approve',a.digest);assert((await f.wait(w.id,'completed')).requirementChecks.every(c=>c.passed));
});

test('a rejected draft can be repaired exactly without rewriting unrelated text or touching disk before review',async t=>{
 const f=await fixture(t,c=>{const last=c.recentEvidence.map(JSON.parse).at(-1),path=c.outputRequirements.files[0].path;if(!last)return call('propose_formatted_file',{path,content:'Budget is 120 [Source](source.md)\n\nKeep this paragraph unchanged.',reason:'Fixture'});if(last.status==='failed'){assert(c.repairableDraft);return call('propose_draft_patch',{draft:c.repairableDraft.evidence,edits:[{before:'Budget is 120 [Source]',after:'Budget is 120. [Source]'}],reason:'Preserve the exact quoted punctuation'});}if(last.name==='propose_file_edit')return call('read_system_file',{path});return call('finish_step',{summary:'Read the repaired draft after approval.',evidence:c.evidenceForCompletion.map(o=>o.id)});});
 const w=await f.plan({requirements:{files:[{path:f.path,finalNewline:'required',lineEndings:'lf',requiredText:['Budget is 120.','[Source](source.md)']}],commands:[]}}),a=await f.pending(w.id),r=await f.workflows.read(w.id);
 assert.equal(await readFile(f.path,'utf8'),'before');assert.equal(a.payload.content,'Budget is 120. [Source](source.md)\n\nKeep this paragraph unchanged.\n');assert.equal(r.operations[1].requestedTool,'propose_draft_patch');assert.equal((await f.store.list('actions')).length,1);await f.actions.decide(a.id,'approve',a.digest);const done=await f.wait(w.id,'completed');assert.equal(f.workflows.toolsFor(done).some(t=>t.function.name==='propose_draft_patch'),false);
});

test('draft repairs reject stale revisions, older drafts, accepted drafts and target overrides',async()=>{
 const {patchDraft,draftRepairTool}=await import('../src/workflow-tools.mjs');const failed={id:'draft',name:'propose_file_edit',status:'failed',revision:1,arguments:{path:'/output',content:'Old text'},result:{requirementFailures:['Missing required text']}},w={revision:1,requirements:{files:[{path:'/output',finalNewline:'required',lineEndings:'lf'}]},operations:[failed]},args={draft:'E1',edits:[{before:'Old',after:'New'}],reason:'Correction'};
 assert.equal(patchDraft(w,args).content,'New text\n');assert.equal(failed.arguments.content,'Old text');assert(draftRepairTool(w).length);
 assert.throws(()=>patchDraft(w,{...args,path:'/other'}));assert.throws(()=>patchDraft({...w,revision:2},args));assert.throws(()=>patchDraft({...w,operations:[failed,{...failed,id:'new'}]},args));assert.throws(()=>patchDraft({...w,operations:[{...failed,action:'a',status:'completed'}]},args));assert.throws(()=>patchDraft({...w,requirements:{files:[{...w.requirements.files[0],exactText:'saved'}]}},args));
});

test('rejected draft recovery restricts unrelated actions and permits empty patches for formatting only',async t=>{
 let blocked=false;const f=await fixture(t,c=>{const last=c.recentEvidence.map(JSON.parse).at(-1),path=c.outputRequirements.files[0].path;if(!last)return call('propose_file_edit',{path,content:'Title',reason:'Missing newline'});if(last.result?.requirementFailures)return call('computer_action',{operation:'open_path',path,reason:'Mistaken attempt to open an unsaved draft'});if(last.name==='computer_action'){blocked=true;assert.match(last.result.error,/has not been saved/);return call('propose_draft_patch',{draft:c.repairableDraft.evidence,edits:[],reason:'Apply the saved final newline'});}if(last.name==='propose_file_edit')return call('read_system_file',{path});return call('finish_step',{summary:'Formatted file read back.',evidence:c.evidenceForCompletion.map(o=>o.id)});});
 const w=await f.plan({requirements:{files:[{path:f.path,finalNewline:'required',lineEndings:'lf'}],commands:[]}}),a=await f.pending(w.id);assert(blocked);assert.equal((await f.store.list('actions')).length,1);assert.equal(a.payload.content,'Title\n');const operations=(await f.workflows.read(w.id)).operations;assert(!operations.find(o=>o.name==='computer_action').action);await f.actions.decide(a.id,'approve',a.digest);await f.wait(w.id,'completed');
});
