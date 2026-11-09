import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {emptyState,saveNote,queueRequest,updateRequest,recover,prepareRequest,parseReply,readBundle,importBundle,exportBundle,searchNotes,notePath} from '../mobile/web/core.js';

test('mobile memory is Markdown, Unicode-searchable, and protected from stale edits',()=>{
  const s=emptyState(),n=saveNote(s,'60 Inbox/Идея.md','# Идея\nҚазақша [[Projects]]',null);
  assert.equal(searchNotes(s,'қазақша идея')[0].path,n.path);
  const next=saveNote(s,n.path,'# Updated',n.revision);assert.notEqual(next.revision,n.revision);
  assert.throws(()=>saveNote(s,n.path,'stale',n.revision),/changed/);
  assert.equal(s.notes[0].content,'# Updated');
});
test('mobile imports reject traversal, hidden files, invalid paths and oversized notes',()=>{
  for(const path of ['../x.md','/x.md','x/../y.md','.secret.md','x\\y.md','x//y.md','x.txt','x/ y.md','x\u0000.md'])assert.throws(()=>notePath(path));
  const s=emptyState();assert.throws(()=>saveNote(s,'x.md','x'.repeat(200001),null));
  assert.throws(()=>readBundle(JSON.stringify({format:'aurora-mobile-v1',notes:[{path:'../x.md',content:'bad'}],requests:[]})));
});
test('offline requests cannot execute laptop actions or automatically resume interrupted sends',()=>{
  const s=emptyState(),laptop=queueRequest(s,'Open my project','laptop');
  assert.throws(()=>updateRequest(s,laptop.id,'sending'),/not configured/);
  const chat=queueRequest(s,'What next?');updateRequest(s,chat.id,'sending');recover(s);
  assert.equal(chat.status,'uncertain');assert.match(chat.answer,/may have processed/);
  updateRequest(s,chat.id,'cancelled');assert.throws(()=>updateRequest(s,chat.id,'sending'));
});
test('cloud preview includes only selected memory and earlier completed exchanges',()=>{
  const s=emptyState();saveNote(s,'Secret.md','DO NOT SEND',null);saveNote(s,'Project.md','Project reference',null);
  const done=queueRequest(s,'Earlier');updateRequest(s,done.id,'sending');updateRequest(s,done.id,'answered','Earlier answer');
  queueRequest(s,'Unsent private draft');const request=queueRequest(s,'Current');
  const later=queueRequest(s,'Later');updateRequest(s,later.id,'sending');updateRequest(s,later.id,'answered','Future answer');
  const preview=prepareRequest(s,request.id,['Project.md']);const serialized=JSON.stringify(preview);
  assert.match(serialized,/Project reference/);assert.match(serialized,/Earlier answer/);
  for(const hidden of ['DO NOT SEND','Unsent private draft','Future answer'])assert(!serialized.includes(hidden));
  assert.equal(preview.payload.contents.length,3);assert.equal(preview.payload.generationConfig.maxOutputTokens,2048);
  const frozen=JSON.stringify(preview);s.notes[1].content='Changed after review';assert.equal(JSON.stringify(preview),frozen);
});
test('cloud context is bounded and missing memory/model IDs fail closed',()=>{
  const s=emptyState(),r=queueRequest(s,'Question');
  saveNote(s,'Long.md','x'.repeat(18001),null);assert.throws(()=>prepareRequest(s,r.id,['Long.md']),/18,000/);
  assert.throws(()=>prepareRequest(s,r.id,['Missing.md']),/no longer/);
  s.model='https://other.example';assert.throws(()=>prepareRequest(s,r.id),/model ID/);
});
test('only complete non-thinking Gemini text is accepted as an answer',()=>{
  assert.equal(parseReply({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'hidden'},{text:'Answer'}]}}]}),'Answer');
  for(const finishReason of ['MAX_TOKENS','SAFETY','RECITATION',undefined])assert.throws(()=>parseReply({candidates:[{finishReason,content:{parts:[{text:'Partial'}]}}]}));
  assert.throws(()=>parseReply({candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:'run'}}]}}]}));
});
test('backup imports preserve conflicting notes and are idempotent',()=>{
  const s=emptyState();saveNote(s,'Project.md','Current version',null);
  const other=emptyState();saveNote(other,'Project.md','Other version',null);queueRequest(other,'Offline request');
  const bundle=readBundle(exportBundle(other));
  assert.deepEqual(importBundle(s,bundle),{added:1,conflicts:1,requests:1});assert.equal(s.notes[0].content,'Current version');
  assert.equal(s.notes[1].content,'Other version');assert.match(s.notes[1].path,/import 1/);
  assert.deepEqual(importBundle(s,bundle),{added:0,conflicts:0,requests:0});
  assert(!exportBundle(s).includes('model'));assert(!exportBundle(s).includes('draft'));
});
test('backup validation refuses duplicate IDs and paths; imported in-flight requests require review',()=>{
  const s=emptyState(),r=queueRequest(s,'Pending');updateRequest(s,r.id,'sending');
  const bundle=readBundle(exportBundle(s));assert.equal(bundle.requests[0].status,'uncertain');
  s.requests.push({...r});assert.throws(()=>readBundle(exportBundle(s)),/invalid request/);
  const t=emptyState();saveNote(t,'N.md','text',null);t.notes.push({...t.notes[0]});assert.throws(()=>readBundle(exportBundle(t)),/duplicate/);
});
test('conflicting request import is atomic even without a storage transaction',()=>{
  const s=emptyState(),r=queueRequest(s,'Original');const before=JSON.stringify(s);
  assert.throws(()=>importBundle(s,{notes:[{path:'N.md',content:'New'}],requests:[{...r,text:'Changed'}]}),/cancelled/);
  assert.equal(JSON.stringify(s),before);
});
test('desktop transfer exports only explicitly selected notes and refuses overwrite',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-mobile-export-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const vault=join(dir,'vault');await mkdir(vault);await writeFile(join(vault,'Selected.md'),'# Selected\nPortable');await writeFile(join(vault,'Private.md'),'Never exported');
  const output=join(dir,'transfer.json'),execFile=promisify(execFileCallback),script=new URL('../scripts/mobile-memory-export.mjs',import.meta.url).pathname;
  const options={env:{...process.env,AURORA_VAULT:vault,AURORA_DATA:join(dir,'data')}};
  await execFile(process.execPath,[script,output,'Selected.md'],options);
  const bundle=readBundle(await readFile(output,'utf8'));assert.deepEqual(bundle.notes.map(({desktop,...n})=>n),[{path:'Selected.md',content:'# Selected\nPortable'}]);assert(bundle.notes[0].desktop.exportId);assert.deepEqual(bundle.requests,[]);
  assert.equal((await stat(output)).mode&0o777,0o600);
  await assert.rejects(execFile(process.execPath,[script,output,'Private.md'],options));
  await assert.rejects(execFile(process.execPath,[script,join(dir,'bad.json'),'../Private.md'],options));
});
