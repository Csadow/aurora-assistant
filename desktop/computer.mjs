import {readdir,readFile,stat} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {homedir} from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {SystemAccess,redact} from '../src/system.mjs';
import {sha} from '../src/vault.mjs';
import {computerOperations} from '../src/computer.mjs';
import {webURL} from './web-url.mjs';
import {documentOpener,openDocument} from './open-document.mjs';
const run=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const text=(value,max=4000)=>{if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw new Error('Enter a valid text value.');return value;};
const integer=(value,min,max)=>{if(!Number.isInteger(value)||value<min||value>max)throw new Error(`Choose an integer from ${min} to ${max}.`);return value;};
const keyNames={Enter:'Return',Backspace:'BackSpace',Delete:'Delete',Tab:'Tab',Escape:'Escape',ArrowLeft:'Left',ArrowRight:'Right',ArrowUp:'Up',ArrowDown:'Down',PageUp:'Page_Up',PageDown:'Page_Down',Home:'Home',End:'End',Space:'space'};
export function keyChord(value){const parts=text(value,80).split('+'),key=parts.pop();if(parts.some(v=>!['Ctrl','Alt','Shift','Super'].includes(v))||!(keyNames[key]||/^[a-zA-Z0-9]$|^F(?:[1-9]|1[0-2])$/.test(key)))throw new Error('Use a named key, optionally with Ctrl, Alt, Shift, or Super.');return {mods:parts.map(v=>v==='Ctrl'?'CTRL':v.toUpperCase()).join(' '),key:keyNames[key]||key};}
export class DesktopComputer {
  constructor({browser,data,capture,home=homedir(),execute=run}){Object.assign(this,{browser,capture,home,execute});this.system=new SystemAccess({data,home});this.catalog=new Map();}
  async applications(){
    this.catalog.clear();const dirs=[join(this.home,'.local/share/applications'),'/usr/local/share/applications','/usr/share/applications'];
    for(const dir of dirs){let files;try{files=await readdir(dir);}catch{continue;}
      for(const file of files.filter(f=>f.endsWith('.desktop')).slice(0,400)){
        if(this.catalog.has(file))continue;const path=join(dir,file);let raw;try{raw=await readFile(path,'utf8');}catch{continue;}
        const section=raw.match(/^\[Desktop Entry\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1]||raw;
        const value=key=>section.match(new RegExp('^'+key+'=(.*)$','m'))?.[1]?.trim();
        if(value('Type')!=='Application'||value('Hidden')==='true'||value('NoDisplay')==='true'||!value('Name'))continue;
        this.catalog.set(file,{id:file,name:value('Name'),path,revision:sha(raw)});
      }
    }
    return {applications:[...this.catalog.values()].map(({id,name})=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name))};
  }
  async clients(){if(!process.env.HYPRLAND_INSTANCE_SIGNATURE)throw new Error('Desktop window control currently requires Hyprland.');const {stdout}=await this.execute('hyprctl',['clients','-j'],{timeout:2500,maxBuffer:1024*1024});return JSON.parse(stdout);}
  protected(c){return c.pid===process.pid||/aurora-assistant|aster-assistant|codex|keepass|bitwarden|1password|hyprlock|polkit/i.test(c.class)||/password|authentication required/i.test(c.title);}
  summary(c){return {id:c.address,pid:c.pid,app:c.class,title:redact(c.title).slice(0,200),x:c.at[0],y:c.at[1],width:c.size[0],height:c.size[1]};}
  async windows(){return {windows:(await this.clients()).filter(c=>!this.protected(c)&&c.mapped&&!c.hidden).slice(0,80).map(c=>this.summary(c)),warning:'Coordinates are logical pixels relative to each window. Aurora approval windows and credential managers cannot be controlled.'};}
  async outcomeTargets(input){
    if(!input||Object.keys(input).some(k=>k!=='kind')||!['browser','window'].includes(input.kind))throw new Error('Choose a page or window preview.');
    if(input.kind==='browser')return {page:this.browser.outcomeTarget()};
    const clients=(await this.clients()).filter(c=>!this.protected(c)&&c.mapped&&!c.hidden),windows=[];
    for(const c of clients.slice(0,80)){
      // Completion reads currently expose 200 title characters. Never copy a
      // redacted/truncated label as if it were a complete exact window title.
      if(windows.length>=80||typeof c.address!=='string'||!/^0x[0-9a-f]+$/i.test(c.address)||!Number.isSafeInteger(c.pid)||c.pid<=0||typeof c.title!=='string'||!c.title.trim()||c.title.length>200||redact(c.title)!==c.title||/[\x00-\x1f\x7f]/.test(c.title)||typeof c.class!=='string'||c.class&& !c.class.trim()||c.class.length>200||/[\x00-\x1f\x7f]/.test(c.class))continue;
      windows.push({id:c.address,pid:c.pid,app:c.class,title:c.title});
    }
    return {windows,omitted:clients.length-windows.length};
  }
  async target(id,expected){if(typeof id!=='string'||!/^0x[0-9a-f]+$/i.test(id))throw new Error('Use an exact window ID from windows.');const c=(await this.clients()).find(c=>c.address===id);if(!c||this.protected(c)||!c.mapped||c.hidden)throw new Error('That window is unavailable or protected.');const target=this.summary(c);if(expected&&JSON.stringify(target)!==JSON.stringify(expected))throw new Error('The target window changed since review. Inspect it and request a new action.');return target;}
  async prepare(input){
    if(!input||!computerOperations.includes(input.operation))throw new Error('Unknown computer operation.');
    const p={operation:input.operation};
    if(input.operation==='open_app'){
      await this.applications();const app=this.catalog.get(input.application);if(!app)throw new Error('Choose an application ID from applications.');p.application=app;
    }else if(input.operation==='open_path'){
      p.path=await this.system.path(input.path);const info=await stat(p.path);
      if(!info.isDirectory()&&(!info.isFile()||info.mode&0o111||!/^\.(txt|md|pdf|png|jpe?g|gif|webp|svg|mp3|mp4|mkv|wav|ogg|flac|docx?|xlsx?|pptx?|odt|ods|odp|csv|json|log)$/i.test(extname(p.path))))throw new Error('Automatic opening supports folders and ordinary documents/media. Executables require a reviewed command.');
      p.directory=info.isDirectory();
      p.opener=p.directory?{kind:'default'}:await documentOpener(p.path,{execute:this.execute,home:this.home});
    }else if(input.operation==='open_url')p.url=webURL(input.url,this.browser.testing?this.browser.testOrigin:null);
    else if(input.operation==='web_search')p.text=text(input.text,1000);
    else if(['browser_click','browser_fill','browser_key'].includes(input.operation)){
      p.ref=text(input.ref,10);p.revision=text(input.revision,60);
      if(input.operation==='browser_fill')p.text=text(input.text,4000);
      if(input.operation==='browser_key'){if(!['Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(input.key))throw new Error('Use a basic browser key.');p.key=input.key;}
      return this.browser.prepare(p);
    }else if(input.operation==='browser_read')p.offset=integer(input.offset??0,0,2000000);
    else if(input.operation==='browser_scroll')p.amount=integer(input.amount??600,-1600,1600);
    else if(['focus_window','close_window','click','type_text','key','scroll'].includes(input.operation)){
      p.target=await this.target(input.windowId);
      if(input.operation==='click'){p.x=integer(input.x,0,p.target.width-1);p.y=integer(input.y,0,p.target.height-1);p.button=input.button||'left';if(!['left','right'].includes(p.button))throw new Error('Choose left or right click.');}
      if(input.operation==='type_text')p.text=text(input.text,2000);
      if(input.operation==='key')p.chord=keyChord(input.key);
      if(input.operation==='scroll')p.direction=input.direction==='up'?'up':'down';
      p.warning='Desktop input can submit, delete, or change data in the selected window. Review the target and exact input. Unsaved work may be lost when closing.';
    }
    return p;
  }
  async dispatch(target,body,signal){
    const code=`local w=hl.get_window("address:${target.id}"); if w and w.pid==${target.pid} then ${body} else error("Window changed") end`;
    const r=await this.execute('hyprctl',['eval',code],{timeout:2500,maxBuffer:16000,signal});if(/error|failed/i.test(r.stdout))throw new Error('The compositor rejected the action: '+r.stdout.slice(0,300));return r;
  }
  async focus(target,signal){await this.dispatch(target,'hl.dispatch(hl.dsp.focus({window=w}));',signal);await sleep(100);signal?.throwIfAborted();const {stdout}=await this.execute('hyprctl',['activewindow','-j'],{timeout:2500,maxBuffer:32000,signal});if(JSON.parse(stdout).address!==target.id)throw new Error('Focus moved to another window. Input was cancelled.');}
  async executeAction(p,signal){
    signal?.throwIfAborted();
    if(p.operation==='applications')return this.applications();if(p.operation==='windows')return this.windows();
    if(p.operation==='open_app'){
      await this.applications();const a=this.catalog.get(p.application.id);if(!a||a.revision!==p.application.revision||a.path!==p.application.path)throw new Error('Application launcher changed. Request a new action.');
      await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/gio',['launch',a.path],{detached:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});return {content:'Requested launch of '+a.name+'. Inspect windows to verify it opened.'};
    }
    if(p.operation==='open_path'){const fresh=await this.prepare(p);if(fresh.path!==p.path||fresh.directory!==p.directory||JSON.stringify(fresh.opener)!==JSON.stringify(p.opener))throw new Error('The path or default application changed. Request a new action.');return openDocument(p.path,fresh.opener,signal);}
    if(p.operation.startsWith('browser_')||['open_url','web_search'].includes(p.operation))return this.browser.execute(p,signal);
    const target=await this.target(p.target.id,p.target);signal?.throwIfAborted();
    if(p.operation==='close_window'){await this.dispatch(target,'hl.dispatch(hl.dsp.window.close({window=w}));',signal);return {content:'Requested a graceful close. The application may ask about unsaved work.'};}
    if(p.operation==='focus_window'){await this.focus(target,signal);return {content:'Focused '+target.app+'.'};}
    await this.focus(target,signal);
    if(p.operation==='click'){
      await this.dispatch(target,`hl.dispatch(hl.dsp.cursor.move({x=${target.x+p.x},y=${target.y+p.y}}));`,signal);await this.target(target.id,target);signal?.throwIfAborted();
      const underPoint=(await this.clients()).filter(c=>c.mapped&&!c.hidden&&this.protected(c)&&target.x+p.x>=c.at[0]&&target.x+p.x<c.at[0]+c.size[0]&&target.y+p.y>=c.at[1]&&target.y+p.y<c.at[1]+c.size[1]);
      if(underPoint.length)throw new Error('An Aurora or protected window overlaps that point. Move or hide it, then request a new click.');
      const active=JSON.parse((await this.execute('hyprctl',['activewindow','-j'],{timeout:2500,maxBuffer:32000,signal})).stdout);if(active.address!==target.id)throw new Error('Focus changed before the click. Request a new action.');
      await this.execute('ydotool',['click',p.button==='right'?'0xC1':'0xC0'],{timeout:2000,signal,env:{...process.env,YDOTOOL_SOCKET:process.env.YDOTOOL_SOCKET||join(process.env.XDG_RUNTIME_DIR||'/run/user/'+process.getuid(),'.ydotool_socket')}});
    }else if(p.operation==='type_text')await this.execute('wtype',['--',p.text],{timeout:10000,signal});
    else if(p.operation==='key'||p.operation==='scroll'){const chord=p.chord||{mods:'',key:p.direction==='up'?'Page_Up':'Page_Down'};await this.dispatch(target,`hl.dispatch(hl.dsp.send_shortcut({window=w,mods=${JSON.stringify(chord.mods)},key=${JSON.stringify(chord.key)}}));`,signal);}
    else throw new Error('Unknown input action.');
    return {content:'Sent the requested input to '+target.app+'. Inspect the window or screen to verify the result.'};
  }
  async handle(method,input,signal){signal?.throwIfAborted();if(method==='outcome_targets')return this.outcomeTargets(input);if(method==='prepare')return this.prepare(input);if(method==='execute')return this.executeAction(input,signal);if(method==='capture')return this.capture(signal);throw new Error('Unknown desktop request.');}
}
