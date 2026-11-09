import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,utimes,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Vault,markdown} from '../src/vault.mjs';
import {MemoryReview} from '../src/memory-review.mjs';
import {Character,caringCharacter} from '../src/character.mjs';
async function fixture(t,chat){const dir=await mkdtemp(join(tmpdir(),'aster-review-'));t.after(()=>rm(dir,{recursive:true,force:true}));const vault=new Vault(join(dir,'vault'));await vault.init();const assistant={busy:new Set(),ollama:{check:async()=>{},chat:chat||(async()=>({content:'{"findings":[]}'}))}};const review=new MemoryReview({vault,data:join(dir,'data'),assistant});return {dir,vault,assistant,review};}
const paths=['30 Knowledge/Meeting A.md','30 Knowledge/Meeting B.md'];
async function conflicts(f){await f.vault.save(paths[0],markdown('Meeting A','The weekly project meeting is on Thursday.'),null);await f.vault.save(paths[1],markdown('Meeting B','The weekly project meeting is on Friday.'),null);}
const answer=()=>({content:JSON.stringify({findings:[{reason:'Two weekdays are given for the same weekly meeting.',evidence:[{path:paths[0],quote:'The weekly project meeting is on Thursday.'},{path:paths[1],quote:'The weekly project meeting is on Friday.'}]}]})});
test('memory review flags duplicates and old notes without altering source notes',async t=>{
  const f=await fixture(t);const a=await f.vault.save(paths[0],markdown('First','A detailed preference worth preserving for future project work.').replace(/^updated:.*$/m,'updated: "2020-01-01"'),null),b=await f.vault.save(paths[1],markdown('Second','A detailed preference worth preserving for future project work.'),null);await utimes(join(f.vault.root,a.path),new Date('2020-01-01'),new Date('2020-01-01'));
  await f.vault.save('90 Journal/Copy.md',markdown('Copy','A detailed preference worth preserving for future project work.',{status:'journal'}),null);
  const scan=await f.review.scan();assert(scan.findings.some(f=>f.kind==='duplicate'&&f.notes.length===2));assert(scan.findings.some(f=>f.kind==='aging'&&f.notes[0].path===a.path));assert(scan.findings.every(f=>f.notes.every(n=>!n.path.startsWith('90 Journal/'))));assert.equal((await f.vault.read(a.path)).revision,a.revision);assert.equal((await f.vault.read(b.path)).revision,b.revision);
});
test('keeping a finding survives restart but edited evidence makes it reviewable again',async t=>{
  const f=await fixture(t);for(const path of paths)await f.vault.save(path,markdown(path,'This is the same useful long preference in two notes.'),null);const first=(await f.review.scan()).findings.find(f=>f.kind==='duplicate');await f.review.markReviewed(first.id);const restarted=new MemoryReview({vault:f.vault,data:join(f.dir,'data'),assistant:f.assistant});assert(!(await restarted.scan()).findings.some(f=>f.id===first.id));await assert.rejects(restarted.markReviewed(first.id),e=>e.status===409);
  const note=await f.vault.read(paths[0]);await f.vault.save(note.path,note.content+'\n',note.revision);assert((await restarted.scan()).findings.some(f=>f.kind==='duplicate'));
});
test('local contradiction review saves only verified source quotes and has no action tools',async t=>{
  const f=await fixture(t,async(messages,tools)=>{assert.equal(tools,undefined);assert.match(messages[0].content,/untrusted data/);return answer();});await conflicts(f);const before=await f.vault.list();const result=await f.review.analyze(paths,new AbortController().signal);assert.equal(result.findings.length,1);assert.equal(result.findings[0].kind,'possible-conflict');assert.deepEqual(await f.vault.list(),before);assert.equal(f.assistant.busy.size,0);assert((await f.review.scan()).findings.some(f=>f.kind==='possible-conflict'));
});
test('fabricated quotes and invented paths cannot become review findings',async t=>{
  const f=await fixture(t,async()=>{const value=answer();const parsed=JSON.parse(value.content);parsed.findings[0].evidence[0].quote='A made-up claim not present in these notes.';return {content:JSON.stringify(parsed)};});await conflicts(f);const result=await f.review.analyze(paths);assert.equal(result.findings.length,0);assert.equal(result.discarded,1);
});
test('edited sources invalidate old AI findings and cancellation releases model access',async t=>{
  const f=await fixture(t,async()=>answer());await conflicts(f);await f.review.analyze(paths);let note=await f.vault.read(paths[1]);await f.vault.save(note.path,markdown('Meeting B','The weekly project meeting is on Thursday.'),note.revision);const scan=await f.review.scan();assert(scan.lastAnalysis.stale);assert(!scan.findings.some(f=>f.kind==='possible-conflict'));
  const abort=new AbortController();f.assistant.ollama.chat=async()=>{abort.abort();return answer();};await assert.rejects(f.review.analyze(paths,abort.signal),e=>e.name==='AbortError');assert.equal(f.assistant.busy.size,0);
});
test('review rejects notes changed during inference and malformed output without replacing the last report',async t=>{
  const f=await fixture(t,async()=>answer());await conflicts(f);await f.review.analyze(paths);const original=await readFile(f.review.reportFile,'utf8');f.assistant.ollama.chat=async()=>{const n=await f.vault.read(paths[0]);await f.vault.save(n.path,n.content+'\nUpdated.',n.revision);return answer();};await assert.rejects(f.review.analyze(paths),e=>e.status===409);assert.equal(await readFile(f.review.reportFile,'utf8'),original);
  f.assistant.ollama.chat=async()=>({content:'I cannot produce JSON'});await assert.rejects(f.review.analyze(paths),e=>e.status===502);assert.equal(f.assistant.busy.size,0);
});
test('memory review observes the shared inference lock and limits its input',async t=>{
  const f=await fixture(t);await conflicts(f);f.assistant.busy.add('chat');await assert.rejects(f.review.analyze(paths),e=>e.status===409);f.assistant.busy.clear();await assert.rejects(f.review.analyze([paths[0]]));await assert.rejects(f.review.analyze([paths[0],paths[0]]));await assert.rejects(f.review.analyze(['90 Journal/Unknown.md',paths[1]]));
});
test('default character is feminine, caring and accountable while preserving permission boundaries',async t=>{
  const f=await fixture(t),character=new Character(f.vault);const note=await character.read();assert(note.missing);assert.match(note.body,/female AI assistant/);assert.match(note.body,/she\/her/);assert.match(note.body,/supportive, and caring/);assert.match(note.body,/Be demanding/);assert.match(note.body,/Do not shame/);assert.match(await character.prompt(),/presentation preferences only/);assert.equal(note.body.includes(caringCharacter),true);
});

