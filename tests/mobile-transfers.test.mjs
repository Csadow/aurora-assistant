import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Vault,sha} from '../src/vault.mjs';
import {MobileTransfers} from '../src/mobile-transfers.mjs';
import {emptyState,importBundle,readBundle,saveNote,exportBundle,queueRequest} from '../mobile/web/core.js';
async function setup(t){const dir=await mkdtemp(join(tmpdir(),'aurora-transfer-')),vault=new Vault(join(dir,'vault'));await vault.init();const options={vault,data:join(dir,'data')},transfers=new MobileTransfers(options);await transfers.init();t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,vault,transfers,options};}
const raw=notes=>JSON.stringify({format:'aurora-mobile-v1',notes,requests:[]});
async function mobile(t){const f=await setup(t);await f.vault.save('Project.md','# Original',null);const ex=await f.transfers.export(['Project.md']),phone=emptyState();importBundle(phone,readBundle(JSON.stringify(ex.bundle)));return {...f,ex,phone};}
const decide=(transfers,plan,row,choice)=>transfers.decide({id:plan.id,rowId:row.id,digest:plan.digest,choice});

test('desktop export records only selected baselines; mobile preserves them across edits and backups',async t=>{
  const {phone,ex,dir}=await mobile(t);assert.equal(phone.notes.length,1);assert.equal(phone.notes[0].desktop.exportId,ex.id);
  saveNote(phone,'Project.md','# Phone',phone.notes[0].revision);
  assert.deepEqual(readBundle(exportBundle(phone)).notes[0].desktop,{exportId:ex.id,revision:sha('# Original')});
  const record=JSON.parse(await readFile(join(dir,'data/mobile-transfers/exports',ex.id+'.json'),'utf8'));assert.deepEqual(record.notes,[{path:'Project.md',revision:sha('# Original')}]);assert(!JSON.stringify(record).includes('# Original'));
});
test('reviewed phone update changes only an unchanged desktop baseline and keeps note history',async t=>{
  const {phone,vault,transfers}=await mobile(t);saveNote(phone,'Project.md','# Phone edit',phone.notes[0].revision);
  const plan=await transfers.prepare(exportBundle(phone));assert.equal(plan.rows[0].kind,'update');assert.equal((await vault.read('Project.md')).content,'# Original');
  await decide(transfers,plan,plan.rows[0],'save');await decide(transfers,plan,plan.rows[0],'save');assert.equal((await vault.read('Project.md')).content,'# Phone edit');assert.equal((await vault.history('Project.md')).length,1);
});
test('desktop-only changes and deletions survive return of unchanged phone notes',async t=>{
  const {phone,vault,transfers}=await mobile(t);let n=await vault.read('Project.md');n=await vault.save(n.path,'# Desktop edit',n.revision);
  assert.equal((await transfers.prepare(exportBundle(phone))).rows[0].kind,'keep');await vault.trash(n.path,n.revision);
  const plan=await transfers.prepare(exportBundle(phone));assert.equal(plan.rows[0].kind,'keep');await assert.rejects(decide(transfers,plan,plan.rows[0],'save'));await assert.rejects(vault.read(n.path),e=>e.status===404);
});
test('concurrent edits keep both versions and deterministic copies make repeat imports idempotent',async t=>{
  const {phone,vault,transfers}=await mobile(t);saveNote(phone,'Project.md','# Phone edit',phone.notes[0].revision);const n=await vault.read('Project.md');await vault.save(n.path,'# Desktop edit',n.revision);
  const plan=await transfers.prepare(exportBundle(phone));assert.equal(plan.rows[0].kind,'conflict');await assert.rejects(decide(transfers,plan,plan.rows[0],'save'));
  await decide(transfers,plan,plan.rows[0],'copy');assert.equal((await vault.read(n.path)).content,'# Desktop edit');assert.equal((await vault.read(plan.rows[0].copyPath)).content,'# Phone edit');
  const repeat=await transfers.prepare(exportBundle(phone));const result=await decide(transfers,repeat,repeat.rows[0],'copy');assert.equal(result.rows[0].result.status,'already-present');assert.equal((await vault.list()).filter(n=>n.path===plan.rows[0].copyPath).length,1);
});
test('edited conflict copies and changed-after-preview destinations are never overwritten',async t=>{
  const {phone,vault,transfers}=await mobile(t);saveNote(phone,'Project.md','# Phone',phone.notes[0].revision);
  const plan=await transfers.prepare(exportBundle(phone)),n=await vault.read('Project.md');await vault.save(n.path,'# Late edit',n.revision);await assert.rejects(decide(transfers,plan,plan.rows[0],'save'),e=>e.status===409);
  const conflict=await transfers.prepare(exportBundle(phone));await decide(transfers,conflict,conflict.rows[0],'copy');const copy=await vault.read(conflict.rows[0].copyPath);await vault.save(copy.path,'# Edited copy',copy.revision);
  const repeat=await transfers.prepare(exportBundle(phone));await assert.rejects(decide(transfers,repeat,repeat.rows[0],'copy'),e=>e.status===409);assert.equal((await vault.read(copy.path)).content,'# Edited copy');
});
test('legacy and fabricated baselines fall back to explicit conflict copies',async t=>{
  const {vault,transfers}=await setup(t);await vault.save('N.md','Desktop',null);
  for(const desktop of [undefined,{exportId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',revision:sha('Desktop')}]){
    const p=await transfers.prepare(raw([{path:'N.md',content:'Mobile',...(desktop?{desktop}:{})}]));assert.equal(p.rows[0].kind,'conflict');
  }
  const p=await transfers.prepare(raw([{path:'New.md',content:'New'}]));assert.equal(p.rows[0].kind,'create');await decide(transfers,p,p.rows[0],'save');
});
test('a changed phone note does not resurrect a deleted desktop original',async t=>{
  const {phone,vault,transfers}=await mobile(t);saveNote(phone,'Project.md','# Mobile change',phone.notes[0].revision);const n=await vault.read('Project.md');await vault.trash(n.path,n.revision);
  const p=await transfers.prepare(exportBundle(phone));assert.equal(p.rows[0].kind,'conflict');await decide(transfers,p,p.rows[0],'copy');await assert.rejects(vault.read(n.path),e=>e.status===404);
});
test('laptop requests become deduplicated draft notes; chat and cancelled requests are excluded',async t=>{
  const {vault,transfers}=await setup(t),phone=emptyState();queueRequest(phone,'Fix the project','laptop');queueRequest(phone,'Private chat');const cancelled=queueRequest(phone,'Cancelled task','laptop');cancelled.status='cancelled';
  const p=await transfers.prepare(exportBundle(phone));assert.equal(p.rows.length,1);assert.equal(p.ignoredRequests,2);assert.equal(p.rows[0].type,'request');await decide(transfers,p,p.rows[0],'save');
  const note=await vault.read(p.rows[0].path);assert.equal(note.status,'draft');assert.match(note.content,/unstarted request/);
  const second=await transfers.prepare(exportBundle(phone));assert.equal(second.rows[0].kind,'keep');assert.equal((await transfers.list()).length,2);
});
test('interrupted save reconciles after restart without repeating the write',async t=>{
  const {phone,vault,transfers,options}=await mobile(t);saveNote(phone,'Project.md','# Mobile',phone.notes[0].revision);const p=await transfers.prepare(exportBundle(phone));transfers.afterWrite=()=>{throw Error('simulated crash after write');};
  await assert.rejects(decide(transfers,p,p.rows[0],'save'),e=>e.status===500&&/may already/.test(e.message));assert.equal((await vault.read('Project.md')).content,'# Mobile');
  const restarted=new MobileTransfers(options);await restarted.init();const review=await restarted.review(p.id);assert(review.rows[0].intent);await assert.rejects(decide(restarted,review,review.rows[0],'skip'),e=>e.status===409);
  const result=await decide(restarted,review,review.rows[0],'save');assert.equal(result.rows[0].result.status,'already-present');assert.equal((await vault.history('Project.md')).length,1);
});
test('concurrent decisions and stale review tokens cannot duplicate or replace saves',async t=>{
  const {vault,transfers}=await setup(t),p=await transfers.prepare(raw([{path:'N.md',content:'Reviewed'}]));
  await assert.rejects(transfers.decide({id:p.id,rowId:p.rows[0].id,digest:'wrong',choice:'save'}),e=>e.status===409);
  await Promise.all([decide(transfers,p,p.rows[0],'save'),decide(transfers,p,p.rows[0],'save')]);assert.equal((await vault.history('N.md')).length,0);
  await assert.rejects(decide(transfers,p,p.rows[0],'skip'),e=>e.status===409);
});
test('unsafe imports, symlink destinations and invalid metadata fail before writes',async t=>{
  const {dir,vault,transfers}=await setup(t);await writeFile(join(dir,'outside.md'),'Secret');await symlink(join(dir,'outside.md'),join(vault.root,'Link.md'));
  await assert.rejects(transfers.prepare(raw([{path:'../outside.md',content:'Bad'}])));await assert.rejects(transfers.prepare(raw([{path:'Link.md',content:'Bad'}])));
  await assert.rejects(transfers.prepare(raw([{path:'N.md',content:'Bad',desktop:{exportId:'../../anything',revision:'bad'}}])));
  assert.equal(await readFile(join(dir,'outside.md'),'utf8'),'Secret');assert.deepEqual(await transfers.list(),[]);
});
test('export records and reviews from another vault cannot authorize an update',async t=>{
  const {transfers,ex,options}=await mobile(t),other=new Vault(join(options.data,'other-vault'));await other.init();await other.save('Project.md','# Original',null);
  const alternate=new MobileTransfers({...options,vault:other});await alternate.init();ex.bundle.notes[0].content='Changed';const p=await alternate.prepare(JSON.stringify(ex.bundle));assert.equal(p.rows[0].kind,'conflict');
  await assert.rejects(transfers.review(p.id),e=>e.status===409);
});
test('small incoming backups cannot create unbounded comparisons against large desktop notes',async t=>{
  const {vault,transfers}=await setup(t),notes=[];
  for(let i=0;i<18;i++){const path=`Large ${i}.md`;await vault.save(path,'x'.repeat(490000),null);notes.push({path,content:'Small phone edit'});}
  await assert.rejects(transfers.prepare(raw(notes)),e=>e.status===413);assert.deepEqual(await transfers.list(),[]);assert.equal((await vault.read('Large 0.md')).content.length,490000);
});
