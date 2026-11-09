import {WorkspaceNavigation,workspaceRequest} from './workspace-navigation.mjs';
import { atomic } from '../src/vault.mjs';
import { app, BrowserWindow, protocol, ipcMain, shell, Menu, dialog, screen, Tray, Notification, nativeImage } from 'electron';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { linuxTheme } from '../src/theme.mjs';
import { config } from '../src/config.mjs';
import { ReminderNotifier } from './reminders.mjs';
import { VoiceCapture, voiceStatus } from './voice.mjs';
import { WakeListener } from './wake.mjs';
import { Speech } from './speech.mjs';
import { ScreenCapture } from './screen.mjs';
import { AvatarStore } from './avatar.mjs';
import {AssistantBrowser} from './browser.mjs';
import {DesktopComputer} from './computer.mjs';
import {ComputerLink} from './computer-link.mjs';
import { OverlaySettings, overlaySize, overlayBounds, overlayViewport } from './overlay.mjs';
import { QuickWindowSettings, quickBounds } from './quick-window.mjs';
import { hyprland, desktopWindow, monitorArea, placeDesktopWindow } from './placement.mjs';
import {CompanionCursor,cursorSource} from './cursor.mjs';
import {EmbodimentLink} from './embodiment-link.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));const testing=process.env.AURORA_DESKTOP_TEST==='1';const run=promisify(execFile);
app.setName('Aurora');app.setDesktopName('aurora-assistant.desktop');app.setPath('userData',resolve(process.env.AURORA_DESKTOP_DATA||join(homedir(),'.config/aurora-assistant')));
protocol.registerSchemesAsPrivileged([{scheme:'aster',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
if(!app.requestSingleInstanceLock()){app.quit();}else{
  let win,quick,companion,tray,backend,computerLink,desktopComputer,quitting=false,quitPrepared=false,quitSaving=false,quickReady=false,quickRestoring=false,companionEditing=false,overlayRestore=true,overlayPoll,quickVisibility=0,companionVisibility=0,quickRevision=0,quickQueue=Promise.resolve(),layoutRevision=0,layoutQueue=Promise.resolve(),pendingQuick,voiceOwner,voiceStarting=false,voiceRequest=0,reminderNotifier,quickBusy=false,screenOperation=false,voiceConfig={wakeEnabled:true},resumeTimer,origin=`http://127.0.0.1:${config.port}`;const settingsPath=join(app.getPath('userData'),'window.json');let windowSave=Promise.resolve();
  function rememberMain(){if(!win||win.isDestroyed())return windowSave;const bounds=win.getNormalBounds(),value=JSON.stringify({width:bounds.width,height:bounds.height,maximized:win.isMaximized()});windowSave=windowSave.catch(()=>{}).then(()=>atomic(settingsPath,value));return windowSave;}
  const trusted=event=>[win,quick,companion].some(w=>w&&!w.isDestroyed()&&event.sender===w.webContents&&event.senderFrame===w.webContents.mainFrame&&event.senderFrame.url.startsWith('aster://app/'));
  const avatars=new AvatarStore(join(app.getPath('userData'),'avatars'));
  const overlay=new OverlaySettings(join(app.getPath('userData'),'overlay.json'));await overlay.init();
  const quickSettings=new QuickWindowSettings(join(app.getPath('userData'),'quick-window.json'));await quickSettings.init();
  const captureHidden=new Set();
  let embodimentLink,avatarReady=false,performance={available:false,phase:'idle',cue:null};
  app.on('before-quit',()=>embodimentLink?.stop());
  const sampleCursor=cursorSource({hyprland,screen});
  const companionCursor=new CompanionCursor({sample:signal=>sampleCursor(companion,signal),active:()=>!quitting&&!!companion&&!companion.isDestroyed()&&companion.isVisible()&&avatars.config.enabled,send:point=>{if(companion&&!companion.isDestroyed())companion.webContents.send('aster:cursor',point);},onError:error=>console.error('Aurora cursor:',error.message)});
  app.on('before-quit',()=>companionCursor.stop());
  const capture=new ScreenCapture({settingsFile:join(app.getPath('userData'),'screen.json'),...testing?{execute:async program=>program==='slurp'?{stdout:'0,0 640x480'}:{stdout:await readFile(join(root,'public/icon.png'))}}:{},encode:bytes=>{let img=nativeImage.createFromBuffer(bytes);if(img.isEmpty())throw new Error('The screen capture was empty.');const {width,height}=img.getSize();if(width>1400||height>1400)img=img.resize(width>=height?{width:1400}:{height:1400});return img.toJPEG(78);}});
  function presence(){const state=voice.state!=='idle'?'listening':speech.state==='speaking'?'speaking':speech.state==='synthesizing'?'preparing':performance.phase!=='idle'?performance.phase:quickBusy?'thinking':'idle';const labels={speaking:'Speaking to you…',preparing:'Preparing local voice…',thinking:'Thinking locally…',working:'Working on your request…',replying:'Answering you…',listening:voice.state==='transcribing'?'Transcribing locally…':'Listening to you…',idle:wake.enabled?'Listening for Hey Aurora':'Ready when you are'};for(const w of [quick,companion])if(w&&!w.isDestroyed())w.webContents.send('aster:presence',{state,label:labels[state]||labels.idle,screenActive:capture.status().active,performance:avatars.config.automatic?performance:null});}
  capture.on('change',status=>{for(const w of [win,quick,companion])if(w&&!w.isDestroyed())w.webContents.send('aster:screen',status);broadcastListening();});
  capture.on('problem',message=>notify('Screen access',message));
  function overlayControls(bounds,area){if(companion&&!companion.isDestroyed())companion.webContents.send('aster:command',{type:'overlay-viewport',...overlayViewport(bounds,area)});}
  function layoutCompanion(){
    if(!companion||companion.isDestroyed())return;
    const bounds=companion.getBounds(),area=screen.getDisplayMatching(bounds).workArea,size=overlaySize(overlay.value.height,area);
    const title=companionEditing?'Aurora · Arrange':'Aurora · Overlay';companion.setTitle(title);
    if(!process.env.WAYLAND_DISPLAY){const target=overlayBounds(size,area,overlayRestore?overlay.value.position:{right:bounds.x+bounds.width,top:bounds.y});companion.setBounds(target);overlayControls(target,area);overlayRestore=false;}
    else companion.setSize(size.width,size.height);
    companion.setIgnoreMouseEvents(!companionEditing);
    companion.webContents.send('aster:command',{type:'layout',editing:companionEditing,height:overlay.value.height});
    if(!hyprland)return;
    const revision=++layoutRevision;
    layoutQueue=layoutQueue.catch(()=>{}).then(async()=>{
      if(revision!==layoutRevision||!companion?.isVisible()||captureHidden.has(companion))return;
      const placed=await desktopWindow(title);if(!placed||revision!==layoutRevision)return;
      const {client,displays,bounds}=placed,saved=overlay.value.position;
      const monitor=(overlayRestore&&displays.find(m=>m.name===saved?.monitor))||placed.monitor;
      const area=monitorArea(monitor),anchor=overlayRestore?saved:{right:bounds.x+bounds.width,top:bounds.y};
      const target=overlayBounds(overlaySize(overlay.value.height,area),area,anchor);
      await placeDesktopWindow(client,title,target);
      if(revision===layoutRevision&&!companion.isDestroyed()){overlayRestore=false;await overlay.remember(target,monitor.name);overlayControls(target,area);companion.setIgnoreMouseEvents(!companionEditing);}
    }).catch(e=>console.error('Aurora overlay placement:',e.message));return layoutQueue;
  }
  async function rememberOverlay(){
    await layoutQueue;const revision=layoutRevision;
    if(!companion||companion.isDestroyed()||!companion.isVisible()||captureHidden.has(companion)||overlayRestore||!companionEditing)return;
    if(hyprland){const placed=await desktopWindow(companion.getTitle());if(placed&&revision===layoutRevision&&!captureHidden.has(companion)){await overlay.remember(placed.bounds,placed.monitor.name);overlayControls(placed.bounds,monitorArea(placed.monitor));}}
    else if(!process.env.WAYLAND_DISPLAY){const bounds=companion.getBounds();await overlay.remember(bounds);overlayControls(bounds,screen.getDisplayMatching(bounds).workArea);}
  }
  function restoreQuick(){
    const revision=++quickRevision;
    quickQueue=quickQueue.catch(()=>{}).then(async()=>{
      if(!quick?.isVisible()||captureHidden.has(quick)||revision!==quickRevision)return;
      if(hyprland){
        const placed=await desktopWindow('Aurora · Quick ask');if(!placed||revision!==quickRevision)return;
        const monitor=placed.displays.find(m=>m.name===quickSettings.value.position?.monitor)||placed.monitor;
        const target=quickBounds(quickSettings.value,monitorArea(monitor));await placeDesktopWindow(placed.client,'Aurora · Quick ask',target);
        if(revision===quickRevision)await quickSettings.remember(target,monitor.name);
      }else if(!process.env.WAYLAND_DISPLAY){
        const p=quickSettings.value.position,area=screen.getDisplayMatching(p?{x:p.x,y:p.y,width:quickSettings.value.width,height:quickSettings.value.height}:quick.getBounds()).workArea;
        quick.setBounds(quickBounds(quickSettings.value,area));
      }
    }).catch(e=>console.error('Aurora Quick ask placement:',e.message));return quickQueue;
  }
  async function rememberQuick(){
    await quickQueue;const revision=quickRevision;
    if(!quick||quick.isDestroyed()||!quick.isVisible()||captureHidden.has(quick)||quickRestoring)return;
    if(hyprland){const placed=await desktopWindow('Aurora · Quick ask');if(placed&&revision===quickRevision&&!captureHidden.has(quick))await quickSettings.remember(placed.bounds,placed.monitor.name);}
    else if(!process.env.WAYLAND_DISPLAY)await quickSettings.remember(quick.getBounds());
  }
  async function hideQuick(){
    const visibility=++quickVisibility;await rememberQuick();if(visibility!==quickVisibility)return;
    quickRevision++;quickRestoring=false;quick?.hide();capture.detach();quick?.webContents.send('aster:command','screen-hidden');
    if(voiceOwner===quick?.webContents){voiceRequest++;voiceStarting=false;await voice.cancel();}resumeWake();
  }
  async function hideCompanion(){
    const visibility=++companionVisibility;await rememberOverlay();if(visibility!==companionVisibility)return;
    layoutRevision++;companion?.hide();companionEditing=false;avatars.config.visible=false;await avatars.save();
  }
  async function performScreenCapture(action,signal){
      signal?.throwIfAborted();if(screenOperation)throw new Error('A screen capture or selection is already in progress.');screenOperation=true;
      const abort=()=>{for(const c of capture.pending)c.abort();};signal?.addEventListener('abort',abort,{once:true});
      const generation=capture.generation;let shown=[];
      try{
        await Promise.all([rememberOverlay(),rememberQuick()]);
        shown=[{window:quick,visibility:quickVisibility,current:()=>quickVisibility},{window:companion,visibility:companionVisibility,current:()=>companionVisibility}].filter(({window:w})=>w&&!w.isDestroyed()&&w.isVisible());
        shown.forEach(({window:w})=>{captureHidden.add(w);w.hide();});
        await new Promise(r=>setTimeout(r,160));signal?.throwIfAborted();if(generation!==capture.generation)throw new Error('Screen selection stopped.');
        return action==='select'?await capture.select():await capture.capture();
      }finally{
        const restore=({window:w,visibility,current})=>!quitting&&!w.isDestroyed()&&visibility===current();
        for(const item of shown){
          const w=item.window;captureHidden.delete(w);if(!restore(item))continue;
          // Wayland may remap at the original creation size and compositor position.
          // Restore each surface independently, keeping the periodic saver paused.
          if(w===companion){overlayRestore=true;layoutCompanion();}
          else{quickRestoring=true;const size=quickBounds(quickSettings.value,screen.getDisplayMatching(w.getBounds()).workArea);w.setSize(size.width,size.height);}
          w.showInactive();if(w===companion)w.setIgnoreMouseEvents(!companionEditing);
        }
        try{
          if(shown.some(restore))await new Promise(r=>setTimeout(r,120));
          for(const item of shown){if(!restore(item)||!item.window.isVisible())continue;
            if(item.window===companion)await layoutCompanion();
            else try{await restoreQuick();}finally{quickRestoring=false;}
          }
        }finally{signal?.removeEventListener('abort',abort);screenOperation=false;broadcastListening();}
      }
  }
  const voice=new VoiceCapture(),wake=new WakeListener(),voiceFile=join(app.getPath('userData'),'voice.json');
  const speech=new Speech({file:join(app.getPath('userData'),'speech.json')});
  speech.on('frame',value=>{if(companion&&!companion.isDestroyed())companion.webContents.send('aster:mouth',value);});
  speech.on('update',value=>{for(const w of [win,quick,companion])if(w&&!w.isDestroyed())w.webContents.send('aster:speech',value);if(value.busy){clearTimeout(resumeTimer);wake.stop();broadcastListening();}else resumeWake();});
  function external(value){try{const u=new URL(value);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)return shell.openExternal(u.href);if(u.protocol==='obsidian:'&&u.hostname==='open'&&u.searchParams.get('path')?.startsWith(config.vault+'/'))return shell.openExternal(u.href);}catch{}return Promise.resolve();}
  app.on('second-instance',(_event,args)=>{if(args.includes('--pause-control'))computerLink?.pause().catch(e=>notify('Computer control',e.message));else if(args.includes('--arrange'))showCompanion(true);else if(args.includes('--companion'))showCompanion();else if(args.includes('--screen'))showQuick('screen');else if(args.includes('--quick')||args.includes('--voice'))showQuick(args.includes('--voice')?'voice':'focus');else if(!args.includes('--background'))showWorkspace();});
  app.on('window-all-closed',()=>app.quit());app.on('before-quit',event=>{if(quitPrepared)return;event.preventDefault();if(quitSaving)return;quitSaving=true;quitting=true;workspaceNavigation.close();computerLink?.stop();clearInterval(overlayPoll);reminderNotifier?.stop();clearTimeout(resumeTimer);wake.stop();voice.cancel();capture.stop({remember:false});backend?.server.close();Promise.allSettled([speech.close(),rememberMain(),capture.queue,voiceSave,rememberOverlay().then(()=>overlay.queue),rememberQuick().then(()=>quickSettings.queue)]).finally(()=>{quitPrepared=true;app.quit();});});
  const workspaceNavigation=new WorkspaceNavigation({send:showWorkspace});
  function showWorkspace(data={}){if(!win||win.isDestroyed())return;if(win.isMinimized())win.restore();win.show();win.focus();if(data.conversation||data.view)win.webContents.send('aster:command',{type:'workspace',...data});}
  function protect(window){window.webContents.on('will-frame-navigate',event=>{if(event.isMainFrame){if(event.initiator?.url.startsWith('aster://avatar/'))event.preventDefault();}else if(!event.url.startsWith('aster://avatar/')&&!(event.url==='about:blank'&&event.initiator?.url.startsWith('aster://app/')))event.preventDefault();});window.webContents.setWindowOpenHandler(({url,referrer})=>{if(!referrer?.url?.startsWith('aster://avatar/'))external(url);return {action:'deny'};});window.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith('aster://app/')){e.preventDefault();external(url);}});}
  const childPreferences=()=>({preload:join(root,'desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true});
  async function showCompanion(editing=false){
    const visibility=++companionVisibility;avatars.config.visible=true;await avatars.save();
    if(visibility!==companionVisibility)return;
    if(!companion||companion.isDestroyed()){
      const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      companion=new BrowserWindow({title:'Aurora · Overlay',...overlayBounds(overlaySize(overlay.value.height,area),area,overlay.value.position),minWidth:120,minHeight:240,frame:false,transparent:true,hasShadow:false,skipTaskbar:true,show:false,alwaysOnTop:true,backgroundColor:'#00000000',icon:join(root,'public/icon.png'),webPreferences:childPreferences()});protect(companion);
      companion.on('close',e=>{if(!quitting){e.preventDefault();hideCompanion().catch(e=>notify('Companion',e.message));}});
      companion.on('show',()=>companionCursor.start());companion.on('hide',()=>companionCursor.stop());companion.on('closed',()=>companionCursor.stop());
      companion.on('closed',()=>{avatarReady=false;});companion.webContents.on('render-process-gone',()=>{avatarReady=false;});
      await companion.loadURL('aster://app/companion.html');
    }
    if(visibility!==companionVisibility)return;
    if(companionEditing)await rememberOverlay();companionEditing=editing;overlayRestore=true;layoutCompanion();
    if(editing){companion.show();companion.focus();}else companion.showInactive();
    // Wait for the compositor to map the surface before applying saved global coordinates.
    await new Promise(r=>setTimeout(r,120));if(visibility===companionVisibility){await layoutCompanion();presence();}
  }
  async function showQuick(command='focus'){
    const visibility=++quickVisibility;pendingQuick=command;
    if(!quick||quick.isDestroyed()){
      const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;quickReady=false;
      quick=new BrowserWindow({title:'Aurora · Quick ask',...quickBounds(quickSettings.value,area),minWidth:340,minHeight:360,frame:false,transparent:true,hasShadow:false,skipTaskbar:true,show:false,alwaysOnTop:true,backgroundColor:'#00000000',icon:join(root,'public/icon.png'),webPreferences:childPreferences()});protect(quick);
      quick.webContents.on('render-process-gone',()=>{if(quitting)return;quickReady=false;capture.detach();quickBusy=false;if(speech.owner===quick.webContents.id)speech.stop();if(voiceOwner===quick.webContents){voiceRequest++;voiceStarting=false;voice.cancel();}resumeWake();});
      quick.on('close',e=>{if(!quitting){e.preventDefault();hideQuick().catch(e=>notify('Quick ask',e.message));}});
      await quick.loadURL('aster://app/quick.html');
    }
    if(visibility!==quickVisibility)return;
    const restore=!quick.isVisible()||quickRestoring;
    if(restore){quickRestoring=true;const area=screen.getDisplayMatching(quick.getBounds()).workArea,size=quickBounds(quickSettings.value,area);quick.setSize(size.width,size.height);}
    quick.show();quick.focus();deliverQuick();presence();
    if(restore){await new Promise(r=>setTimeout(r,120));if(visibility===quickVisibility){try{await restoreQuick();}finally{quickRestoring=false;}}}
  }
  function deliverQuick(){if(!quickReady||!pendingQuick)return;const command=pendingQuick;pendingQuick=null;if(command==='hands-free'){startVoice(quick.webContents,{handsFree:true}).catch(e=>{if(quick&&!quick.isDestroyed())quick.webContents.send('aster:voice',{state:'idle',error:e.message});});}else if(typeof command==='object')quick.webContents.send('aster:voice',{state:'idle',handsFree:true,text:command.text});else quick.webContents.send('aster:command',command);}
  function broadcastListening(){presence();for(const w of [win,quick,companion])if(w&&!w.isDestroyed())w.webContents.send('aster:listening',{enabled:voiceConfig.wakeEnabled,active:wake.enabled});if(tray){const sharing=capture.status().active;tray.setImage(join(root,sharing?'public/icon-screen.png':'public/icon.png'));tray.setTitle(sharing?'▣ Aurora':wake.enabled?'● Aurora':'○ Aurora');tray.setToolTip(sharing?'Aurora · Screen access ON · stop from this menu':wake.enabled?'Aurora · listening for Hey Aurora':voiceConfig.wakeEnabled?'Aurora · listening paused during activity':'Aurora · wake listening off');tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Aurora',click:()=>showWorkspace()},{label:'Your day',click:()=>showWorkspace({view:'overview'})},{label:'Quick ask',click:()=>showQuick()},{label:'Screen help',click:()=>showQuick('screen')},{label:'Show Aurora companion',click:()=>showCompanion()},{label:'Move / resize Aurora',click:()=>showCompanion(true)},{label:'Hide Aurora companion',click:()=>hideCompanion()},{label:'Stop speaking',enabled:speech.state!=='idle',click:()=>speech.stop()},{label:speech.settings.muted?'Unmute voice':'Mute voice',click:()=>speech.configure({muted:!speech.settings.muted}).catch(e=>notify('Voice settings',e.message))},{label:'Pause computer control',click:()=>computerLink?.pause().catch(e=>notify('Computer control',e.message))},{label:'Pause microphone & screen',click:()=>pauseCapture().catch(e=>notify('Capture paused; settings could not be saved',e.message))},{label:'Stop screen sharing',enabled:capture.status().active,click:()=>capture.stop()},{label:voiceConfig.wakeEnabled?'Pause wake listening':'Enable wake listening',click:()=>setListening(!voiceConfig.wakeEnabled)},{type:'separator'},{label:'Quit Aurora',click:()=>{quitting=true;app.quit();}}]));}}
  async function startVoice(owner,options){if(voice.state!=='idle')throw new Error('Microphone is already in use.');const request=++voiceRequest;voiceStarting=true;voiceOwner=owner;clearTimeout(resumeTimer);wake.stop();try{await speech.stop();if(request!==voiceRequest||quitting||owner.isDestroyed())return;return await voice.start(options);}finally{if(request===voiceRequest){voiceStarting=false;resumeWake();}}}
  function canWake(){return !testing&&voiceConfig.wakeEnabled&&!quickBusy&&voice.state==='idle'&&!voiceStarting&&speech.state==='idle'&&!quitting;}
  function resumeWake(){clearTimeout(resumeTimer);broadcastListening();if(canWake())resumeTimer=setTimeout(()=>{if(canWake())wake.start().catch(e=>{voiceConfig.wakeEnabled=false;broadcastListening();notify('Wake listening unavailable',e.message);});},3500);}
  function notify(title,body){if(!testing&&Notification.isSupported())new Notification({title,body,icon:join(root,'public/icon.png')}).show();}
  let voiceSave=Promise.resolve();
  async function setListening(enabled){voiceConfig.wakeEnabled=enabled;if(!enabled){clearTimeout(resumeTimer);wake.stop();}else resumeWake();broadcastListening();const saved=JSON.stringify(voiceConfig);const write=voiceSave.then(()=>atomic(voiceFile,saved));voiceSave=write.catch(()=>{});await write;return {enabled:voiceConfig.wakeEnabled,active:wake.enabled};}
  async function pauseCapture(){
    voiceRequest++;voiceStarting=false;voiceConfig.wakeEnabled=false;clearTimeout(resumeTimer);wake.stop();capture.stop();
    const results=await Promise.allSettled([speech.stop(),voice.cancel(),setListening(false),capture.lastSave]);
    for(const result of results)if(result.status==='rejected')throw result.reason;
    return {paused:true};
  }
  voice.on('update',event=>{if(voiceOwner&&!voiceOwner.isDestroyed())voiceOwner.send('aster:voice',event);presence();if(event.state==='idle')resumeWake();});
  wake.on('state',broadcastListening);wake.on('wake',event=>showQuick(event.text.length>3?event:'hands-free').catch(()=>{}));wake.on('problem',message=>{voiceConfig.wakeEnabled=false;broadcastListening();notify('Aurora microphone paused',message);});

  app.whenReady().then(async()=>{try{
    await mkdir(app.getPath('userData'),{recursive:true,mode:0o700});await avatars.init();await capture.init();await speech.init();
    if(testing){const {createApp}=await import('../src/server.mjs');backend=await createApp({vault:process.env.AURORA_VAULT,data:process.env.AURORA_DATA,projects:[],ollamaClient:{status:async()=>({online:true,model:config.model,models:[{name:config.model}]}),check:async()=>{},chat:async(messages,tools,signal,onChunk)=>{const content=messages.at(-1).images?'Screen fixture recognized. Your selected region is being analyzed locally.':'Desktop connection is working. Your memory stays in Markdown.';onChunk?.(content);return {role:'assistant',content,metrics:{seconds:0.1}};}}});await new Promise((res,rej)=>{backend.server.once('error',rej);backend.server.listen(0,'127.0.0.1',res);});origin=`http://127.0.0.1:${backend.server.address().port}`;}
    else{await run('systemctl',['--user','start','aurora-assistant.service'],{timeout:15000});let ready=false;for(let i=0;i<40;i++){try{const r=await fetch(origin+'/api/bootstrap',{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,300));}if(!ready)throw new Error('The local Aurora service did not start. Check systemctl --user status aurora-assistant.');}
    protocol.handle('aster',async request=>{const u=new URL(request.url);if(u.hostname==='avatar'&&!u.username&&!u.password&&request.method==='GET'){try{const staticFile={'/':'avatar.html','/avatar.js':'avatar.js','/avatar.css':'avatar.css','/pixi.min.js':'vendor/pixi.min.js','/cubism4.min.js':'vendor/cubism4.min.js'}[u.pathname];const result=staticFile?{bytes:await readFile(join(root,'public',staticFile)),type:staticFile.endsWith('.html')?'text/html':staticFile.endsWith('.css')?'text/css':'text/javascript'}:await avatars.asset(decodeURIComponent(u.pathname.slice(1)));return new Response(result.bytes,{headers:{'Content-Type':result.type,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"}});}catch{return new Response('Avatar asset unavailable',{status:404});}}if(u.hostname!=='app'||u.username||u.password)return new Response('Not found',{status:404});try{
      if(u.pathname.startsWith('/api/')||u.pathname==='/theme.css'){const caller=request.headers.get('origin');if(caller&&caller!=='aster://app')return new Response('Untrusted origin',{status:403});if(!['GET','POST'].includes(request.method))return new Response('Method not allowed',{status:405});const body=request.method==='POST'?await request.text():undefined;if(body&&Buffer.byteLength(body)>(u.pathname==='/api/mobile-transfer-preview'?10*1024*1024:['/api/screen-guide','/api/computer/complete'].includes(u.pathname)?1600000:650000))return new Response('Too large',{status:413});if(request.method==='POST'&&u.pathname==='/api/workflow-control'){try{if(['pause','cancel'].includes(JSON.parse(body).operation))await speech.stop();}catch{}}return await fetch(origin+u.pathname+u.search,{method:request.method,headers:{Origin:origin,'Content-Type':'application/json','X-Aster-Token':request.headers.get('x-aster-token')||''},body,redirect:'error',signal:request.signal});}
      if(['/task-list-core.js','/planner.js','/planner-core.js','/tasks.js','/timetable.js','/calendar-options.js','/task-links.js'].includes(u.pathname)&&request.method==='GET')return new Response(await readFile(join(root,'mobile/web',u.pathname.slice(1))),{headers:{'Content-Type':'text/javascript; charset=utf-8'}});
      const file={'/':'index.html','/app.js':'app.js','/speech.js':'speech.js','/agents.js':'agents.js','/workflows.js':'workflows.js','/source-claims.js':'source-claims.js','/workflow-review.js':'workflow-review.js','/workflow-completion.js':'workflow-completion.js','/workflow-followups.js':'workflow-followups.js','/repair-expressions.js':'repair-expressions.js','/example-review.js':'example-review.js','/test-copy.js':'test-copy.js','/task-skills.js':'task-skills.js','/workflow-requirements.js':'workflow-requirements.js','/desktop-outcome-picker.js':'desktop-outcome-picker.js','/workflow-handoffs.js':'workflow-handoffs.js','/project-workspaces.js':'project-workspaces.js','/models.js':'models.js','/markdown.js':'markdown.js','/style.css':'style.css','/icon.svg':'icon.svg','/quick.html':'quick.html','/quick.js':'quick.js','/quick.css':'quick.css','/integrations.js':'integrations.js','/character.js':'character.js','/health.js':'health.js','/mobile-transfers.js':'mobile-transfers.js','/planner-editor-drafts.js':'planner-editor-drafts.js','/remaining-adjustments.js':'remaining-adjustments.js','/remaining-day.js':'remaining-day.js','/day-start.js':'day-start.js','/handoff-action.js':'handoff-action.js','/day-handoff.js':'day-handoff.js','/shortlist-workspace.js':'shortlist-workspace.js','/reading-position.js':'reading-position.js','/shortlist-follow.js':'shortlist-follow.js','/capture-shortlist.js':'capture-shortlist.js','/captured-tasks.js':'captured-tasks.js','/task-capture.js':'task-capture.js','/task-list.js':'task-list.js','/task-details.js':'task-details.js','/planning-draft-guard.js':'planning-draft-guard.js','/estimate-follow-through.js':'estimate-follow-through.js','/estimate-adjustment.js':'estimate-adjustment.js','/estimate-review.js':'estimate-review.js','/session-review.js':'session-review.js','/session-summary.js':'session-summary.js','/focus-sessions.js':'focus-sessions.js','/continue-day.js':'continue-day.js','/day-planning.js':'day-planning.js','/daily-checkin.js':'daily-checkin.js','/checkin-review.js':'checkin-review.js','/daily-summary.js':'daily-summary.js','/morning-reflection.js':'morning-reflection.js','/first-steps.js':'first-steps.js','/step-outcomes.js':'step-outcomes.js','/outcome-planning.js':'outcome-planning.js','/plan-follow-through.js':'plan-follow-through.js','/evening-review.js':'evening-review.js','/weekly-review.js':'weekly-review.js','/daily-focus.js':'daily-focus.js','/planning-selection.js':'planning-selection.js','/next-day.js':'next-day.js','/week-capacity.js':'week-capacity.js','/recovery-groups.js':'recovery-groups.js','/review-return.js':'review-return.js','/cleanup-recovery.js':'cleanup-recovery.js','/reminder-cleanup.js':'reminder-cleanup.js','/reminder-overview.js':'reminder-overview.js','/reminder-plans.js':'reminder-plans.js','/workload-revisits.js':'workload-revisits.js','/workload-reflection.js':'workload-reflection.js','/workload-remaining.js':'workload-remaining.js','/workload-start.js':'workload-start.js','/workload-next.js':'workload-next.js','/workload-next-draft.js':'workload-next-draft.js','/workload-follow.js':'workload-follow.js','/week-workload.js':'week-workload.js','/week-workload-draft.js':'week-workload-draft.js','/saved-day-plans.js':'saved-day-plans.js','/remainder-planning.js':'remainder-planning.js','/focus-review.js':'focus-review.js','/task-proposal-review.js':'task-proposal-review.js','/google-calendar.js':'google-calendar.js','/task-workflows.js':'task-workflows.js','/task-attention.js':'task-attention.js','/planning.js':'planning.js','/task-projects.js':'task-projects.js','/planning-settings.js':'planning-settings.js','/weekly-planner.js':'weekly-planner.js','/memory-review.js':'memory-review.js','/screen-help.js':'screen-help.js','/browser.html':'browser.html','/browser.js':'browser.js','/browser.css':'browser.css','/companion.html':'companion.html','/companion-window.js':'companion-window.js','/companion.js':'companion.js','/companion.css':'companion.css'}[u.pathname];if(!file||request.method!=='GET')return new Response('Not found',{status:404});return new Response(await readFile(join(root,'public',file)),{headers:{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]+'; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src aster://avatar; form-action 'self'"}});
    }catch{return new Response('Local service unavailable',{status:503});}});
    let saved={};try{saved=JSON.parse(await readFile(settingsPath,'utf8'));}catch{}const theme=await linuxTheme(),area=screen.getPrimaryDisplay().workAreaSize;
    win=new BrowserWindow({title:'Aurora',width:Math.min(Number(saved.width)||1440,area.width),height:Math.min(Number(saved.height)||940,area.height),minWidth:760,minHeight:540,frame:false,show:false,backgroundColor:theme.variables['--bg'],icon:join(root,'public/icon.png'),webPreferences:{preload:join(root,'desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:!testing}});
    win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));win.webContents.session.setPermissionCheckHandler(()=>false);
    win.webContents.setWindowOpenHandler(({url})=>{external(url);return {action:'deny'};});win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('aster://app/')){event.preventDefault();external(url);}});
    win.webContents.on('will-prevent-unload',event=>{if(testing){event.preventDefault();return;}const response=dialog.showMessageBoxSync(win,{type:'question',buttons:['Keep working','Close Aurora'],defaultId:0,cancelId:0,title:'Close workspace?',message:'You have unsaved edits or an answer in progress.',detail:'Closing will interrupt generation. Your note draft is kept for recovery.'});if(response===1)event.preventDefault();});
    win.on('close',event=>{if(!quitting&&!testing){event.preventDefault();win.hide();}if(!quitting)rememberMain().catch(()=>{});});
    ipcMain.handle('aster:window',(event,action)=>{if(!trusted(event)||event.sender!==win.webContents||!['minimize','maximize','close'].includes(action))throw new Error('Invalid window action.');if(action==='minimize')win.minimize();else if(action==='maximize')win.isMaximized()?win.unmaximize():win.maximize();else win.close();});
    ipcMain.handle('aster:vault',event=>{if(!trusted(event))throw new Error('Untrusted request.');return shell.openPath(config.vault);});
    ipcMain.handle('aster:quick',async(event,action)=>{if(!trusted(event))throw new Error('Untrusted request.');if(action==='open')return showQuick();if(action==='voice')return showQuick('voice');if(action==='screen')return showQuick('screen');if(event.sender!==quick?.webContents)throw new Error('Quick window required.');if(action==='ready'){quickReady=true;quick.webContents.send('aster:screen',capture.status());deliverQuick();presence();}else if(action==='hide'){await hideQuick();}else if(action==='busy'){quickBusy=true;presence();clearTimeout(resumeTimer);wake.stop();}else if(action==='idle'){quickBusy=false;presence();resumeWake();}else throw new Error('Invalid quick action.');});
    ipcMain.handle('aster:screen',async(event,action,options)=>{
      if(!trusted(event))throw new Error('Untrusted screen request.');
      if(action==='status'||quitting&&action==='detach')return capture.status();if(quitting)throw new Error('Aurora is shutting down.');if(action==='stop'){const status=capture.stop();await capture.lastSave;return status;}
      if(event.sender!==quick?.webContents)throw new Error('Configure screen access in Quick ask.');
      if(action==='configure')return capture.configure(options);if(action==='desktop')return capture.desktop();
      if(action==='detach')return capture.detach();
      if(!['select','capture'].includes(action))throw new Error('Invalid screen action.');
      return performScreenCapture(action);
    });
    ipcMain.handle('aster:overlay',async(event,action,data={})=>{
      if(!trusted(event))throw new Error('Untrusted overlay request.');
      if(action==='status')return {...overlay.value,editing:companionEditing};
      if(action==='model-ready'){if(event.sender!==companion?.webContents||typeof data.ready!=='boolean')throw new Error('Companion readiness required.');avatarReady=data.ready;return;}
      if(action==='ready'){if(event.sender!==companion?.webContents)throw new Error('Companion window required.');await layoutCompanion();companionCursor.stop();companionCursor.start();presence();return overlay.value;}
      if(action==='arrange'){await showCompanion(true);return overlay.value;}
      if(action==='done'){await rememberOverlay();companionEditing=false;await layoutCompanion();return overlay.value;}
      if(action==='resize'){await rememberOverlay();await overlay.resize(data.height);overlayRestore=true;await layoutCompanion();return overlay.value;}
      if(action==='reset'){overlay.value={height:920,position:null};await overlay.save();overlayRestore=true;await layoutCompanion();return overlay.value;}
      if(action==='nudge'){if(!Number.isFinite(data.dx)||!Number.isFinite(data.dy)||Math.abs(data.dx)>200||Math.abs(data.dy)>200)throw new Error('Invalid move.');await rememberOverlay();const p=overlay.value.position;if(p){p.right+=data.dx;p.top+=data.dy;await overlay.save();overlayRestore=true;await layoutCompanion();}return overlay.value;}
      throw new Error('Unknown overlay control.');
    });
    ipcMain.handle('aster:companion',async(event,action)=>{
      if(!trusted(event))throw new Error('Untrusted request.');
      if(action==='status')return avatars.status();
      if(action==='show'){await showCompanion();return avatars.status();}
      if(action==='hide'){await hideCompanion();return avatars.status();}
      if(['automatic-on','automatic-off'].includes(action)){
        avatars.config.automatic=action==='automatic-on';performance={...performance,available:false,cue:null};await avatars.save();
        companion?.webContents.send('aster:avatar',{type:'automatic',enabled:avatars.config.automatic});presence();return avatars.status();
      }
      if(event.sender!==win.webContents)throw new Error('Configure the avatar from workspace Settings.');
      if(action==='builtin'){avatars.config.enabled=false;await avatars.save();}
      else if(action==='enable'){avatars.config.enabled=true;await avatars.save();}
      else if(['import-model','import-core'].includes(action)){
        const result=await dialog.showOpenDialog(win,{title:action==='import-model'?'Choose an exported Live2D .model3.json':'Choose Cubism SDK Core/live2dcubismcore.min.js',properties:['openFile'],filters:[{name:action==='import-model'?'Model JSON':'Cubism Core',extensions:[action==='import-model'?'json':'js']}]});
        if(result.canceled)return avatars.status();if(action==='import-model')await avatars.importModel(result.filePaths[0]);else await avatars.importCore(result.filePaths[0]);
      }else throw new Error('Invalid companion action.');
      companionCursor.stop();if(avatars.config.enabled)companionCursor.start();companion?.webContents.send('aster:avatar');return avatars.status();
    });
    ipcMain.handle('aster:workspace',(event,data={})=>{if(!trusted(event))throw Error('Invalid workspace request.');const request=workspaceRequest(data);if(request.taskId)return workspaceNavigation.open(request);showWorkspace(request);});
    ipcMain.handle('aster:workspace-result',(event,id,result)=>{if(!trusted(event)||event.sender!==win.webContents)throw Error('Workspace confirmation must come from the main window.');workspaceNavigation.finish(id,result);});
    win.webContents.on('render-process-gone',()=>{workspaceNavigation.close();if(speech.owner===win.webContents.id)speech.stop();});
    ipcMain.handle('aster:speech',async(event,action,data)=>{if(!trusted(event))throw new Error('Untrusted speech request.');if(action==='status'){const status=await speech.check();return {...status,...speech.snapshot(),error:speech.error||status.error};}if(action==='stop')return speech.stop().then(()=>speech.snapshot());if(action==='configure')return speech.configure(data);if(action==='say'){if(voice.state!=='idle'||voiceStarting)throw new Error('Finish recording before reading aloud.');return speech.say(data?.text,event.sender.id);}throw new Error('Invalid speech request.');});
    ipcMain.handle('aster:voice-status',event=>{if(!trusted(event))throw new Error('Untrusted request.');return voiceStatus();});
    ipcMain.handle('aster:voice',async(event,action)=>{if(!trusted(event)||testing||!['start','stop','cancel'].includes(action))throw new Error('Invalid microphone request.');if(action==='start')return startVoice(event.sender);if(voiceOwner!==event.sender)throw new Error('Another window owns this recording.');if(action==='stop'){voice.stop();return;}voiceRequest++;voiceStarting=false;return voice.cancel();});
    ipcMain.handle('aster:pause-capture',async event=>{if(!trusted(event))throw new Error('Untrusted request.');return pauseCapture();});
    ipcMain.handle('aster:listening',async(event,enabled)=>{if(!trusted(event))throw new Error('Untrusted request.');if(typeof enabled==='boolean')return setListening(enabled);return {enabled:voiceConfig.wakeEnabled,active:wake.enabled};});
    const command=key=>win?.webContents.send('aster:command',key);
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Aurora',submenu:[{label:'New conversation',accelerator:'CommandOrControl+N',click:()=>command('new-chat')},{label:'Save note',accelerator:'CommandOrControl+S',click:()=>command('save-note')},{type:'separator'},{label:'Open memory folder',click:()=>shell.openPath(config.vault)},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{label:'Screen help',click:()=>showQuick('screen')},{label:'Show Aurora companion',click:()=>showCompanion()},{label:'Move / resize Aurora',click:()=>showCompanion(true)},{label:'Hide Aurora companion',click:()=>hideCompanion()},{label:'Search memory',accelerator:'CommandOrControl+K',click:()=>command('search')},{label:'Toggle memory panel',accelerator:'CommandOrControl+Shift+M',click:()=>command('toggle-context')},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}]));
    try{const savedVoice=JSON.parse(await readFile(voiceFile,'utf8'));voiceConfig={wakeEnabled:savedVoice?.wakeEnabled===true};}catch(e){if(e.code!=='ENOENT'){voiceConfig={wakeEnabled:false};notify('Wake listening is off','Saved voice settings could not be read. Enable listening in Settings when ready.');}}
    const reminderEvents=[],notifications=new Set();
    const showReminder=(delivery,signal)=>new Promise((resolve,reject)=>{
      if(!Notification.isSupported())return reject(new Error('Desktop notifications are unavailable.'));
      const notification=new Notification({title:delivery.count===1?'Aurora · Your reminder':`Aurora · ${delivery.count} reminders due`,body:delivery.count===1?delivery.items[0].text:delivery.items.slice(0,3).map(t=>t.text).join('\n')+'\nOpen Your day to review them.',icon:join(root,'public/icon.png'),urgency:'normal'});notifications.add(notification);
      const timer=setTimeout(()=>finish(new Error('Notification was not shown.')),10000);
      const abort=()=>{notification.close();finish(signal.reason);};
      const finish=error=>{clearTimeout(timer);signal.removeEventListener('abort',abort);error?reject(error):resolve();};
      notification.once('show',()=>finish());notification.once('failed',()=>finish(new Error('Desktop notification failed.')));notification.once('click',()=>showWorkspace({view:'overview'}));notification.once('close',()=>notifications.delete(notification));
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)return abort();notification.show();
      // Some desktops omit close events. Keep click handlers alive for a bounded period.
      setTimeout(()=>notifications.delete(notification),86400000).unref();
    });
    reminderNotifier=new ReminderNotifier({origin,notify:testing?async(delivery,signal)=>{if(process.env.AURORA_TEST_NOTIFICATIONS==='1')await showReminder(delivery,signal);reminderEvents.push(delivery);}:showReminder,onError:message=>console.error('Reminders:',message)});
    const browser=new AssistantBrowser({root,testing});desktopComputer=new DesktopComputer({browser,data:config.data,capture:async signal=>{if(!capture.status().active)throw new Error('Screen access is off. Enable it in Quick ask → Screen.');return performScreenCapture('capture',signal);}});
    computerLink=new ComputerLink({origin,execute:(method,input,signal)=>desktopComputer.handle(method,input,signal),onPause:()=>{speech.stop();notify('Computer control paused','System, app, browser, mouse and keyboard actions are paused. Re-enable system tools and computer controls in Settings.');}} );await computerLink.start();
    embodimentLink=new EmbodimentLink({origin,status:()=>({enabled:avatars.config.enabled&&avatars.config.automatic&&avatarReady,visible:!!companion&&!companion.isDestroyed()&&companion.isVisible()}),onChange:value=>{performance=value;presence();}});embodimentLink.start();
    win.setMenuBarVisibility(false);await win.loadURL('aster://app/');
    overlayPoll=setInterval(()=>Promise.allSettled([rememberOverlay(),rememberQuick()]),1200);
    if(testing){win.showInactive();const {smoke}=await import(process.env.AURORA_LAPTOP_RECOVERY_TEST==='1'?'./laptop-recovery-smoke.mjs':process.env.AURORA_WORKFLOW_NATIVE_TEST==='1'?'./workflow-native-smoke.mjs':process.env.AURORA_COMPUTER_TEST==='1'?'./computer-smoke.mjs':process.env.AURORA_AVATAR_TEST==='1'?'./avatar-smoke.mjs':process.env.AURORA_RECOVERY_WORKSPACE_TEST==='1'?'./recovery-workspace-smoke.mjs':process.env.AURORA_PLANNING_WEEK_TEST==='1'?'./planning-week-smoke.mjs':process.env.AURORA_REMINDER_CLEANUP_TEST==='1'?'./reminder-cleanup-smoke.mjs':process.env.AURORA_REMINDER_OVERVIEW_TEST==='1'?'./reminder-overview-smoke.mjs':process.env.AURORA_REMINDER_PLAN_TEST==='1'?'./reminder-plan-smoke.mjs':process.env.AURORA_WORKLOAD_REVISIT_TEST==='1'?'./workload-revisit-smoke.mjs':'./smoke.mjs');await smoke({win,backend,avatars,reminderNotifier,reminderEvents,desktopComputer,computerLink,speech,startVoice,voice});app.quit();}else{reminderNotifier.start();tray=new Tray(join(root,'public/icon.png'));tray.on('click',()=>showQuick());broadcastListening();if(capture.status().active)notify('Aurora screen access is on','Persistent local desktop access has resumed. Stop it from the tray menu or Quick ask → Screen.');if(process.argv.includes('--pause-control'))await computerLink.pause();if(avatars.config.visible||process.argv.includes('--companion'))await showCompanion();if(process.argv.includes('--arrange'))await showCompanion(true);else if(process.argv.includes('--screen'))await showQuick('screen');else if(process.argv.includes('--voice')||process.argv.includes('--quick'))await showQuick(process.argv.includes('--voice')?'voice':'focus');else if(!process.argv.includes('--background')&&!process.argv.includes('--companion')&&!process.argv.includes('--arrange')){if(saved.maximized)win.maximize();win.show();}if(voiceConfig.wakeEnabled){resumeWake();notify('Aurora voice is enabled','Listening locally for Hey Aurora. Pause from the tray icon or Aurora Settings.');}}
  }catch(error){console.error(error);if(testing){let report={};try{report=JSON.parse(await readFile(process.env.AURORA_TEST_REPORT,'utf8'));}catch{}await writeFile(process.env.AURORA_TEST_REPORT,JSON.stringify({...report,ok:false,error:error.stack}));app.exit(1);}else{dialog.showErrorBox('Aurora could not start',error.message);app.quit();}}});
}
