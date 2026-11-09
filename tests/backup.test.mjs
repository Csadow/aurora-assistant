import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backup } from '../scripts/backup.mjs';

test('backup can restore Markdown, note history and conversations',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aster-backup-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const vault=join(dir,'My Vault'),data=join(dir,'app-state'),destination=join(dir,'backups');
  await mkdir(join(vault,'.aster/history'),{recursive:true});await mkdir(data);
  await writeFile(join(vault,'Memory.md'),'# Memory\nSomething important.');await writeFile(join(vault,'.aster/history','revision.md'),'Old memory.');await writeFile(join(data,'conversation.json'),'{"content":"hello"}');
  await mkdir(join(data,'followups'));await writeFile(join(data,'followups/draft.json'),'{"status":"creating","childId":"reserved-child"}');
  await mkdir(join(data,'task-workflows'));await writeFile(join(data,'task-workflows/link.json'),'{"childId":"reserved-child","review":{"status":"pending","intent":{"afterRevision":"saved-note"}}}');
  const attemptState={childId:'second',attempts:[{workflowId:'first',number:1},{workflowId:'second',number:2}],attachment:{id:'review',status:'pending',sourceId:'second',targetId:'third',linkRevision:2},reviewHistory:[{workflowId:'first',status:'discarded'}]};await writeFile(join(data,'task-workflows/attempts.json'),JSON.stringify(attemptState));
  await writeFile(join(data,'google-calendar-auth.json'),'oauth-token-must-not-be-backed-up');
  await writeFile(join(data,'google-calendar-auth.json.old'),'old-oauth-token');
  await writeFile(join(data,'chatgpt-plan-auth.json'),'chatgpt-refresh-must-not-be-backed-up');
  await writeFile(join(data,'chatgpt-plan-auth.json.old'),'old-chatgpt-refresh');
  await writeFile(join(data,'integrations.json'),'{"apiKey":"test-secret-must-not-be-backed-up"}');
  await writeFile(join(data,'integrations.json.rotation.tmp'),'temporary-secret');await writeFile(join(data,'integrations.json.old'),'old-secret');
  let privateAtCreation=false;
  const archive=await backup({vault,data,destination,spawnImpl:(program,args,options)=>{privateAtCreation=(fstatSync(options.stdio[1]).mode&0o777)===0o600;return spawn(program,args,options);}});assert(privateAtCreation);assert.equal((await stat(archive)).mode&0o777,0o600);const restore=join(dir,'restore');await mkdir(restore);
  await promisify(execFile)('tar',['-xzf',archive,'-C',restore]);
  assert.match(await readFile(join(restore,'My Vault/Memory.md'),'utf8'),/Something important/);assert.equal(await readFile(join(restore,'My Vault/.aster/history/revision.md'),'utf8'),'Old memory.');assert.match(await readFile(join(restore,'app-state/conversation.json'),'utf8'),/hello/);
  assert.deepEqual(JSON.parse(await readFile(join(restore,'app-state/followups/draft.json'),'utf8')),{status:'creating',childId:'reserved-child'});
  assert.deepEqual(JSON.parse(await readFile(join(restore,'app-state/task-workflows/link.json'),'utf8')),{childId:'reserved-child',review:{status:'pending',intent:{afterRevision:'saved-note'}}});
  assert.deepEqual(JSON.parse(await readFile(join(restore,'app-state/task-workflows/attempts.json'),'utf8')),attemptState);
  for(const name of ['integrations.json','integrations.json.rotation.tmp','integrations.json.old','google-calendar-auth.json','google-calendar-auth.json.old','chatgpt-plan-auth.json','chatgpt-plan-auth.json.old'])await assert.rejects(()=>readFile(join(restore,'app-state',name)),e=>e.code==='ENOENT');
});

import { fstatSync } from 'node:fs';
import { Backups } from '../src/backups.mjs';
test('backup failures remove partial archives and nested destinations are rejected',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aster-backup-failure-'));t.after(()=>rm(dir,{recursive:true,force:true}));const options={vault:join(dir,'vault'),data:join(dir,'state'),destination:join(dir,'backups')};await mkdir(options.vault);await mkdir(options.data);
  await assert.rejects(backup({...options,spawnImpl:()=>spawn('/usr/bin/false',[],{stdio:['ignore','ignore','pipe']})}),/Backup failed/);assert.deepEqual(await readdir(options.destination),[]);
  await assert.rejects(backup({...options,destination:join(options.vault,'backups')}),/outside/);
});
test('backup manager rejects overlapping work and cleans up cancelled archives',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aster-backup-stop-'));t.after(()=>rm(dir,{recursive:true,force:true}));let spawned;const ready=new Promise(r=>spawned=r);const options={vault:join(dir,'vault'),data:join(dir,'state'),destination:join(dir,'backups')};await mkdir(options.vault);await mkdir(options.data);
  const backups=new Backups({...options,spawnImpl:()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore','pipe']});spawned();return child;}});
  const pending=backups.create();const rejected=assert.rejects(pending,e=>e.name==='AbortError');await ready;await assert.rejects(backups.create(),e=>e.status===409);backups.stop();await rejected;assert.equal(backups.running,false);assert.deepEqual(await readdir(options.destination),[]);
  backups.options=options;const saved=await backups.create();const list=await backups.list();assert.equal(list[0].path,saved.path);assert.equal(list[0].private,true);
});

test('recovery ZIPs remain visible in the backup history after reopening Settings',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-backup-list-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'aurora-recovery-20261003T100000Z-fixture.zip'),'fixture',{mode:0o600});
  await writeFile(join(dir,'aurora-recovery-incomplete.partial'),'incomplete');
  const list=await new Backups({destination:dir}).list();assert.equal(list.length,1);assert.equal(list[0].kind,'recovery');assert.equal(list[0].private,true);
});
