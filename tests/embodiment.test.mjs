import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Embodiment} from '../src/embodiment.mjs';
import {EmbodimentLink} from '../desktop/embodiment-link.mjs';
import {createApp} from '../src/server.mjs';
import {AvatarStore} from '../desktop/avatar.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function temp(t){const dir=await mkdtemp(join(tmpdir(),'aurora-embodiment-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('avatar cues are bounded, transient, and unavailable when hidden, manual or disconnected',()=>{
  let now=10000;const e=new Embodiment({now:()=>now});const turn=e.begin('chat');
  assert.equal(e.express({mood:'warm'},'chat').applied,false);e.poll({enabled:true,visible:true});
  for(const args of [{mood:'blood'},{mood:'happy',gesture:'execute'},{mood:'warm',script:'alert(1)'},{mood:'warm',gesture:null}]){
    assert.throws(()=>e.express(args,'chat'),/supported/);
  }
  assert.throws(()=>e.express({mood:'warm'},'other'),/active conversation/);
  e.express({mood:'happy',gesture:'nod'},'chat');assert.equal(e.snapshot().cue.mood,'happy');
  e.express({mood:'determined',gesture:'tilt'},'chat');assert.throws(()=>e.express({mood:'warm'},'chat'),/Two expressions/);
  e.finish(turn);now+=8100;e.poll({enabled:true,visible:true});assert.equal(e.snapshot().cue,null);
  e.begin('second');e.express({mood:'playful'},'second');e.poll({enabled:false,visible:true});assert.equal(e.snapshot().cue,null);assert.equal(e.snapshot().available,false);
  e.poll({enabled:true,visible:true});assert.equal(e.snapshot().cue,null);e.express({mood:'warm'},'second');e.poll({enabled:true,visible:false});assert.equal(e.snapshot().cue,null);
  e.poll({enabled:true,visible:true});now+=5100;assert.equal(e.available(),false);assert.equal(e.snapshot().cue,null);
});
test('aborted and stale turns cannot leave or replace an active performance',()=>{
  const e=new Embodiment();e.poll({enabled:true,visible:true});const old=e.begin('old'),current=e.begin('current');
  e.phase(old,'working');e.finish(old);assert.equal(e.snapshot().phase,'thinking');
  e.express({mood:'happy'},'current');e.phase(current,'replying');assert.equal(e.snapshot().phase,'replying');e.finish(current,{cancelled:true});assert.deepEqual(e.snapshot(),{available:true,phase:'idle',cue:null});
});
test('a local model selects its avatar cue and still produces a normal answer; disabled mode omits tool',async t=>{
  const dir=await temp(t);let calls=0,app;const snapshots=[];
  app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),projects:[],embedding:'',ollamaClient:{check:async()=>{},chat:async(messages,tools,signal,onChunk)=>{
    calls++;snapshots.push(app.embodiment.snapshot());
    if(calls===1){assert(tools.some(t=>t.function.name==='express_avatar'));assert.match(messages[0].content,/on-screen representation/);return {role:'assistant',content:'',tool_calls:[{function:{name:'express_avatar',arguments:{mood:'happy',gesture:'nod'}}}]};}
    if(calls===2)assert.equal(app.embodiment.snapshot().cue.mood,'happy');else assert(!tools.some(t=>t.function.name==='express_avatar'));
    const content='You made progress. Let’s keep going.';onChunk(content);snapshots.push(app.embodiment.snapshot());return {role:'assistant',content,metrics:{}};
  }}});
  app.embodiment.poll({enabled:true,visible:true});const c=await app.store.conversation(),events=[];await app.assistant.chat({id:c.id,message:'I finished my task!'},new AbortController().signal,e=>events.push(e));
  assert.equal(calls,2);assert(snapshots.some(s=>s.phase==='replying'));assert.equal(app.embodiment.snapshot().cue.gesture,'nod');assert.equal(app.embodiment.snapshot().phase,'idle');assert.match(events.find(e=>e.type==='done').conversation.messages.at(-1).content,/progress/);
  app.embodiment.poll({enabled:false,visible:true});await app.assistant.chat({id:c.id,message:'Continue'},new AbortController().signal,()=>{});assert.equal(app.embodiment.snapshot().cue,null);
});
test('chat errors reset activity and cues instead of leaving the companion thinking',async t=>{
  const dir=await temp(t);const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),projects:[],embedding:'',ollamaClient:{check:async()=>{throw new Error('offline');}}});
  const c=await app.store.conversation();await assert.rejects(app.assistant.chat({id:c.id,message:'Hello'},new AbortController().signal,()=>{}),/offline/);assert.equal(app.embodiment.snapshot().phase,'idle');assert.equal(app.assistant.busy.size,0);
});
test('ordinary replies receive a local structured expression choice without any action tools',async t=>{
  const dir=await temp(t);let choices=0,fail=false;
  const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),projects:[],embedding:'',ollamaClient:{check:async()=>{},chat:async(messages,tools,signal,onChunk,options)=>{
    if(options?.format){choices++;assert.equal(tools,undefined);assert.equal(onChunk,undefined);assert.equal(options.think,false);assert.equal(options.num_predict,80);assert.equal(messages.length,2);assert.equal(options.format.additionalProperties,false);if(fail)throw new Error('selector unavailable');return {content:JSON.stringify({mood:'warm',gesture:'nod'})};}
    onChunk('One step at a time.');return {role:'assistant',content:'One step at a time.',metrics:{}};
  }}});
  app.embodiment.poll({enabled:true,visible:true});const c=await app.store.conversation(),events=[];await app.assistant.chat({id:c.id,message:'I need encouragement'},new AbortController().signal,e=>events.push(e));
  assert.equal(choices,1);assert(events.some(e=>e.type==='avatar'&&e.mood==='warm'));assert.equal(app.embodiment.snapshot().cue.gesture,'nod');assert.equal(events.find(e=>e.type==='done').conversation.messages.at(-1).content,'One step at a time.');
  fail=true;await app.assistant.chat({id:c.id,message:'Continue'},new AbortController().signal,()=>{});assert.equal((await app.store.get('conversations',c.id)).messages.at(-1).interrupted,undefined);assert.equal(app.embodiment.snapshot().phase,'idle');
});
test('embodiment heartbeat requires authorization and automatic preference survives restart',async t=>{
  const dir=await temp(t);const app=await createApp({data:join(dir,'data'),vault:join(dir,'vault'),projects:[],embedding:'',ollamaClient:{check:async()=>{}}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));
  const origin='http://127.0.0.1:'+app.server.address().port,token=(await(await fetch(origin+'/api/bootstrap')).json()).token;
  const request=headers=>fetch(origin+'/api/embodiment/poll',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({enabled:true,visible:true})});
  assert.equal((await request({})).status,403);assert.equal((await(await request({'X-Aster-Token':token})).json()).available,true);
  const avatars=new AvatarStore(join(dir,'profile'));await avatars.init();assert.equal((await avatars.status()).automatic,true);avatars.config.automatic=false;await avatars.save();const restarted=new AvatarStore(avatars.root);await restarted.init();assert.equal((await restarted.status()).automatic,false);
});
test('desktop transport recovers from backend restart and cancels late updates on stop',async()=>{
  const values=[];let count=0,resolveLate;
  const link=new EmbodimentLink({origin:'http://fixture',interval:5,status:()=>({enabled:true,visible:true}),onChange:v=>values.push(v),fetchImpl:async(url,options)=>{
    if(url.endsWith('/bootstrap'))return {ok:true,json:async()=>({token:'token'})};count++;
    if(count===1)return {ok:false};
    if(count===2)return {ok:true,json:async()=>({available:true,phase:'thinking',cue:null})};
    return new Promise(resolve=>{resolveLate=()=>resolve({ok:true,json:async()=>({available:true,phase:'working',cue:null})});});
  }});link.start();
  for(let i=0;i<100&&!resolveLate;i++)await pause(5);
  assert(values.some(v=>v.phase==='thinking'));link.stop();resolveLate();await pause(15);assert(!values.some(v=>v.phase==='working'));
});
