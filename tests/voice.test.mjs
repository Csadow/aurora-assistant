import test from 'node:test';
import assert from 'node:assert/strict';
import {wakeMatch} from '../desktop/wake.mjs';
import {wav,pcmRms} from '../desktop/voice.mjs';
test('wake phrase requires a greeting and name, and extracts the command',()=>{assert.equal(wakeMatch('Hey Aurora, what are my tasks?').text,'what are my tasks?');assert.equal(wakeMatch('Hey A Rora.').text,'');assert.equal(wakeMatch('the aurora is lovely'),null);assert.equal(wakeMatch('yesterday we met Aurora'),null);assert.equal(wakeMatch('hello there'),null);assert.equal(wakeMatch('Hey Aster'),null);assert.equal(wakeMatch('Hey Auroral'),null);assert.equal(wakeMatch('OK, Aurora! Help me').text,'Help me');});
test('local audio framing produces mono 16 kHz PCM and ignores silence',()=>{const pcm=Buffer.alloc(32000);assert.equal(pcmRms(pcm),0);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(500,i);assert.equal(pcmRms(pcm),500);const audio=wav(pcm);assert.equal(audio.toString('ascii',0,4),'RIFF');assert.equal(audio.readUInt32LE(24),16000);assert.equal(audio.readUInt32LE(40),32000);assert.equal(audio.length,32044);});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceCapture } from '../desktop/voice.mjs';
import { WakeListener } from '../desktop/wake.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function recorder(){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=[];child.kill=signal=>{child.kills.push(signal);queueMicrotask(()=>child.emit('close',null,signal));};return child;}
test('cancelling voice during availability check cannot reopen the microphone',async()=>{
  const gate=deferred();let opened=0;const voice=new VoiceCapture({voiceStatus:()=>gate.promise,microphone:()=>{opened++;return recorder();}});
  const pending=voice.start();assert.equal(voice.state,'starting');await voice.cancel();gate.resolve({available:true});await pending;assert.equal(opened,0);assert.equal(voice.state,'idle');
});
test('cancelling voice during directory allocation removes late temporary files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'aurora-voice-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const gate=deferred();let allocated;let opened=0;
  const voice=new VoiceCapture({voiceStatus:async()=>({available:true}),mkdtemp:async()=>{allocated=await mkdtemp(join(root,'recording-'));await gate.promise;return allocated;},microphone:()=>{opened++;return recorder();}});
  const pending=voice.start();while(!allocated)await new Promise(r=>setImmediate(r));await voice.cancel();gate.resolve();await pending;assert.equal(opened,0);assert.deepEqual(await readdir(root),[]);
});
test('late transcription and recorder close cannot overwrite a newer recording',async t=>{
  const gate=deferred(),entered=deferred(),children=[],updates=[];
  const voice=new VoiceCapture({voiceStatus:async()=>({available:true}),microphone:()=>{const child=recorder();children.push(child);return child;},transcribe:async()=>{entered.resolve();await gate.promise;return 'stale transcript';}});t.after(()=>voice.cancel());voice.on('update',e=>updates.push(e));
  await voice.start();const pcm=Buffer.alloc(16000);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(700,i);children[0].stdout.write(pcm);
  const stopping=voice.stop();await entered.promise;await voice.cancel();await voice.start();gate.resolve();await stopping;children[0].emit('error',new Error('old recorder'));assert.equal(voice.state,'recording');assert(!updates.some(e=>e.text==='stale transcript'));assert.deepEqual(children[1].kills,[]);
});
test('wake startup is single-flight and cancellation revokes pending startup',async()=>{
  const gate=deferred();let opened=0;const wake=new WakeListener({access:()=>gate.promise,microphone:()=>{opened++;return recorder();}});
  const first=wake.start(),second=wake.start();wake.stop();gate.resolve();await Promise.all([first,second]);assert.equal(opened,0);assert.equal(wake.enabled,false);
});
test('late close and errors from an old wake recorder do not stop its replacement',async t=>{
  const children=[],wake=new WakeListener({access:async()=>{},microphone:()=>{const child=recorder();children.push(child);return child;}});t.after(()=>wake.stop());
  await wake.start();wake.stop();await wake.start();children[0].emit('close',1);children[0].emit('error',new Error('old process'));assert.equal(wake.enabled,true);assert.deepEqual(children[1].kills,[]);
});
