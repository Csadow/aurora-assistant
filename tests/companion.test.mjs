import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.mjs';
import { characterPath } from '../src/character.mjs';
import { validateFrame } from '../src/screen-guide.mjs';
import { ScreenCapture, geometry } from '../desktop/screen.mjs';
import { collectModel, assetPath, AvatarStore } from '../desktop/avatar.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=','base64');
const frame=()=>({image:png.toString('base64'),capturedAt:Date.now()});
async function temporary(t){const dir=await mkdtemp(join(tmpdir(),'aster-companion-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('character Markdown updates the next prompt and rejects stale saves',async t=>{
  const dir=await temporary(t),prompts=[];
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),projects:[],embedding:'',ollamaClient:{check:async()=>{},chat:async(messages)=>{prompts.push(messages);return {role:'assistant',content:'Hello'};}}});
  const first=await app.character.read();await app.character.save('# Aurora\nCalm, precise, poetic.',first.revision);
  await assert.rejects(app.character.save('Stale',first.revision),e=>e.status===409);
  await writeFile(join(app.vault.root,characterPath),'# Aurora\nWarm, curious, use short sentences.');
  const c=await app.store.conversation();await app.assistant.chat({id:c.id,message:'Hello'},new AbortController().signal,()=>{});
  assert.match(prompts[0][0].content,/Warm, curious/);assert.match(prompts[0][0].content,/presentation preferences only/);assert.match(prompts[0][0].content,/cannot approve actions yourself/);
});
test('screen guidance receives an image but no tools, memory, journal writes, or cloud access',async t=>{
  const dir=await temporary(t);let checkOptions;
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),projects:[],ollamaClient:{check:async options=>{checkOptions=options;},chat:async(messages,tools,signal,chunk,options)=>{assert.equal(tools,undefined);assert.equal(messages.length,2);assert.deepEqual(messages[1].images,[frame().image]);assert.doesNotMatch(messages[0].content,/PRIVATE-MEMORY/);assert.equal(options.num_predict,400);return {content:'Visible blue button',metrics:{seconds:1}};}}});
  await app.vault.save('10 Profile/Private.md','# PRIVATE-MEMORY',null);const notes=(await app.vault.list()).map(n=>n.content);
  const answer=await app.screenGuide.answer({frame:frame(),question:'What can I do here?'},new AbortController().signal);
  assert.equal(answer.local,true);assert.deepEqual(checkOptions,{vision:true});assert.deepEqual(await app.store.list('conversations'),[]);assert.deepEqual(await app.store.list('actions'),[]);assert.deepEqual((await app.vault.list()).map(n=>n.content),notes);assert.equal(app.assistant.busy.size,0);
  app.assistant.busy.add('other');await assert.rejects(app.screenGuide.answer({frame:frame(),question:'help'},new AbortController().signal),e=>e.status===409);
});
test('screen frames reject stale, oversized, non-image data and decompression bombs',()=>{
  assert.equal(validateFrame(frame()),frame().image);
  for(const bad of [{...frame(),capturedAt:0},{...frame(),capturedAt:Date.now()+60000},{...frame(),image:'data:image/png;base64,abc'}, {...frame(),image:Buffer.from('not an image').toString('base64')}, {...frame(),image:'A'.repeat(1500004)}])assert.throws(()=>validateFrame(bad));
  const bomb=Buffer.from(png);bomb.writeUInt32BE(50000,16);assert.throws(()=>validateFrame({...frame(),image:bomb.toString('base64')}));
});
test('screen capture requires selection, confines geometry, expires, and discards a capture stopped in flight',async()=>{
  let time=1000,calls=[],release;
  const capture=new ScreenCapture({now:()=>time,leaseMs:100,encode:async()=>png,execute:async(program,args)=>{calls.push([program,args]);if(program==='slurp')return {stdout:'-100,20 800x600\n'};if(release===null)await new Promise(r=>release=r);return {stdout:png};}});
  await assert.rejects(capture.capture(),/Select a region again/);assert.equal(calls.length,0);
  await capture.select();const result=await capture.capture();assert(result.image);assert.equal(calls[1][1][1],'-100,20 800x600');
  time+=101;await assert.rejects(capture.capture(),/ended/);assert.equal(capture.status().active,false);
  await capture.select();release=null;const pending=capture.capture();await new Promise(r=>setImmediate(r));capture.stop();release();await assert.rejects(pending,/ended/);
  for(const value of ['0,0 0x1','1,1 99999x99999','0,0 100x100; rm -rf /','full-screen'])assert.throws(()=>geometry(value));
});
test('stopping selection prevents late consent and lease expiry emits a stop',async()=>{
  let release;const capture=new ScreenCapture({leaseMs:20,encode:async()=>png,execute:()=>new Promise(r=>release=r)});
  const pending=capture.select();capture.stop();release({stdout:'0,0 100x100'});await assert.rejects(pending,/stopped/);assert.equal(capture.status().active,false);
  const next=capture.select();release({stdout:'0,0 100x100'});await next;await new Promise(r=>setTimeout(r,30));assert.equal(capture.status().active,false);
});
test('persistent desktop access survives hiding, time passage, and restart but explicit stop stays stopped',async t=>{
  const dir=await temporary(t),settingsFile=join(dir,'screen.json');let time=1000;const calls=[];
  const options={settingsFile,now:()=>time,leaseMs:20,encode:async()=>png,execute:async(program,args)=>{calls.push({program,args});return {stdout:png};}};
  const capture=new ScreenCapture(options);await capture.init();assert.equal(capture.status().active,false);
  await capture.configure({persistent:true,resumeOnStart:true});await capture.desktop();capture.detach();time+=86400000;
  assert.equal(capture.status().active,true);assert.equal(capture.status().expiresAt,null);await capture.capture();assert.deepEqual(calls,[{program:'grim',args:['-s','1','-']}]);
  assert(!JSON.stringify(JSON.parse(await readFile(settingsFile))).includes(png.toString('base64')));
  capture.stop({remember:false});const restarted=new ScreenCapture(options);await restarted.init();assert.equal(restarted.status().scope,'desktop');assert.equal(restarted.status().active,true);
  restarted.stop();await restarted.queue;const stopped=new ScreenCapture(options);await stopped.init();assert.equal(stopped.status().active,false);await assert.rejects(stopped.capture());await stopped.queue;
});
test('persistent permission without startup opt-in does not resume; invalid settings fail closed',async t=>{
  const dir=await temporary(t),settingsFile=join(dir,'screen.json');const options={settingsFile,encode:async()=>png};
  const capture=new ScreenCapture(options);await capture.configure({persistent:true,resumeOnStart:false});await capture.desktop();capture.stop({remember:false});
  const restarted=new ScreenCapture(options);await restarted.init();assert.equal(restarted.status().active,false);
  await assert.rejects(restarted.configure({persistent:false,resumeOnStart:true}));
  await writeFile(settingsFile,JSON.stringify({enabled:true,persistent:true,resumeOnStart:true,scope:'region',region:'../../bad'}));await restarted.init();assert.equal(restarted.status().active,false);
});
test('persistent capture stopped during encoding never returns a screenshot',async()=>{
  let finish;const capture=new ScreenCapture({encode:()=>new Promise(r=>finish=r),execute:async()=>({stdout:png})});
  await capture.configure({persistent:true,resumeOnStart:true});await capture.desktop();const pending=capture.capture();await new Promise(r=>setImmediate(r));capture.stop();finish(png);await assert.rejects(pending,/ended/);assert.equal(capture.status().active,false);
});
test('screen model errors and cancellation release the shared model slot',async t=>{
  const dir=await temporary(t);const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),projects:[],ollamaClient:{check:async()=>{throw new Error('Vision unavailable');}}});
  await assert.rejects(app.screenGuide.answer({frame:frame(),question:'help'},new AbortController().signal),/Vision unavailable/);assert.equal(app.assistant.busy.size,0);
});
test('Live2D import copies only referenced assets and blocks paths, symlinks, URLs, and unlisted files',async t=>{
  const dir=await temporary(t),root=join(dir,'model');await mkdir(root);await writeFile(join(root,'rig.moc3'),'MOC3fixture');await writeFile(join(root,'texture.png'),png);await writeFile(join(root,'private.txt'),'secret');
  const file=join(root,'Friend.model3.json'),model={Version:3,FileReferences:{Moc:'rig.moc3',Textures:['texture.png']}};await writeFile(file,JSON.stringify(model));
  const store=new AvatarStore(join(dir,'installed'));await store.init();await store.importModel(file);assert.equal((await store.status()).name,'Friend');await assert.rejects(store.asset('private.txt'));assert.deepEqual((await store.asset('texture.png')).bytes,png);
  await writeFile(join(root,'texture.png'),'changed after import');assert.deepEqual((await store.asset('texture.png')).bytes,png);
  const restarted=new AvatarStore(store.root);await restarted.init();assert((await restarted.status()).hasModel);
  for(const path of ['../secret.png','/tmp/x.png','https://evil.test/x.png','%2e%2e/x','a\\b.png','a//b','a/./b','.env'])assert.throws(()=>assetPath(path));
  model.FileReferences.Textures=['https://evil.test/x.png'];await writeFile(file,JSON.stringify(model));await assert.rejects(collectModel(file));
  await symlink(join(root,'texture.png'),join(root,'linked.png'));model.FileReferences.Textures=['linked.png'];await writeFile(file,JSON.stringify(model));await assert.rejects(collectModel(file),/Symbolic/);
});

