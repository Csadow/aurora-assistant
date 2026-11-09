import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {atomic} from '../src/vault.mjs';

test('durable replacement preserves the old file on cancellation or failed validation and cleans staging files',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-atomic-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'record.json');await atomic(path,'original',{mode:0o640});
  await assert.rejects(atomic(path,'invalid',{beforeCommit:()=>{throw new Error('File changed');}}),/File changed/);
  assert.equal(await readFile(path,'utf8'),'original');
  const controller=new AbortController();
  await assert.rejects(atomic(path,'cancelled',{signal:controller.signal,beforeCommit:()=>controller.abort()}),e=>e.name==='AbortError');
  assert.equal(await readFile(path,'utf8'),'original');assert.deepEqual(await readdir(dir),['record.json']);
  await atomic(path,'replacement',{mode:0o640});assert.equal(await readFile(path,'utf8'),'replacement');
  assert.equal((await stat(path)).mode&0o777,0o640);assert.deepEqual(await readdir(dir),['record.json']);
});
