import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, markdown, retrieve, parseNote, resolveLink } from '../src/vault.mjs';
import { localEndpoint } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Projects } from '../src/projects.mjs';
import { Assistant } from '../src/assistant.mjs';
import { Ollama } from '../src/ollama.mjs';

async function setup(t){const dir=await mkdtemp(join(tmpdir(),'aurora-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const vault=new Vault(join(dir,'vault'));await vault.init();const store=new Store(join(dir,'state'));await store.init();return {dir,vault,store};}
test('notes survive restart and external edits become current memory',async t=>{
  const {vault}=await setup(t);const path='20 Projects/Orbital.md';
  await vault.save(path,markdown('Orbital','Launch code: copper meadow 792. Related: [[About me]]'),null);
  const restarted=new Vault(vault.root);await restarted.init();
  assert.match((await restarted.read(path)).body,/copper meadow/);
  await writeFile(join(vault.root,path),markdown('Orbital','Launch code: silver orchard 381.'));
  const found=retrieve(await restarted.list(),'What is the Orbital launch code?');
  assert(found.some(n=>n.excerpt.includes('silver orchard 381')));assert(!found.some(n=>n.excerpt.includes('copper meadow')));
});
test('stale editor cannot overwrite disk changes; history restores a prior version',async t=>{
  const {vault}=await setup(t);let note=await vault.save('30 Knowledge/Test.md','# First',null);
  const old=note;note=await vault.save(note.path,'# Second',note.revision);
  await assert.rejects(vault.save(note.path,'# Stale',old.revision),e=>e.status===409);
  const ids=await vault.history(note.path);assert.equal(ids.length,1);
  const content=await vault.version(note.path,ids[0]);assert.equal(content,'# First');
  await vault.save(note.path,content,note.revision);assert.equal((await vault.read(note.path)).content,'# First');
});
test('simultaneous editors produce one save and one conflict',async t=>{
  const {vault}=await setup(t),n=await vault.read('10 Profile/About me.md');
  const results=await Promise.allSettled([vault.save(n.path,'one',n.revision),vault.save(n.path,'two',n.revision)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
});
test('path traversal, hidden files, symlinks and oversized notes are rejected',async t=>{
  const {vault,dir}=await setup(t);
  for(const path of ['../outside.md','/tmp/test.md','.aster/test.md','folder/../../a.md','foo\\bar.md','a.txt'])await assert.rejects(vault.read(path));
  await writeFile(join(dir,'outside.md'),'SECRET');await symlink(join(dir,'outside.md'),join(vault.root,'escape.md'));
  await symlink(dir,join(vault.root,'escape-dir'));
  await assert.rejects(vault.read('escape.md'));await assert.rejects(vault.save('escape-dir/new.md','bad',null));
  assert(!(await vault.list()).some(n=>n.path.includes('escape')));
  await assert.rejects(vault.save('huge.md','a'.repeat(524289),null));
});
test('trash removes recall and keeps recoverable content',async t=>{
  const {vault}=await setup(t);const note=await vault.save('30 Knowledge/Secret.md','# Secret\nunique-quartz-fact',null);
  const r=await vault.trash(note.path,note.revision);assert.match(await readFile(join(vault.root,r.recovery),'utf8'),/unique-quartz-fact/);
  assert(!retrieve(await vault.list(),'unique-quartz-fact').some(n=>n.path===note.path));
});
test('deleted starter memories do not reappear after restarting',async t=>{
  const {vault}=await setup(t);const note=await vault.read('10 Profile/About me.md');await vault.trash(note.path,note.revision);
  const restarted=new Vault(vault.root);await restarted.init();await assert.rejects(restarted.read(note.path),e=>e.status===404);
});
test('tasks remain standard Markdown and detect concurrent edits',async t=>{
  const {vault}=await setup(t);await vault.addTask('Prepare the weekly plan 📅 2026-10-01');
  const [task]=await vault.tasks();assert(!task.done);await vault.toggleTask(task.path,task.line,task.revision,true);
  assert((await vault.tasks())[0].done);await assert.rejects(vault.toggleTask(task.path,task.line,task.revision,false),e=>e.status===409);
  await assert.rejects(vault.addTask('one\n- [ ] injected'));
});
test('retrieval excludes journals, drafts and archives, includes pinned and linked notes',async t=>{
  const {vault}=await setup(t);
  for(const [path,status] of [['90 Journal/Log.md','journal'],['60 Inbox/Draft.md','draft'],['99 Archive/Old.md','confirmed']])await vault.save(path,markdown('Orchid', 'The orchid key is fake.',{status}),null);
  await vault.save('20 Projects/Orchid.md',markdown('Orchid','The orchid key is real. See [[River]].'),null);
  await vault.save('30 Knowledge/River.md',markdown('River','A related note.'),null);
  const found=retrieve(await vault.list(),'orchid key');
  assert(found.some(n=>n.pinned));assert(found.some(n=>n.path==='20 Projects/Orchid.md'));assert(found.some(n=>n.path==='30 Knowledge/River.md'&&n.linked));
  assert(!found.some(n=>/Log|Draft|Old/.test(n.path)));
});
test('retrieval finds multilingual text and honors bounded excerpts',async t=>{
  const {vault}=await setup(t);await vault.save('30 Knowledge/Кампания.md',markdown('Кампания','Кодовое слово: медный якорь. '.repeat(300)),null);
  const found=retrieve(await vault.list(),'Какое кодовое слово в кампании?',7,3000);assert(found.some(n=>n.title==='Кампания'));assert(found.reduce((n,s)=>n+s.excerpt.length,0)<=3000);
});
test('wikilink resolution prefers exact paths and disambiguates duplicate titles',()=>{
  const notes=[parseNote('a/Topic.md','# Topic'),parseNote('b/Topic.md','# Topic')];
  assert.equal(resolveLink('Topic',notes),null);assert.equal(resolveLink('a/Topic',notes),'a/Topic.md');assert.equal(resolveLink('Topic',notes,'a/Index.md'),'a/Topic.md');
});
test('Obsidian frontmatter supports block lists, inline tags and aliases',()=>{
  const note=parseNote('Knowledge/Teaching.md','---\ntitle: "Teaching"\naliases:\n  - Learning style\ntags: [learning, life]\npinned: true\n---\n# Teaching\nExamples first.');
  assert.deepEqual(note.tags,['learning','life']);assert(note.pinned);assert.equal(resolveLink('Learning style',[note]),note.path);
});
test('history search can recover earlier conversations without treating them as confirmed memory',async t=>{
  const {vault,store}=await setup(t);await vault.save('90 Journal/Old conversation.md',markdown('Old conversation','User mentioned a cobalt suitcase. Assistant guessed it was blue.',{status:'journal'}),null);
  const a=new Assistant({vault,store,projects:new Projects([])});
  const found=await a.runTool({function:{name:'search_history',arguments:{query:'cobalt suitcase'}}},'test');
  assert.equal(found[0].status,'journal');assert.match(found[0].warning,/Unverified/);assert(!retrieve(await vault.list(),'cobalt suitcase').some(n=>n.path.includes('Old conversation')));
});
test('model endpoints cannot point to external hosts or credentials',()=>{
  assert.equal(localEndpoint('http://localhost:11434'),'http://localhost:11434');
  for(const u of ['https://example.com','http://127.0.0.1.evil.test','http://user:pass@localhost:11434','http://127.0.0.1:11434/foo'])assert.throws(()=>localEndpoint(u));
});
test('project files are read only and confined; hidden secrets are excluded',async t=>{
  const {dir}=await setup(t);const root=join(dir,'project');await mkdir(root);await writeFile(join(root,'README.md'),'The orbital launch uses a copper meadow.');await writeFile(join(root,'.env'),'SECRET');await symlink(join(dir,'state'),join(root,'elsewhere'));
  const projects=new Projects([{name:'Example',root}]);assert.equal((await projects.search('Example','orbital'))[0].path,'README.md');
  for(const path of ['../outside.md','.env','elsewhere/README.md'])await assert.rejects(projects.read('Example',path));
});
test('explicit remember is persisted without an LLM and survives new conversations',async t=>{
  const {vault,store}=await setup(t);const assistant=new Assistant({vault,store,ollama:{check(){throw new Error('must not run');}},projects:new Projects([])});
  const c=await store.conversation(),events=[];await assistant.chat({id:c.id,message:'/remember My favorite tea is jasmine.'},new AbortController().signal,e=>events.push(e));
  assert(events.some(e=>e.type==='done'));assert(retrieve(await vault.list(),'favorite tea').some(n=>n.excerpt.includes('jasmine')));
  const saved=await store.get('conversations',c.id);assert.equal(saved.messages.length,2);assert((await vault.list()).some(n=>n.status==='journal'));
});
test('proposals stay outside recall until accepted, preserve existing notes and reject repeats',async t=>{
  const {vault,store}=await setup(t);const assistant=new Assistant({vault,store,projects:new Projects([])});
  const existing=await vault.save('30 Knowledge/Orbit.md','# Original',null);
  const p=await assistant.runTool({function:{name:'propose_memory',arguments:{title:'Orbit',folder:'30 Knowledge',content:'Unique proposal phoenix.'}}},'test');
  assert(!retrieve(await vault.list(),'phoenix').some(n=>n.excerpt.includes('phoenix')));
  await assistant.acceptProposal(p.id,'accept');assert(retrieve(await vault.list(),'phoenix').some(n=>n.excerpt.includes('phoenix')));
  assert.equal((await vault.read(existing.path)).content,existing.content);await assert.rejects(assistant.acceptProposal(p.id,'accept'));
});
test('chat injects evidence, uses tools and preserves journal separately from facts',async t=>{
  const {vault,store}=await setup(t);await vault.save('20 Projects/Orbit.md','# Orbit\nThe label is cobalt fern 942.',null);
  let calls=0;const ollama={async check(){},async chat(messages,tools,signal,onChunk){calls++;assert.match(messages[0].content,/cobalt fern 942/);if(calls===1)return {role:'assistant',content:'',tool_calls:[{function:{name:'list_tasks',arguments:{}}}],metrics:{}};onChunk('The label is cobalt fern 942. [M3]');return {role:'assistant',content:'The label is cobalt fern 942. [M3]',metrics:{seconds:1}};}};
  const assistant=new Assistant({vault,store,ollama,projects:new Projects([])}),c=await store.conversation(),events=[];
  await assistant.chat({id:c.id,message:'What is the Orbit label?'},new AbortController().signal,e=>events.push(e));
  assert.equal(calls,2);assert(events.some(e=>e.type==='tool'));assert.equal((await store.get('conversations',c.id)).messages.length,2);
});
test('failed model stream saves interruption and releases the generation lock',async t=>{
  const {vault,store}=await setup(t);const assistant=new Assistant({vault,store,projects:new Projects([]),ollama:{async check(){},async chat(m,t,s,onChunk){onChunk('partial');throw new Error('disconnected');}}}),c=await store.conversation();
  await assert.rejects(assistant.chat({id:c.id,message:'hello'},new AbortController().signal,()=>{}));assert.equal(assistant.busy.size,0);
  const saved=await store.get('conversations',c.id);assert.equal(saved.messages[1].content,'partial');assert(saved.messages[1].interrupted);
});
test('Ollama parses split UTF-8 streaming chunks and rejects truncated streams',async()=>{
  const bytes=new TextEncoder().encode(JSON.stringify({message:{content:'Привет 🌿'}})+'\n'+JSON.stringify({done:true,eval_count:2,total_duration:1e9})+'\n');
  const fetchImpl=async()=>new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close();}}));
  const llm=new Ollama('http://localhost:11434','qwen3.5:4b',fetchImpl);const result=await llm.chat([],[],new AbortController().signal,()=>{});assert.equal(result.content,'Привет 🌿');
  const broken=new Ollama('http://localhost:11434','qwen3.5:4b',async()=>new Response('{"message":{"content":"partial"}}\n'));
  await assert.rejects(broken.chat([],[],new AbortController().signal),/disconnected/);
});
