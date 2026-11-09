import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
const tool=(name,args)=>({role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]});
async function fixture(t,chat){
  const dir=await mkdtemp(join(tmpdir(),'aurora-laptop-'));const calls=[];
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:'',ollamaClient:{model:'fixture',check:async()=>{},status:async()=>({online:true,models:[{name:'fixture'}]}),chat:async(...args)=>{calls.push(args);return chat(...args);}}});
  clearInterval(app.workflows.timer);t.after(async()=>{await app.workflows.close();app.actions.stopAll();await rm(dir,{recursive:true,force:true});});
  return {app,dir,calls};
}
async function chat(app,message,mode='general',skills=[]){const c=await app.store.conversation(),events=[];await app.assistant.chat({id:c.id,message,mode,skills},new AbortController().signal,e=>events.push(e));return {id:c.id,events,conversation:await app.store.get('conversations',c.id)};}

test('chat task mode queues exactly one saved task, preserves selected skills, and releases inference',async t=>{
  const {app,calls}=await fixture(t,()=>{throw new Error('No inference until chat hands off');});
  const result=await chat(app,'Inspect the project, make the requested fix, and verify it.','act',['project-review']);
  assert.equal(calls.length,0);assert.equal(app.assistant.busy.size,0);const jobs=await app.store.list('workflows');assert.equal(jobs.length,1);assert.equal(jobs[0].conversation,result.id);assert.equal(jobs[0].status,'queued');assert.equal(jobs[0].skills[0].id,'project-review');
  assert.equal(result.conversation.messages.at(-1).workflow,jobs[0].id);assert.equal(result.events.filter(e=>e.type==='workflow').length,1);
});

test('natural language can hand off to a task without executing trailing model tool calls',async t=>{
  const {app}=await fixture(t,async()=>({role:'assistant',content:'',tool_calls:[{function:{name:'start_workflow',arguments:{goal:'Inspect a project and fix it',scope:'Only the requested folder'}}},{function:{name:'propose_command',arguments:{program:'printf',args:['must not run']}}}]}));
  const result=await chat(app,'Please take care of the project fix.');assert(result.conversation.messages.at(-1).workflow);assert.equal((await app.store.list('workflows')).length,1);assert.deepEqual(await app.store.list('actions'),[]);
});

test('/do creates a task; memory/task slash commands keep their existing behavior in task mode',async t=>{
  const {app,calls}=await fixture(t,()=>{throw new Error('Unexpected inference');});
  await chat(app,'/do Inspect my downloads');assert.equal((await app.store.list('workflows'))[0].goal,'Inspect my downloads');
  await chat(app,'/task Finish the fixture','act');assert((await app.vault.tasks()).some(t=>t.text==='Finish the fixture'));assert.equal((await app.store.list('workflows')).length,1);assert.equal(calls.length,0);
});

test('a cancelled handoff pauses the task before it can execute',async t=>{
  const {app}=await fixture(t,()=>{throw new Error('No execution');}),controller=new AbortController(),c=await app.store.conversation();
  const start=app.workflows.start.bind(app.workflows);app.workflows.start=async(...args)=>{const w=await start(...args);controller.abort();return w;};
  await assert.rejects(app.assistant.chat({id:c.id,message:'Read my folder',mode:'act'},controller.signal,()=>{}),e=>e.name==='AbortError');assert.equal((await app.store.list('workflows'))[0].status,'paused');assert.equal(app.assistant.busy.size,0);assert.equal((await app.store.list('actions')).length,0);
});

test('ordinary API workflow start cannot bypass a busy response; handoff needs its exact owner',async t=>{
  const {app}=await fixture(t,()=>{});app.assistant.busy.add('different');
  await assert.rejects(app.workflows.start({goal:'Do work'}),/active local/);
  await assert.rejects(app.workflows.start({goal:'Do work',conversation:'wrong'},{owner:'wrong'}),/active local/);app.assistant.busy.clear();
});