test('deleted character stays deleted across restart and chat uses a default until explicitly saved',async t=>{
  const dir=await temporary(t),prompts=[],options={vault:join(dir,'vault'),data:join(dir,'data'),projects:[],embedding:'',ollamaClient:{check:async()=>{},chat:async messages=>{prompts.push(messages);return {role:'assistant',content:'Hello'};}}};
  const first=await createApp(options);const saved=await first.character.save('# Aurora\nBe precise.',null);await first.vault.trash(characterPath,saved.revision);
  const restarted=await createApp(options),fallback=await restarted.character.read();assert.equal(fallback.missing,true);assert.equal(fallback.revision,null);await assert.rejects(restarted.vault.read(characterPath),e=>e.status===404);
  const conversation=await restarted.store.conversation();await restarted.assistant.chat({id:conversation.id,message:'Hello'},new AbortController().signal,()=>{});assert.match(prompts[0][0].content,/warm, practical/);
  await restarted.character.save('# New character\nCalm and helpful.',fallback.revision);assert.equal((await restarted.character.read()).missing,false);
});
test('reloading invalid screen preferences revokes an existing active permission',async t=>{
  const dir=await temporary(t),settingsFile=join(dir,'screen.json'),capture=new ScreenCapture({settingsFile,encode:async()=>png});await capture.configure({persistent:true,resumeOnStart:true});await capture.desktop();await writeFile(settingsFile,'broken json');await capture.init();assert.equal(capture.status().active,false);assert.equal(capture.status().resumeOnStart,false);
});

test('window cleanup after shutdown does not revoke saved persistent screen permission',async t=>{
  const dir=await temporary(t),settingsFile=join(dir,'screen.json'),options={settingsFile,encode:async()=>png};const capture=new ScreenCapture(options);
  await capture.configure({persistent:true,resumeOnStart:true});await capture.desktop();capture.stop({remember:false});capture.detach();await capture.queue;
  const restarted=new ScreenCapture(options);await restarted.init();assert.equal(restarted.status().active,true);assert.equal(restarted.status().scope,'desktop');restarted.stop({remember:false});
});
