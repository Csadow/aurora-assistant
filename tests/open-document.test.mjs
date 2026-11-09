import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {documentOpener,openDocument} from '../desktop/open-document.mjs';
import {DesktopComputer} from '../desktop/computer.mjs';

const entry='[Desktop Entry]\nType=Application\nExec=nvim %F\nTerminal=true\n';
const fixture={execute:async(_cmd,args)=>({stdout:args[1]==='filetype'?'text/plain\n':'nvim.desktop\n'}),read:async()=>entry,check:async()=>{}};
test('terminal default editor receives an exact file argument in a visible Linux terminal',async()=>{
  const path='/home/test/notes/$(touch BAD); `echo BAD` file.txt',opener=await documentOpener(path,fixture);
  assert.equal(opener.kind,'terminal');assert.equal(opener.command,'/usr/bin/foot');
  assert.deepEqual(opener.args.slice(-3),['/usr/bin/nvim','--',path]);
  let launched;
  const result=await openDocument(path,opener,undefined,{launch:(...args)=>{launched=args;const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;}});
  assert.deepEqual(launched,[opener.command,opener.args,{detached:true,stdio:'ignore'}]);assert.match(result.content,/Inspect windows/);
});
test('document opening honors GUI/custom commands and repairs mislabeled terminal editor entries',async()=>{
  assert.equal((await documentOpener('/tmp/document.txt',{...fixture,read:async()=>entry.replace('Terminal=true','Terminal=false')})).kind,'terminal');
  for(const raw of [entry.replace('nvim %F','nvim --custom %F'),entry.replace('nvim %F','nvim %F; touch BAD')])assert.deepEqual(await documentOpener('/tmp/document.txt',{...fixture,read:async()=>raw}),{kind:'default',handler:'nvim.desktop'});
  assert.deepEqual(await documentOpener('/tmp/document.txt',{...fixture,execute:async()=>({stdout:'not-a-mime\n'})}),{kind:'default'});
  let opened;await openDocument('/tmp/document.pdf',{kind:'default'},undefined,{openPath:async path=>{opened=path;return '';}});assert.equal(opened,'/tmp/document.pdf');
  await assert.rejects(openDocument('/tmp/a',{kind:'default'},undefined,{openPath:async()=> 'Application failed'}),/Application failed/);
});
test('missing terminals, spawn failures and cancellation are reported without a headless editor',async()=>{
  const check=async path=>{if(path!=='/usr/bin/nvim')throw new Error('missing');};
  await assert.rejects(documentOpener('/tmp/a.txt',{...fixture,check}),/needs a terminal/);
  const opener=await documentOpener('/tmp/a.txt',fixture);
  await assert.rejects(openDocument('/tmp/a.txt',opener,AbortSignal.abort(),{launch:()=>assert.fail('must not launch')}),{name:'AbortError'});
  await assert.rejects(openDocument('/tmp/a.txt',opener,undefined,{launch:()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('error',new Error('spawn failed')));return child;}}),/spawn failed/);
});
test('a changed default application invalidates a prepared document action',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-document-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'review.txt');await writeFile(path,'Review');
  let handler='org.example.Editor.desktop';const desktop=new DesktopComputer({data:join(dir,'data'),home:dir,browser:{},execute:async(_cmd,args)=>({stdout:args[1]==='filetype'?'text/plain':handler})});
  const prepared=await desktop.prepare({operation:'open_path',path});
  handler='org.example.OtherEditor.desktop';
  await assert.rejects(desktop.executeAction(prepared),/default application changed/);
});
