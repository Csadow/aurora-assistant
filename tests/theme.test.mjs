import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { linuxTheme } from '../src/theme.mjs';
test('Linux palette and fonts follow generated shell settings and update with wallpaper changes',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aster-theme-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const generated=join(dir,'.local/state/quickshell/user/generated'),settings=join(dir,'.config/illogical-impulse');await mkdir(generated,{recursive:true});await mkdir(settings,{recursive:true});
  await writeFile(join(generated,'colors.json'),JSON.stringify({surface:'#181820',on_surface:'#efefff',primary:'#ffaaaa'}));await writeFile(join(settings,'config.json'),JSON.stringify({appearance:{fonts:{main:'Google Sans Flex',monospace:'JetBrains Mono NF'}}}));
  const before=await linuxTheme(dir);assert.equal(before.variables['--bg'],'#181820');assert.equal(before.font,'Google Sans Flex');assert.equal(before.scheme,'dark');
  await writeFile(join(generated,'colors.json'),JSON.stringify({surface:'#fafafa',on_surface:'#222222',primary:'#553388'}));const after=await linuxTheme(dir);assert.equal(after.scheme,'light');assert.notEqual(before.revision,after.revision);
});
test('missing or malformed theme input falls back without injecting CSS',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aster-theme-'));t.after(()=>rm(dir,{recursive:true,force:true}));const baseline=await linuxTheme(dir);assert.equal(baseline.name,'Aurora dark');
  const settings=join(dir,'.config/illogical-impulse');await mkdir(settings,{recursive:true});await writeFile(join(settings,'config.json'),JSON.stringify({appearance:{fonts:{main:'evil; background:url(https://evil.test)'}}}));assert.doesNotMatch((await linuxTheme(dir)).css,/evil/);
});