import {Ollama} from '../src/ollama.mjs';
test('structured review schema reaches Ollama as a top-level format without changing chat options',async()=>{
  const format={type:'object',properties:{findings:{type:'array'}},required:['findings']};let payload;
  const ollama=new Ollama('http://127.0.0.1:11434','fixture',async(url,options)=>{payload=JSON.parse(options.body);return new Response(JSON.stringify({message:{content:'{"findings":[]}'},done:true})+'\n');});
  await ollama.chat([{role:'user',content:'Review'}],undefined,new AbortController().signal,undefined,{format,temperature:0});assert.deepEqual(payload.format,format);assert.equal(payload.options.format,undefined);assert.equal(payload.options.temperature,0);
});
test('only current unresolved conflict evidence reaches recall and corrected notes invalidate it',async t=>{
 const f=await fixture(t,async()=>answer());await conflicts(f);await f.review.analyze(paths);
 assert.equal((await f.review.conflicts([paths[0]])).length,1);assert.equal((await f.review.conflicts(['other'])).length,0);
 const finding=(await f.review.scan()).findings.find(n=>n.kind==='possible-conflict');await f.review.markReviewed(finding.id);assert.equal((await f.review.conflicts(paths)).length,0);
 const n=await f.vault.read(paths[1]);await f.vault.save(n.path,n.content.replace('Friday','Thursday'),n.revision);assert.equal((await f.review.conflicts(paths)).length,0);
});
