import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,link} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {sha} from '../src/vault.mjs';
import {filePatch} from '../src/file-patch.mjs';

const call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});
const until=async fn=>{const end=Date.now()+7000;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('Continuity fixture timed out');};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'aurora-continuity-')),project=join(dir,'project');await mkdir(project);const path=join(project,'math.mjs');await writeFile(path,'// untouched 🦊\r\nexport function add(a, b) { return a - b; }\r\n// keep this\r\n');
  let respond=c=>{const read=c.evidenceForCompletion.find(o=>o.name==='read_system_file');return read?call('finish_step',{summary:'Observed the original file.',evidence:[read.id]}):call('read_system_file',{path});};
  const model={model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(m,_t,signal,_c,options)=>{signal.throwIfAborted();return options?.format?.properties.steps?{content:JSON.stringify({steps:[{title:'Inspect and check the requested outcome',check:'Use fresh file observations and required command checks.'}]})}:respond(JSON.parse(m.at(-1).content));}};
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),embedding:'',projects:[],ollamaClient:model,workflowOptions:{pollMs:10,segmentMs:10000}});
  t.after(async()=>{await app.workflows.close();app.actions.stopAll();await until(()=>!app.actions.running.size);app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
  const wait=(id,status)=>until(async()=>{const w=await app.workflows.read(id);return w.status===status&&!app.workflows.running.has(id)?w:null;});
  const start=async(input={})=>app.workflows.start({goal:'Inspect the project file',scope:project,...input});
  const pending=async id=>until(async()=>{const w=await app.workflows.read(id);return w.status==='waiting_approval'&&!app.workflows.running.has(id)&&(await app.store.list('actions')).find(a=>a.workflow?.id===id&&a.status==='pending');});
  const source=async()=>{const w=await start();return wait(w.id,'completed');};
  return Object.assign(app,{dir,project,path,wait,start,pending,source,setReply:fn=>respond=fn});
}

test('literal patches preserve surrounding UTF-8 and mixed line endings; all matches refer to the original',()=>{
  const before='header 🦊\r\nalpha one\r\nbeta two\ntail';
  const p=filePatch(before,[{before:'one',after:'ONE'},{before:'two',after:'TWO'}]);assert.equal(p.content,'header 🦊\r\nalpha ONE\r\nbeta TWO\ntail');assert.match(p.diff,/line 2, column 7/);assert.match(p.diff,/- "one"\n\+ "ONE"/);
  assert.equal(filePatch('abc\n',[{before:'b',after:''}]).content,'ac\n');
  for(const edits of [[],[{before:'missing',after:'x'}],[{before:'a',after:'x'},{before:'ab',after:'y'}],[{before:'',after:'x'}],[{before:'a',after:'a'}],[{before:'a',after:'\ud800'}],Array(9).fill({before:'a',after:'b'})])assert.throws(()=>filePatch('abc',edits));
  assert.equal(filePatch('abc',[{before:'a',after:'b'},{before:'b',after:'c'}]).content,'bcc');
  assert.throws(()=>filePatch('aaaa',[{before:'aa',after:'b'}]),/ambiguous/);
});

test('targeted proposals reject stale reads, binary encodings, protected content and hard links',async t=>{
  const f=await fixture(t),r=await f.system.read(f.path),edits=[{before:'a - b',after:'a + b'}];
  await writeFile(f.path,r.content+'changed');await assert.rejects(f.system.preparePatch(f.path,r.revision,edits),/changed since/);
  await writeFile(f.path,Buffer.from([0x61,0xff,0x62]));await assert.rejects(f.system.preparePatch(f.path,sha('a�b'),edits),/UTF-8/);
  await writeFile(f.path,'api_key=superprivate');await assert.rejects(f.system.preparePatch(f.path,sha('api_key=superprivate'),[{before:'superprivate',after:'different'}]),/credentials/);
  await writeFile(f.path,r.content);await link(f.path,join(f.project,'second.mjs'));await assert.rejects(f.system.preparePatch(f.path,r.revision,edits),/hard link/);
  await assert.rejects(f.system.preparePatch(join(f.dir,'data','models.json'),r.revision,edits),/protected/);
});

test('patch approval shows the exact diff, binds it to the digest, backs up, and rejects changed files',async t=>{
  const f=await fixture(t),before=await readFile(f.path,'utf8'),input={path:f.path,revision:sha(before),edits:[{before:'a - b',after:'a + b'}]};
  const a=await f.actions.propose('write',input);assert.equal(await readFile(f.path,'utf8'),before);assert(a.payload.patch.diff.includes('+ "a + b"'));
  a.payload.patch.diff='misleading';await f.store.put('actions',a);await assert.rejects(f.actions.decide(a.id,'approve',a.digest),/changed/);await f.actions.decide(a.id,'dismiss');
  const stale=await f.actions.propose('write',input);await writeFile(f.path,before+'external');await f.actions.decide(stale.id,'approve',stale.digest);await until(()=>!f.actions.running.size);assert.equal((await f.store.get('actions',stale.id)).status,'failed');assert.equal(await readFile(f.path,'utf8'),before+'external');
  await writeFile(f.path,before);const correct=await f.actions.propose('write',input);await f.actions.decide(correct.id,'approve',correct.digest);await until(()=>!f.actions.running.size);const done=await f.store.get('actions',correct.id);assert.equal(done.status,'completed');assert.equal(await readFile(done.result.backup,'utf8'),before);assert.equal(await readFile(f.path,'utf8'),before.replace('a - b','a + b'));
});

test('workflow patches use fresh read handles, retain output requirements and verify a real Node test',async t=>{
  const f=await fixture(t);await writeFile(join(f.project,'math.test.mjs'),"import {add} from './math.mjs';import assert from 'node:assert/strict';import test from 'node:test';test('adds',()=>assert.equal(add(2,3),5));\n");
  f.setReply(c=>{const ops=c.recentEvidence.map(JSON.parse),last=ops.at(-1),command=c.evidenceForCompletion.find(o=>o.name==='propose_command');
    if(!last)return call('read_system_file',{path:f.path});
    if(!ops.some(o=>o.name==='propose_file_edit'))return call('propose_file_patch',{path:f.path,evidence:c.evidenceForCompletion.find(o=>o.name==='read_system_file').id,edits:[{before:'a - b',after:'a + b'}],reason:'Correct only the operator'});
    if(!command)return call('propose_command',c.outputRequirements.commands[0]);
    if(last.name==='propose_command')return call('verify_outcome',{evidence:command.id,kind:'command_output',expected:'pass 1'});
    if(last.name==='verify_outcome')return call('read_system_file',{path:f.path});
    return call('finish_step',{summary:'Patched and tested with fresh readback.',evidence:c.evidenceForCompletion.map(o=>o.id)});
  });
  const w=await f.start({requirements:{files:[{path:f.path,finalNewline:'required',lineEndings:'crlf'}],commands:[{program:'node',args:['--test','math.test.mjs'],cwd:f.project,outputIncludes:'pass 1'}]}});await f.wait(w.id,'plan_review');await f.workflows.control(w.id,'approve_plan','',w.revision);
  const a=await f.pending(w.id);assert(a.payload.patch);assert(a.payload.requirementsCheck);await f.actions.decide(a.id,'approve',a.digest);const cmd=await f.pending(w.id);await f.actions.decide(cmd.id,'approve',cmd.digest);const done=await f.wait(w.id,'completed');assert(done.requirementChecks.every(x=>x.passed));assert.equal(done.operations[1].requestedTool,'propose_file_patch');assert.equal(done.operations[1].requestedArguments.evidence,'E1');assert.equal(done.operations.filter(o=>o.name==='propose_file_edit').length,1);
});

test('invented patch evidence and patches violating exact text cannot create an approval',async t=>{
  const f=await fixture(t);f.setReply(()=>call('propose_file_patch',{path:f.path,evidence:'E99',edits:[{before:'a - b',after:'a + b'}]}));const w=await f.start();await f.wait(w.id,'needs_help');assert.equal((await f.store.list('actions')).length,0);
  const original=await readFile(f.path,'utf8');f.setReply(c=>c.evidenceForCompletion.length?call('propose_file_patch',{path:f.path,evidence:'E1',edits:[{before:'a - b',after:'a * b'}]}):call('read_system_file',{path:f.path}));
  const other=await f.start({requirements:{files:[{path:f.path,exactText:original.replace('a - b','a + b'),finalNewline:'required',lineEndings:'crlf'}],commands:[]}});await f.wait(other.id,'plan_review');await f.workflows.control(other.id,'approve_plan','',1);const stopped=await f.wait(other.id,'needs_help');assert.equal(stopped.operations.filter(o=>o.result?.requirementFailures).length,3);assert.equal((await f.store.list('actions')).length,0);assert.equal(await readFile(f.path,'utf8'),original);
});

test('reviewed Markdown handoff survives restart, snapshots edits, and requires fresh plan and evidence',async t=>{
  const f=await fixture(t),source=await f.source(),draft=await f.workflows.handoffs.draft(source.id);
  assert(draft.body.includes(f.path));assert(draft.body.includes(source.operations[0].id));assert.equal((await f.workflows.handoffs.list()).length,0);
  const input={sourceId:source.id,handoffId:draft.id,draftRevision:draft.draftRevision,title:'Addition project',body:draft.body+'\n\nContinue only the next requested change.',project:'20 Projects/Example Project.md'};
  const saved=await f.workflows.handoffs.save(input);assert(saved.content.includes('[[20 Projects/Example Project]]'));assert.equal((await f.store.list('workflows')).length,1);assert.equal((await f.workflows.handoffs.save(input)).revision,saved.revision);
  await f.workflows.close();await f.workflows.init();const listed=await f.workflows.handoffs.list();assert.equal(listed[0].id,saved.id);
  await f.assistant.vault.save(saved.path,saved.content+'\nEdited in Obsidian.\n',saved.revision);await assert.rejects(f.start({handoffId:saved.id,handoffRevision:saved.revision}),/note changed/);
  const fresh=await f.workflows.handoffs.read(saved.id),child=await f.start({goal:'Inspect the file again for the next task',handoffId:fresh.id,handoffRevision:fresh.revision});const planned=await f.wait(child.id,'plan_review');assert.equal(planned.operations.length,0);assert.deepEqual(planned.requirements,{files:[],commands:[]});assert.equal(planned.calls,1);assert(planned.handoff.content.includes('Edited in Obsidian'));assert.equal(planned.handoff.sourceId,source.id);
  await f.workflows.close();await f.workflows.init();assert.equal((await f.workflows.read(child.id)).status,'plan_review');await f.workflows.control(child.id,'approve_plan','',1);const done=await f.wait(child.id,'completed');assert(done.operations.some(o=>o.name==='read_system_file'));assert(done.operations.every(o=>!source.operations.some(old=>o.id===old.id)));assert.equal((await f.store.list('actions')).length,0);
});

test('handoff save rejects changed sources and cannot inherit pending or unverified effects',async t=>{
  const f=await fixture(t),w=await f.source(),d=await f.workflows.handoffs.draft(w.id),raw=await f.store.get('workflows',w.id);raw.goal='Changed goal';await f.workflows.save(raw);
  await assert.rejects(f.workflows.handoffs.save({sourceId:w.id,handoffId:d.id,draftRevision:d.draftRevision,title:d.title,body:d.body}),/source task changed/);
  const a=await f.actions.propose('write',{path:f.path,content:'something'},null,null,{id:w.id,revision:raw.revision});await assert.rejects(f.workflows.handoffs.draft(w.id),/pending actions/);await f.actions.decide(a.id,'dismiss');
  raw.operations.push({id:'unfinished',name:'propose_file_edit',status:'completed',expected:{path:f.path,revision:'unread'},finished:new Date().toISOString()});await f.workflows.save(raw);await assert.rejects(f.workflows.handoffs.draft(w.id),/Verify/);
});

test('a retry completes an interrupted handoff save without overwriting external edits or starting work',async t=>{
  const f=await fixture(t),w=await f.source(),d=await f.workflows.handoffs.draft(w.id),input={sourceId:w.id,handoffId:d.id,draftRevision:d.draftRevision,title:d.title,body:d.body};
  const put=f.store.put.bind(f.store);f.store.put=async(kind,r)=>{if(kind==='handoffs'&&r.status==='saved')throw Error('Simulated crash after note save');return put(kind,r);};
  await assert.rejects(f.workflows.handoffs.save(input),/Simulated crash/);f.store.put=put;assert.equal((await f.store.get('handoffs',d.id)).status,'saving');await f.workflows.close();await f.workflows.init();const saved=await f.workflows.handoffs.save(input);assert.equal(saved.id,d.id);assert.equal((await f.store.list('workflows')).length,1);
  const d2=await f.workflows.handoffs.draft(w.id),input2={sourceId:w.id,handoffId:d2.id,draftRevision:d2.draftRevision,title:d2.title,body:d2.body};f.store.put=async(kind,r)=>{if(kind==='handoffs'&&r.status==='saved')throw Error('Simulated crash');return put(kind,r);};await assert.rejects(f.workflows.handoffs.save(input2));f.store.put=put;const pending=await f.store.get('handoffs',d2.id),n=await f.assistant.vault.read(pending.path);await f.assistant.vault.save(n.path,n.content+'\nExternal edit.',n.revision);await assert.rejects(f.workflows.handoffs.save(input2),/not been overwritten/);
});

test('handoff API requires authentication and read routes cannot save or launch tasks',async t=>{
  const f=await fixture(t);await new Promise(r=>f.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+f.server.address().port;
  assert.equal((await fetch(base+'/api/workflow-handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);assert.deepEqual(await (await fetch(base+'/api/workflow-handoffs')).json(),[]);assert.equal((await f.store.list('workflows')).length,0);
});
