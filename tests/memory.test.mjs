import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Vault, markdown, chunks } from '../src/vault.mjs';
import { Memory } from '../src/memory.mjs';

test('hybrid retrieval caches chunks, indexes edits, drops deleted memory and falls back offline',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aster-semantic-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const vault=new Vault(join(dir,'vault'));await vault.init();const target=await vault.save('30 Knowledge/Quiet.md',markdown('Quiet','Forest walks and birdsong help me recover.'),null);
  let embedded=0,online=true;
  const ollama={status:async()=>({models:online?[{name:'test'}]:[]}),request:async(path,body)=>{embedded+=body.input.length;return Response.json({embeddings:body.input.map(text=>/Forest|outdoor|relax/i.test(text)?[1,0]:[0,1])});}};
  const memory=new Memory({vault,ollama,data:dir,model:'test'});
  assert((await memory.recall('outdoor relaxation')).some(n=>n.path===target.path));assert.equal(memory.mode,'hybrid');const first=embedded;
  await memory.recall('outdoor relaxation');assert.equal(embedded,first+1);
  const edited=await vault.save(target.path,markdown('Quiet','Forest walks help me recover. Updated detail.'),target.revision);
  await memory.recall('outdoor relaxation');assert.equal(embedded,first+3);
  await vault.trash(edited.path,edited.revision);assert(!(await memory.recall('outdoor relaxation')).some(n=>n.path===target.path));
  online=false;await memory.recall('assistant');assert.equal(memory.mode,'keyword');assert.match(memory.error,/unavailable/);
});
test('chunking does not silently drop the beginning of a long unbroken paragraph',()=>{
  const text='START secret lantern '+ 'long '.repeat(900)+' END';const split=chunks(text,1000);assert(split[0].startsWith('START secret'));assert(split.at(-1).endsWith('END'));assert(split.every(s=>s.length<=1000));
});
