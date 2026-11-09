import {fixtureSpeech} from './speech-smoke.mjs';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {BrowserWindow,app} from 'electron';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hyprland,desktopWindow,monitorArea,placeDesktopWindow} from './placement.mjs';
export async function smoke({win,avatars,backend,speech}){
  fixtureSpeech(speech);
  const report={ok:false,date:new Date().toISOString(),checks:[],model:await avatars.status()};
  const wait=async(fn,label)=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timeout: '+label);};
  const pause=ms=>new Promise(r=>setTimeout(r,ms)),w=js=>win.webContents.executeJavaScript(js,true);
  const bounds=async window=>hyprland?(await desktopWindow(window.getTitle()))?.bounds:window.getBounds();
  const geometry=async window=>{
    if(!hyprland)return;
    await wait(async()=>{const b=await bounds(window);return b&&b.width===window.getSize()[0]&&b.height===window.getSize()[1];},'native and compositor sizes agree');
    const placed=await desktopWindow(window.getTitle()),area=monitorArea(placed.monitor),b=placed.bounds;
    assert(placed.client.floating&&placed.client.pinned);assert(b.x>=area.x&&b.y>=area.y);assert(b.x+b.width<=area.x+area.width);assert(b.y+b.height<=area.y+area.height);
    (report.compositor??=[]).push({title:window.getTitle(),...b});return b;
  };
  await wait(()=>w('document.body.dataset.ready==="true"'),'workspace ready');await w('window.asterDesktop.companion("show")');
  const companion=BrowserWindow.getAllWindows().find(v=>v.webContents.getURL().endsWith('/companion.html')),c=js=>companion.webContents.executeJavaScript(js,true);
  await wait(()=>c('document.body.dataset.avatar==="ready"'),'real Live2D model render');
  assert.equal(await c('getComputedStyle(document.querySelector("#builtin-avatar")).display'),'none');assert.equal(await c('document.querySelector("#avatar-expression").options.length'),11);
  const frame=companion.webContents.mainFrame.framesInSubtree.find(f=>f.url.startsWith('aster://avatar/'));assert(frame);assert.equal(await frame.executeJavaScript('document.body.dataset.ready'),'true');assert.equal(await frame.executeJavaScript('typeof window.asterDesktop'),'undefined');assert.equal(await frame.executeJavaScript('(()=>{try{return !!parent.document.body}catch{return false}})()'),false);assert.equal(await frame.executeJavaScript('fetch("aster://app/api/bootstrap").then(()=>true,()=>false)'),false);report.checks.push('supplied model loads with ten expressions in an isolated frame');
  await pause(800);assert(companion.getSize()[1]>=800);assert.equal(companion.getTitle(),'Aurora · Overlay');
  assert(await c('(()=>{const stage=document.querySelector("#avatar-stage").getBoundingClientRect();return stage.height>=innerHeight-2&&stage.width>=innerWidth-2&&["#companion-state",".companion-actions",".expression-control"].every(s=>document.querySelector(s).getClientRects().length===0)})()'));
  assert.equal(await c('getComputedStyle(document.documentElement).backgroundColor'),'rgba(0, 0, 0, 0)');assert.equal((await companion.webContents.capturePage({x:2,y:2,width:1,height:1})).toBitmap()[3],0);
  const originalModel=await geometry(companion);await writeFile(process.env.AURORA_TEST_REPORT+'.compact.png',(await companion.webContents.capturePage()).toPNG());report.checks.push('idle model fills a transparent surface without controls');
  const mouseModes=[],ignore=companion.setIgnoreMouseEvents.bind(companion);companion.setIgnoreMouseEvents=(value,...args)=>{mouseModes.push(value);return ignore(value,...args);};
  await c('window.asterDesktop.overlay("ready")');assert.equal(mouseModes.at(-1),true);
  // Observe real Cubism values at render time, not just delivered IPC messages.
  await frame.executeJavaScript(`(()=>{const proto=PIXI.live2d.Live2DModel.prototype,update=proto.update;let attached=false;proto.update=function(...args){if(!attached){attached=true;const m=this.internalModel;m.on('beforeModelUpdate',()=>{window.__gazeProbe={mouth:m.coreModel.getParameterValueById('ParamMouthOpenY'),x:m.focusController.x,y:m.focusController.y,eyeX:m.coreModel.getParameterValueById('ParamEyeBallX'),eyeY:m.coreModel.getParameterValueById('ParamEyeBallY'),headX:m.coreModel.getParameterValueById('ParamAngleX')};});}return update.apply(this,args);};})()`);
  const testGaze=async label=>{
    if(!hyprland)return;
    const run=promisify(execFile),saved=JSON.parse((await run('hyprctl',['cursorpos','-j'])).stdout);
    const placed=await desktopWindow(companion.getTitle()),area=monitorArea(placed.monitor),b=placed.bounds;
    const move=(x,y)=>run('hyprctl',['eval',`hl.dispatch(hl.dsp.cursor.move({x=${Math.round(x)},y=${Math.round(y)}}));`]);
    try{
      await move(area.x+10,b.y+b.height*.18);
      await wait(()=>frame.executeJavaScript('window.__gazeProbe?.x<-.3 && window.__gazeProbe?.eyeX<-.2 && window.__gazeProbe?.headX<-5'),'gaze left '+label);
      await move(area.x+area.width-10,b.y+b.height*.18);
      await wait(()=>frame.executeJavaScript('window.__gazeProbe?.x>.2 && window.__gazeProbe?.eyeX>.1 && window.__gazeProbe?.headX>3'),'gaze right '+label);
      await move(b.x+b.width*.5,area.y+10);
      await wait(()=>frame.executeJavaScript('window.__gazeProbe?.y>.1 && window.__gazeProbe?.eyeY>.05'),'gaze up '+label);
      await move(b.x+b.width*.5,area.y+area.height-10);
      await wait(()=>frame.executeJavaScript('window.__gazeProbe?.y<-.3 && window.__gazeProbe?.eyeY<-.2'),'gaze down '+label);
      assert.equal(mouseModes.at(-1),true);
      report.checks.push('real cursor drives Cubism eyes/head while click-through: '+label);
    }finally{await move(saved.x,saved.y);}
  };
  await testGaze('outside the companion window');
  await c('window.asterDesktop.companion("automatic-off")');
  await speech.say('Native mouth fixture');
  await wait(()=>frame.executeJavaScript('window.__gazeProbe?.mouth>.4'),'audio drives real mouth with automatic expressions off');
  assert.equal(await frame.executeJavaScript('document.body.dataset.mood'),'manual');
  await speech.stop();await wait(()=>frame.executeJavaScript('window.__gazeProbe?.mouth===0'),'Stop closes real mouth');
  // A lost IPC sender must not leave her mouth frozen open.
  companion.webContents.send('aster:mouth',{active:true,level:.8});await wait(()=>frame.executeJavaScript('window.__gazeProbe?.mouth>.6'),'mouth update accepted');
  await pause(400);await wait(()=>frame.executeJavaScript('window.__gazeProbe?.mouth===0'),'stale mouth update decays');
  await c('window.asterDesktop.companion("automatic-on")');
  report.checks.push('speech drives the actual Cubism mouth independently of expressions; Stop and stale frames close it');
  await w('window.asterDesktop.quick("open")');
  const quick=BrowserWindow.getAllWindows().find(v=>v.webContents.getURL().endsWith('/quick.html')),q=js=>quick.webContents.executeJavaScript(js,true);
  await wait(()=>q('document.body.dataset.ready==="true"'),'separate Quick ask ready');assert.notEqual(quick,companion);assert.equal(BrowserWindow.getAllWindows().length,3);
  assert.equal(await q('!!document.querySelector("#live2d-frame")'),false);assert.equal(mouseModes.at(-1),true);assert.equal(companion.getTitle(),'Aurora · Overlay');
  assert.deepEqual(await bounds(companion),originalModel);const originalQuick=await geometry(quick);
  await q('document.querySelector("#quick-input").value="Hello Aurora";document.querySelector("#quick-form").requestSubmit()');await wait(()=>q('document.querySelector("#quick-result").textContent.includes("Desktop connection is working")'),'independent chat');
  assert.equal(companion.webContents.mainFrame.framesInSubtree.find(f=>f.url.startsWith('aster://avatar/')),frame);report.checks.push('Quick ask has its own native window; opening and chatting leave model placement, click-through, and loaded frame intact');
  await pause(200);await writeFile(process.env.AURORA_TEST_REPORT+'.chat.png',(await quick.webContents.capturePage()).toPNG());
  await q('document.querySelector("#quick-input").value="An independent draft";document.querySelector("#quick-input").dispatchEvent(new Event("input"));document.querySelector("#quick-close").click()');await wait(()=>!quick.isVisible(),'close chat');assert(companion.isVisible());assert(avatars.config.visible);assert.equal(mouseModes.at(-1),true);
  await w('window.asterDesktop.quick("open")');assert.equal(await q('document.querySelector("#quick-input").value'),'An independent draft');await q('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))');await wait(()=>!quick.isVisible(),'Escape hides chat');assert(companion.isVisible());
  await w('window.asterDesktop.quick("open")');await w('window.asterDesktop.companion("hide")');assert(!companion.isVisible());assert(quick.isVisible());await w('window.asterDesktop.quick("open")');assert(!companion.isVisible());await w('window.asterDesktop.companion("show")');assert(quick.isVisible());assert(companion.isVisible());assert.equal(await c('document.body.dataset.avatar'),'ready');report.checks.push('close, Escape, and model show/hide are independent; drafts and loaded model survive');
  await w('window.asterDesktop.overlay("arrange")');await wait(()=>c('document.body.dataset.arranging==="true"'),'arrange mode');assert.equal(mouseModes.at(-1),false);assert.equal(companion.getTitle(),'Aurora · Arrange');assert.deepEqual(await bounds(quick),originalQuick);
  for(const index of [0,-1,0,-1]){await c(`document.querySelector("#avatar-expression").value="${index}";document.querySelector("#avatar-expression").dispatchEvent(new Event("change"))`);await wait(()=>frame.executeJavaScript(`document.body.dataset.expression==="${index}"`),'expression '+index);}
  report.checks.push('expressions and neutral reset are available in the model’s own Arrange controls');
  await c('document.querySelector("#overlay-size").value="600";document.querySelector("#overlay-size").dispatchEvent(new Event("change"))');await wait(()=>companion.getSize()[1]===600,'resize model');await pause(500);
  const before=await w('window.asterDesktop.overlay("status")');assert.equal(before.height,600);assert(before.position);
  await c('window.asterDesktop.overlay("nudge",{dx:-100,dy:-30})');await wait(async()=>{const v=await w('window.asterDesktop.overlay("status")');return v.position.right===before.position.right-100;},'model position saved');
  await writeFile(process.env.AURORA_TEST_REPORT+'.arrange.png',(await companion.webContents.capturePage()).toPNG());
  await c('document.querySelector("#overlay-done").click()');await wait(()=>c('document.body.dataset.arranging==="false"'),'done');assert.equal(mouseModes.at(-1),true);assert.deepEqual(await bounds(quick),originalQuick);
  const saved=JSON.parse(await readFile(join(app.getPath('userData'),'overlay.json'),'utf8'));assert.equal(saved.height,600);assert.equal(saved.position.right,before.position.right-100);
  const modelAfter=await geometry(companion);report.checks.push('resizing and moving the model persists its layout without moving or resizing Quick ask');
  await testGaze('after moving and resizing');
  if(hyprland){const placed=await desktopWindow(quick.getTitle()),area=monitorArea(placed.monitor);await placeDesktopWindow(placed.client,quick.getTitle(),{x:area.x+40,y:area.y+50,width:500,height:620});}else quick.setBounds({x:40,y:50,width:500,height:620});
  await wait(async()=>{const b=await bounds(quick);return b?.width===500&&b?.height===620;},'compositor accepts chat resize');await q('window.asterDesktop.quick("hide")');await w('window.asterDesktop.quick("open")');const movedQuick=await geometry(quick);assert.equal(movedQuick.width,500);assert.equal(movedQuick.height,620);assert.deepEqual(await bounds(companion),modelAfter);report.checks.push('Quick ask restores its own resized placement and leaves the model unchanged');
  await w('window.asterDesktop.overlay("arrange")');await c('document.querySelector("#companion-screen").click()');await wait(()=>q('!document.querySelector("#screen-panel").hidden'),'separate screen help');await c('window.asterDesktop.overlay("done")');
  await q('document.querySelector("#screen-desktop").click()');await wait(()=>q('!document.querySelector("#screen-ask").disabled'),'desktop screen ready');
  await q('document.querySelector("#screen-question").value="Screen test";document.querySelector("#screen-ask").click()');await wait(()=>q('document.querySelector("#screen-result").textContent.includes("Screen fixture recognized")'),'screen result');
  await pause(300);assert(companion.isVisible());assert(quick.isVisible());assert.equal(mouseModes.at(-1),true);assert.deepEqual(await bounds(companion),modelAfter);assert.deepEqual(await bounds(quick),movedQuick);
  await writeFile(process.env.AURORA_TEST_REPORT+'.screen.png',(await quick.webContents.capturePage()).toPNG());report.checks.push('screen capture hides and restores both independent surfaces without shifting them or losing click-through');
  await testGaze('after screen capture hides and restores the model');
  await w('window.asterDesktop.overlay("arrange")');await c('document.querySelector("#companion-ask").click()');await wait(()=>q('document.querySelector("#screen-panel").hidden'),'Ask returns to chat');await c('window.asterDesktop.overlay("done")');
  assert.equal(companion.webContents.mainFrame.framesInSubtree.find(f=>f.url.startsWith('aster://avatar/')),frame);report.checks.push('model shortcuts open separate chat and screen modes without reloading Live2D');
  await c('document.querySelector("#avatar-automatic").checked=true;document.querySelector("#avatar-automatic").dispatchEvent(new Event("change"))');
  await wait(()=>backend.embodiment.available(),'desktop avatar heartbeat');
  await frame.executeJavaScript(`(()=>{const proto=PIXI.live2d.Live2DModel.prototype,update=proto.update;let attached=false;window.__poseSamples=[];proto.update=function(...args){if(!attached){attached=true;const m=this.internalModel;m.on('beforeModelUpdate',()=>{const p={star:m.coreModel.getParameterValueById('ParamSwitch5'),smile:m.coreModel.getParameterValueById('ParamMouthForm'),nod:m.coreModel.getParameterValueById('ParamAngleY')-m.focusController.y*30};window.__poseSamples.push(p);if(window.__poseSamples.length>90)window.__poseSamples.shift();});}return update.apply(this,args);};})()`);
  const originalChat=backend.assistant.ollama.chat;let calls=0,releaseThinking,releaseAnswer;
  const thinkingGate=new Promise(r=>releaseThinking=r),answerGate=new Promise(r=>releaseAnswer=r);
  backend.assistant.ollama.chat=async(messages,tools,signal,onChunk,options)=>{
    if(++calls===1){options?.onThinking?.();await thinkingGate;return {role:'assistant',content:'',tool_calls:[{function:{name:'express_avatar',arguments:{mood:'happy',gesture:'nod'}}}]};}
    onChunk('I’m glad you made progress.');await answerGate;return {role:'assistant',content:'I’m glad you made progress.',metrics:{seconds:1}};
  };
  try{
    await w('document.querySelector("#message").value="Show a happy nod for my progress.";document.querySelector("#composer").requestSubmit()');
    await wait(()=>c('document.body.dataset.state==="thinking"'),'workspace drives companion thinking');
    releaseThinking();
    await wait(()=>frame.executeJavaScript('document.body.dataset.mood==="happy" && document.body.dataset.expression==="1"'),'model-selected happy expression');
    await wait(()=>c('document.body.dataset.state==="replying"'),'companion reflects streaming reply');
    await wait(()=>frame.executeJavaScript('window.__poseSamples.some(p=>p.star>.5 && p.smile>.3) && Math.max(...window.__poseSamples.map(p=>p.nod))-Math.min(...window.__poseSamples.map(p=>p.nod))>5'),'actual expression and nod rig parameters');
    report.checks.push('workspace chat tool selects happy expression and nod; real Cubism parameters and thinking/replying states update');
    await w('window.asterDesktop.overlay("arrange")');
    await c('document.querySelector("#avatar-expression").value="0";document.querySelector("#avatar-expression").dispatchEvent(new Event("change"))');
    await wait(()=>frame.executeJavaScript('document.body.dataset.expression==="0" && document.body.dataset.mood==="manual"'),'manual expression overrides assistant');
    await wait(()=>!backend.embodiment.available(),'manual mode disables tool availability');
    assert.equal(avatars.config.automatic,false);releaseAnswer();await wait(()=>backend.assistant.busy.size===0,'workspace answer complete');await pause(600);
    assert.equal(await frame.executeJavaScript('document.body.dataset.expression'),'0');assert.match(await w('document.querySelector("#messages").textContent'),/glad you made progress/);
    assert.equal(JSON.parse(await readFile(join(app.getPath('userData'),'avatars/avatar.json'),'utf8')).automatic,false);
    report.checks.push('manual expression immediately overrides an active reply and persists without model reload');
  }finally{releaseThinking();releaseAnswer();backend.assistant.ollama.chat=originalChat;}
  await c('document.querySelector("#avatar-automatic").checked=true;document.querySelector("#avatar-automatic").dispatchEvent(new Event("change"))');await c('window.asterDesktop.overlay("done")');
  await wait(()=>backend.embodiment.available(),'automatic expressions resume');
  const turn=backend.embodiment.begin('expiry-test');backend.embodiment.express({mood:'playful',gesture:'tilt'},'expiry-test');
  await wait(()=>frame.executeJavaScript('document.body.dataset.mood==="playful"'),'automatic mode takes control again');backend.embodiment.finish(turn,{cancelled:true});
  await wait(()=>frame.executeJavaScript('document.body.dataset.mood==="neutral" && document.body.dataset.expression==="-1"'),'cancel returns to neutral');
  assert.equal(mouseModes.at(-1),true);assert.equal(companion.webContents.mainFrame.framesInSubtree.find(f=>f.url.startsWith('aster://avatar/')),frame);
  report.checks.push('automatic control resumes, cancellation clears expression, and the model stays click-through and isolated');
  if(hyprland){
    await w('window.asterDesktop.overlay("arrange")');
    const placed=await desktopWindow(companion.getTitle()),area=monitorArea(placed.monitor),before=placed.bounds,chatBefore=await bounds(quick);
    const halfBelow={...before,y:area.y+area.height-Math.round(before.height/2)};
    await placeDesktopWindow(placed.client,companion.getTitle(),halfBelow);await c('window.asterDesktop.overlay("done")');
    assert.deepEqual(await bounds(companion),halfBelow);assert.equal(mouseModes.at(-1),true);
    const settings=JSON.parse(await readFile(join(app.getPath('userData'),'overlay.json'),'utf8'));assert.equal(settings.position.top,halfBelow.y);
    await w('window.asterDesktop.companion("hide")');await w('window.asterDesktop.companion("show")');assert.deepEqual(await bounds(companion),halfBelow);
    await q('window.asterDesktop.screen("capture")');assert.deepEqual(await bounds(companion),halfBelow);assert.deepEqual(await bounds(quick),chatBefore);
    report.checks.push('half-offscreen placement persists through Done, model hide/show and screen capture without shifting Quick ask');
    await w('window.asterDesktop.overlay("arrange")');
    const topLeft={...before,x:area.x-Math.round(before.width/2),y:area.y-Math.round(before.height/2)};
    await placeDesktopWindow((await desktopWindow(companion.getTitle())).client,companion.getTitle(),topLeft);
    await c('window.asterDesktop.overlay("done")');await w('window.asterDesktop.overlay("arrange")');assert.deepEqual(await bounds(companion),topLeft);
    const controls=await c('(()=>{const r=document.querySelector("#overlay-edit").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()');
    assert.equal(controls.x,area.x-topLeft.x);assert.equal(controls.y,area.y-topLeft.y);assert.equal(controls.width,Math.round(before.width/2));assert.equal(controls.height,Math.round(before.height/2));
    await c('window.asterDesktop.overlay("reset")');await c('window.asterDesktop.overlay("done")');await geometry(companion);
    report.checks.push('top/left overflow keeps Arrange controls visible; Reset returns the full character to the display');
  }
  report.ok=true;await writeFile(process.env.AURORA_TEST_REPORT,JSON.stringify(report,null,2));
}
