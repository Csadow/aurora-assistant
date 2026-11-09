import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Vault} from '../src/vault.mjs';
import {Store} from '../src/store.mjs';
import {readView,freshReads} from '../src/read-view.mjs';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'aurora-read-view-'));t.after(()=>rm(dir,{force:true,recursive:true}));const vault=new Vault(join(dir,'vault')),store=new Store(join(dir,'data'));await vault.init();await store.init();await vault.save('40 Tasks/View.md','# Original',null);return {dir,vault,store};}
test('a render reuses a stable list, isolates consumer annotations and sees external edits on the next render',async t=>{
 const {vault}=await fixture(t);let calls=0;const read=vault.readList.bind(vault);vault.readList=async()=>{calls++;return read();};await readView(async()=>{const a=await vault.list();a.find(n=>n.path==='40 Tasks/View.md').content='Consumer annotation';await writeFile(await vault.safe('40 Tasks/View.md'),'# External edit');const b=await vault.list();assert.equal(b.find(n=>n.path==='40 Tasks/View.md').content,'# Original');assert.equal(calls,1);});assert.equal((await readView(()=>vault.list())).find(n=>n.path==='40 Tasks/View.md').content,'# External edit');assert.equal(calls,2);
});
test('writes inside an overview invalidate lists and run commit checks with fresh disk observations',async t=>{
 const {vault,store}=await fixture(t),id=randomUUID();await readView(async()=>{const before=(await vault.list()).find(n=>n.path==='40 Tasks/View.md');await store.list('proposals');await store.put('proposals',{id,created:new Date().toISOString(),status:'pending'});assert.equal((await store.list('proposals')).length,1);await assert.rejects(vault.save(before.path,'# Proposed',before.revision,{beforeCommit:async()=>{await vault.list();await writeFile(await vault.safe(before.path),'# Boundary edit');assert.equal((await vault.list()).find(n=>n.path===before.path).content,'# Boundary edit');throw Error('Detected external edit');}}),/Detected/);assert.equal((await vault.list()).find(n=>n.path===before.path).content,'# Boundary edit');const n=await vault.read(before.path);await vault.trash(n.path,n.revision);assert.equal((await vault.list()).some(x=>x.path===n.path),false);});
});
test('overlapping views and rejected renders cannot share or retain stale lists',async t=>{
 const {vault}=await fixture(t);let release,ready;const gate=new Promise(r=>release=r),started=new Promise(r=>ready=r);const first=readView(async()=>{await vault.list();ready();await gate;assert.equal((await vault.list()).find(n=>n.path==='40 Tasks/View.md').content,'# Original');});await started;await writeFile(await vault.safe('40 Tasks/View.md'),'# New render');assert.equal((await readView(()=>vault.list())).find(n=>n.path==='40 Tasks/View.md').content,'# New render');release();await first;await assert.rejects(readView(async()=>{await vault.list();throw Error('Render failed');}),/failed/);await writeFile(await vault.safe('40 Tasks/View.md'),'# After failure');assert.equal((await vault.list()).find(n=>n.path==='40 Tasks/View.md').content,'# After failure');
});
test('fresh-read scope keeps source checks uncached and refreshes the enclosing render afterwards',async t=>{
 const {vault}=await fixture(t);await readView(async()=>{await vault.list();await freshReads(async()=>{await writeFile(await vault.safe('40 Tasks/View.md'),'# Changed');assert.equal((await vault.list()).find(n=>n.path==='40 Tasks/View.md').content,'# Changed');});assert.equal((await vault.list()).find(n=>n.path==='40 Tasks/View.md').content,'# Changed');});
});
