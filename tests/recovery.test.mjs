import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('recovery bundle restores source, vault, state and avatar; rejects unsafe archives and live overwrite',async()=>{
  await promisify(execFile)('python3',[new URL('./recovery_test.py',import.meta.url).pathname],{timeout:30000});
});
