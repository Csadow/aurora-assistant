import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Speech,speechText,mouthLevel} from '../desktop/speech.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const turn=()=>new Promise(r=>setImmediate(r));
const audio={pcm:Buffer.alloc(22050*2),sampleRate:22050};
const ready=()=>({available:true});
const fake=options=>new Speech({status:ready,synthesize:async()=>audio,play:async()=>{},...options});
test('speech reads prose without code, URLs, tables or Markdown decoration',()=>{
  const {text}=speechText('# Hello **friend**\nSee [my note](https://example.com). [S1] [M2] <script>doNotRead()</script>\n```sh\nprivate command\n```\n| A | B |\n`secret_path`\nhttps://example.com/token\n![image](private.png)');
  assert.equal(text,'Hello friend See my note.');
  assert.throws(()=>speechText('```js\ncommand()\n```'),/no prose/);
  assert.throws(()=>speechText('x'.repeat(64001)),/64,000/);
  assert.throws(()=>speechText({text:'no'}),/64,000/);
});
test('long prose is bounded and announces that the rest remains in chat',()=>{const value=speechText('A complete sentence. '.repeat(400));assert(value.truncated);assert(value.text.length<=3000);assert(value.text.endsWith('The rest is in chat.'));});
test('mouth envelope is silent for silence and out-of-range time, bounded for loud audio',()=>{assert.equal(mouthLevel(audio.pcm,22050,0),0);const loud=Buffer.alloc(44100);for(let i=0;i<loud.length;i+=2)loud.writeInt16LE(20000,i);assert.equal(mouthLevel(loud,22050,.2),1);assert.equal(mouthLevel(loud,22050,-.1),0);assert.equal(mouthLevel(loud,22050,2),0);});
test('completed speech drives bounded lip values then returns to idle and zero',async()=>{
  const frames=[],states=[],speech=fake({play:async(_a,_s,_signal,onLevel)=>{onLevel(5);onLevel(.4);}});speech.on('frame',f=>frames.push(f));speech.on('update',s=>states.push(s.state));
  const reply=await speech.say('Hello.');assert(reply.accepted);await speech.pending;
  assert.deepEqual(states,['idle','synthesizing','speaking','idle']);assert(frames.some(f=>f.active&&f.level===1));assert.equal(frames.at(-1).level,0);assert.equal(frames.at(-1).active,false);
});
test('stop during availability revokes late synthesis and playback',async()=>{
  const gate=deferred();let calls=0;const speech=fake({status:()=>gate.promise,synthesize:async()=>{calls++;return audio;}});
  await speech.say('Old reply');const stopped=speech.stop();gate.resolve(ready());await stopped;assert.equal(calls,0);assert.equal(speech.state,'idle');
});
test('stop during synthesis cannot start playback after a late result',async()=>{
  const gate=deferred();let played=0;const speech=fake({synthesize:()=>gate.promise,play:async()=>played++});await speech.say('Old reply');await turn();
  const stopped=speech.stop();gate.resolve(audio);await stopped;assert.equal(played,0);assert.equal(speech.level,0);
});
test('new read request waits for stopped playback to exit; only the newest pending request runs',async()=>{
  const entered=deferred(),exit=deferred(),heard=[];let active=0,peak=0;
  const speech=fake({synthesize:async text=>({...audio,text}),play:async(a,_settings,signal,onLevel)=>{active++;peak=Math.max(active,peak);heard.push(a.text);onLevel(.7);if(a.text==='First'){entered.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await exit.promise;}active--;}});
  await speech.say('First');await entered.promise;await speech.say('Superseded');await speech.say('Newest');await turn();assert.deepEqual(heard,['First']);exit.resolve();await speech.pending;assert.deepEqual(heard,['First','Newest']);assert.equal(peak,1);assert.equal(speech.level,0);
});
test('mute immediately cancels speech, blocks new requests and survives restart without replay',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-speech-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'speech.json'),entered=deferred();let cancelled=false;
  const speech=fake({file,play:async(_a,_s,signal,onLevel)=>{onLevel(.8);entered.resolve();await new Promise(r=>signal.addEventListener('abort',()=>{cancelled=true;r();},{once:true}));}});
  await speech.init();await speech.say('A private reply');await entered.promise;await speech.configure({muted:true,volume:.3,rate:1.1,lipSync:false});assert(cancelled);await assert.rejects(speech.say('Late reply'),/muted/);assert.equal(speech.level,0);
  const saved=await readFile(file,'utf8');assert(!saved.includes('private'));assert.equal((await stat(file)).mode&0o777,0o600);const restarted=fake({file});await restarted.init();assert.deepEqual(restarted.settings,speech.settings);assert.equal(restarted.state,'idle');
});
test('settings changes are validated and save in request order',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-speech-'));t.after(()=>rm(dir,{recursive:true,force:true}));const speech=fake({file:join(dir,'speech.json')});
  for(const value of [{rate:10},{volume:-1},{lipSync:'yes'},{muted:1},{path:'/tmp/audio'},null,[]])await assert.rejects(speech.configure(value),/Invalid/);
  await Promise.all([speech.configure({muted:true}),speech.configure({volume:.2}),speech.configure({rate:.9})]);assert.deepEqual(JSON.parse(await readFile(speech.file,'utf8')),speech.settings);assert(speech.settings.muted);
});
test('unreadable saved settings fail muted; a missing file defaults to manual idle',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-speech-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'speech.json'),fresh=fake({file});await fresh.init();assert.equal(fresh.state,'idle');assert.equal(fresh.settings.muted,false);await writeFile(file,'{broken');const corrupt=fake({file});await corrupt.init();assert(corrupt.settings.muted);assert.match(corrupt.error,/could not be read/);
});
test('synthesis and playback errors clear lips and stay observable without unhandled rejection',async()=>{
  for(const deps of [{status:async()=>({available:false,error:'Missing voice'})},{synthesize:async()=>{throw new Error('Synthesis failed');}},{play:async(_a,_s,_sig,onLevel)=>{onLevel(.7);throw new Error('Audio device gone');}}]){
    const speech=fake(deps);await speech.say('Hello');await speech.pending;assert.equal(speech.state,'idle');assert.equal(speech.level,0);assert(speech.error);
  }
});
test('stale synthesis errors cannot overwrite the newest speech',async()=>{
  const gate=deferred(),speech=fake({synthesize:async text=>{if(text==='First'){await gate.promise;throw new Error('Old error');}return audio;}});
  await speech.say('First');await turn();await speech.say('Second');gate.resolve();await speech.pending;assert.equal(speech.error,'');assert.equal(speech.state,'idle');
});
test('closing aborts playback and awaits cleanup',async()=>{
  const entered=deferred();let cleaned=false;const speech=fake({play:async(_a,_s,signal)=>{entered.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await turn();cleaned=true;}});
  await speech.say('Hello');await entered.promise;await speech.close();assert(cleaned);assert.equal(speech.state,'idle');
});
