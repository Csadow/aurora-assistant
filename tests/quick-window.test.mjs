import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {QuickWindowSettings,quickBounds} from '../desktop/quick-window.mjs';
import {monitorArea} from '../desktop/placement.mjs';

test('Quick ask restores independent geometry and clamps it after a monitor disappears',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-quick-layout-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'quick-window.json'),settings=new QuickWindowSettings(file);await settings.init();
  await settings.remember({x:2040,y:-900,width:700,height:900},'external');
  const restarted=new QuickWindowSettings(file);await restarted.init();assert.deepEqual(restarted.value,settings.value);
  const area={x:-1280,y:30,width:1280,height:690};assert.deepEqual(quickBounds(restarted.value,area),{x:-700,y:30,width:700,height:690});
  await writeFile(file,JSON.stringify({width:99999,height:-12,position:{x:'wrong',y:0}}));
  const invalid=new QuickWindowSettings(file);await invalid.init();assert.deepEqual(invalid.value,{width:460,height:680,position:null});
});
test('placement uses scaled, rotated monitor work areas and fits small screens',()=>{
  const area=monitorArea({x:-1000,y:0,width:1920,height:1080,scale:1.5,transform:1,reserved:[10,30,10,20]});
  assert.deepEqual(area,{x:-990,y:30,width:700,height:1230});
  assert.deepEqual(quickBounds({width:460,height:680,position:null},{x:0,y:0,width:320,height:350}),{x:0,y:0,width:320,height:350});
});
