import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readHyprland,relativeCursor,cursorSource,CompanionCursor} from '../desktop/cursor.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('cursor conversion keeps off-window positions and logical monitor offsets',()=>{
  const bounds={x:-1200,y:200,width:400,height:800};
  assert.deepEqual(relativeCursor({x:-1000,y:400},bounds),{x:.5,y:.25});
  assert.deepEqual(relativeCursor({x:0,y:0},bounds),{x:3,y:-.25});
  assert.equal(relativeCursor({x:NaN,y:0},bounds),null);
  assert.equal(relativeCursor({x:0,y:0},{...bounds,width:0}),null);
});
test('Hyprland cursor uses the current process and refreshes resized or moved bounds',async()=>{
  let at=[100,200],size=[400,800],title='Aurora · Overlay';const calls=[];
  const source=cursorSource({hyprland:true,env:{XDG_RUNTIME_DIR:'/tmp',HYPRLAND_INSTANCE_SIGNATURE:'fixture'},read:async command=>{
    calls.push(command);return command==='cursorpos'?{x:300,y:400}:[{pid:process.pid+1,title,at:[0,0],size},{pid:process.pid,title,at,size}];
  }});
  const window={getTitle:()=>title};assert.deepEqual(await source(window),{x:.5,y:.25});
  await source(window);assert.deepEqual(calls,['clients','cursorpos','cursorpos']);
  title='Aurora · Arrange';at=[-100,0];size=[800,800];assert.deepEqual(await source(window),{x:.5,y:.5});
  assert.equal(await cursorSource({hyprland:false,env:{WAYLAND_DISPLAY:'wayland-1'}})(window),null);
});
test('cursor socket handles split replies, invalid JSON, stalled queries and cancellation',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-cursor-')),socketPath=join(dir,'socket');let mode='valid';const peers=new Set();
  const server=createServer(socket=>{peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{});socket.on('data',query=>{
    assert.equal(String(query),'j/cursorpos');
    if(mode==='valid'){socket.write('{"x":5,');setTimeout(()=>socket.end('"y":6}'),5);}
    if(mode==='bad')socket.end('invalid');
  });});
  t.after(async()=>{for(const socket of peers)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  await new Promise(resolve=>server.listen(socketPath,resolve));
  assert.deepEqual(await readHyprland('cursorpos',{socketPath}),{x:5,y:6});
  mode='bad';await assert.rejects(readHyprland('cursorpos',{socketPath}),SyntaxError);
  mode='stall';await assert.rejects(readHyprland('cursorpos',{socketPath,timeout:20}),/timed out/);
  const controller=new AbortController(),pending=readHyprland('cursorpos',{socketPath,signal:controller.signal});controller.abort();await assert.rejects(pending,/abort/i);
  assert.throws(()=>readHyprland('dispatch',{socketPath}),/Unsupported/);
});
test('hidden companion stops polling and discards outstanding cursor updates; showing resumes',async()=>{
  const sent=[];let samples=0,release,active=true;
  const tracker=new CompanionCursor({interval:5,active:()=>active,send:point=>sent.push(point),sample:async()=>{samples++;return new Promise(resolve=>{release=resolve;});}});
  tracker.start();tracker.start();assert.equal(samples,1);await pause(15);assert.equal(samples,1);
  active=false;tracker.stop();release({x:1,y:1});await pause(10);assert.equal(sent.length,0);assert.equal(samples,1);
  active=true;tracker.start();assert.equal(samples,2);release({x:0,y:0});await pause(1);assert.deepEqual(sent,[{x:0,y:0}]);tracker.stop();
});