test('follow-up chat receives its saved task ID and can inspect progress only in its own conversation',async t=>{
  let id;
  const {app}=await fixture(t,async(messages,_tools,_signal,chunk)=>{
    assert(messages[0].content.includes(id));
    if(messages.at(-1).role==='tool'){chunk?.('The task is queued.');return {role:'assistant',content:'The task is queued.'};}
    return tool('get_workflow',{id});
  });
  const started=await chat(app,'Inspect the fixture project','act');id=started.conversation.messages.at(-1).workflow;
  const events=[];await app.assistant.chat({id:started.id,message:'Check the progress of my saved work'},new AbortController().signal,e=>events.push(e));
  assert.equal(events.at(-1).conversation.messages.at(-1).content,'The task is queued.');
  const another=await app.store.conversation();await assert.rejects(app.assistant.runTool({function:{name:'get_workflow',arguments:{id}}},another.id),e=>e.status===403);
});

test('file text search scans bounded ordinary files, skips credentials and links, and pages long text',async t=>{
  const {app,dir}=await fixture(t,()=>{}),root=join(dir,'project');await mkdir(root);await mkdir(join(root,'.ssh'));await mkdir(join(root,'node_modules'));
  const text='a'.repeat(25000)+'\nUniqueFixture needle\n';await writeFile(join(root,'long.txt'),text);
  await writeFile(join(root,'.ssh/private'),'UniqueFixture private');await writeFile(join(root,'node_modules/skip.txt'),'UniqueFixture dependency');await symlink(join(root,'.ssh/private'),join(root,'shortcut.txt'));
  await writeFile(join(root,'binary'),Buffer.from([0,1,2]));
  const result=await app.system.searchContent(root,'UniqueFixture',new AbortController().signal);assert.equal(result.matches.length,1);assert.equal(result.matches[0].line,2);assert.match(result.matches[0].path,/long.txt$/);
  const first=await app.system.read(join(root,'long.txt'));assert.equal(first.nextOffset,24000);const next=await app.system.read(join(root,'long.txt'),{offset:first.nextOffset});assert.match(next.content,/UniqueFixture/);assert.equal(next.nextOffset,null);assert.equal(next.revision,first.revision);
  await assert.rejects(app.system.read(join(root,'long.txt'),{offset:-1}),/offset/);
  await assert.rejects(app.system.searchContent(root,'a\nb'),/literal/);
  const stop=new AbortController();stop.abort();await assert.rejects(app.system.searchContent(root,'UniqueFixture',stop.signal),e=>e.name==='AbortError');
  await app.settings.save({systemEnabled:false});await assert.rejects(app.assistant.runTool({function:{name:'search_system_files',arguments:{path:root,query:'UniqueFixture'}}},null),/paused/);
});

test('saved tasks can inspect the screen through the existing grant and persist only the description',async t=>{
  let calls=0;const {app}=await fixture(t,async(messages,tools,_signal,_chunk,options)=>{
    if(options?.format)return {content:JSON.stringify({steps:[{title:'Inspect desktop',check:'Observe visible state'}]})};
    if(messages.some(m=>m.images)){assert.equal(tools,undefined);return {content:'The disposable calculator window is visible.'};}
    calls++;if(calls===1){assert(tools.some(t=>t.function.name==='inspect_desktop'));return tool('inspect_desktop',{question:'What is visible?'});}
    const ops=JSON.parse(messages.at(-1).content).recentEvidence.map(JSON.parse);return tool('finish_step',{summary:'Observed calculator.',evidence:[ops[0].id]});
  });
  let captures=0;app.actions.computer.request=async(method)=>{assert.equal(method,'capture');captures++;return {image:'fixture-base64-image',scope:'desktop',capturedAt:'now'};};
  const w=await app.workflows.start({goal:'Inspect the shared desktop'});
  while(app.workflows.running.size)await new Promise(r=>setTimeout(r,10));const saved=await app.store.get('workflows',w.id);assert.equal(saved.status,'completed');assert.equal(captures,1);assert(!JSON.stringify(saved).includes('fixture-base64-image'));assert.match(JSON.stringify(saved),/calculator/);
});
