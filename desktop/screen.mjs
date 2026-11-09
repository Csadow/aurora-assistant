import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomic } from '../src/vault.mjs';
const run=promisify(execFile);
export function geometry(value){
  const m=String(value).trim().match(/^(-?\d{1,6}),(-?\d{1,6}) (\d{1,5})x(\d{1,5})$/);
  if(!m)throw new Error('Select a rectangular region.');
  const [x,y,width,height]=m.slice(1).map(Number);
  if(width<24||height<24||width>16000||height>16000||width*height>40000000)throw new Error('Select a region between 24 pixels and 40 megapixels.');
  return {x,y,width,height,text:`${x},${y} ${width}x${height}`};
}
export class ScreenCapture extends EventEmitter {
  constructor({encode,execute=run,now=Date.now,leaseMs=300000,settingsFile}){super();Object.assign(this,{encode,execute,now,leaseMs,settingsFile});this.generation=0;this.pending=new Set();this.preferences={persistent:false,resumeOnStart:false};this.scope=null;this.queue=Promise.resolve();}
  status(){return {active:!!this.scope,scope:this.scope,region:this.region?.text||null,expiresAt:this.expiresAt||null,...this.preferences};}
  async init(){
    this.stop({remember:false});this.preferences={persistent:false,resumeOnStart:false};
    if(!this.settingsFile)return this.status();
    try{const value=JSON.parse(await readFile(this.settingsFile,'utf8'));this.preferences={persistent:value.persistent===true,resumeOnStart:value.persistent===true&&value.resumeOnStart===true};
      if(value.enabled===true&&this.preferences.resumeOnStart){if(value.scope==='desktop')this.activate('desktop');else if(value.scope==='region')this.activate('region',geometry(value.region));}
    }catch(e){if(e.code!=='ENOENT')this.emit('problem','Screen access settings could not be restored. Access is off.');}
    return this.status();
  }
  persist(){
    if(!this.settingsFile)return Promise.resolve();
    const value=JSON.stringify({enabled:!!this.scope,scope:this.scope,region:this.region?.text||null,...this.preferences});
    const work=this.queue.then(()=>atomic(this.settingsFile,value));this.lastSave=work;
    this.queue=work.catch(()=>{this.emit('problem','Screen access changed, but its restart preference could not be saved.');});return work;
  }
  arm(){clearTimeout(this.timer);this.expiresAt=this.preferences.persistent?null:this.now()+this.leaseMs;if(this.expiresAt){this.timer=setTimeout(()=>this.stop(),this.leaseMs);this.timer.unref?.();}}
  activate(scope,region=null){this.scope=scope;this.region=region;this.arm();this.emit('change',this.status());}
  async configure(options){
    if(!options||typeof options.persistent!=='boolean'||typeof options.resumeOnStart!=='boolean'||options.resumeOnStart&&!options.persistent)throw new Error('Choose persistent access before enabling automatic startup.');
    this.preferences={persistent:options.persistent,resumeOnStart:options.resumeOnStart};if(this.scope)this.arm();this.emit('change',this.status());await this.persist();return this.status();
  }
  stop({remember=true}={}){this.generation++;clearTimeout(this.timer);for(const controller of this.pending)controller.abort();this.pending.clear();this.scope=null;this.region=null;this.expiresAt=null;this.emit('change',this.status());if(remember)this.persist().catch(()=>{});return this.status();}
  // Hiding the UI preserves persistent access but still cancels pending selection/capture.
  detach(){if(!this.scope)return this.stop({remember:false});if(!this.preferences.persistent)return this.stop();this.generation++;for(const controller of this.pending)controller.abort();this.pending.clear();return this.status();}
  async desktop(){this.stop({remember:false});this.activate('desktop');await this.persist();return this.status();}
  async select(){
    this.stop();const generation=this.generation,controller=new AbortController();this.pending.add(controller);
    try{const {stdout}=await this.execute('slurp',['-f','%x,%y %wx%h'],{timeout:60000,maxBuffer:1000,signal:controller.signal});if(generation!==this.generation)throw new Error('Screen selection stopped.');this.activate('region',geometry(stdout));await this.persist();return this.status();}finally{this.pending.delete(controller);}
  }
  async capture(){
    if(!this.scope||this.expiresAt&&this.now()>=this.expiresAt){this.stop();throw new Error('Screen access ended. Select a region again or enable the desktop.');}
    if(this.capturing)throw new Error('A capture is already in progress.');this.capturing=true;
    const generation=this.generation,controller=new AbortController();this.pending.add(controller);
    try{const args=this.scope==='desktop'?['-s','1','-']:['-g',this.region.text,'-'];const {stdout}=await this.execute('grim',args,{encoding:'buffer',maxBuffer:40000000,timeout:10000,signal:controller.signal});if(generation!==this.generation||this.expiresAt&&this.now()>=this.expiresAt)throw new Error('Screen access ended.');const jpeg=await this.encode(stdout);if(generation!==this.generation||this.expiresAt&&this.now()>=this.expiresAt)throw new Error('Screen access ended.');if(!jpeg.length||jpeg.length>1100000)throw new Error('This screen is too detailed. Select a smaller area.');return {image:jpeg.toString('base64'),capturedAt:this.now(),digest:createHash('sha256').update(jpeg).digest('hex'),scope:this.scope,region:this.region?.text||'Entire desktop'};}finally{this.pending.delete(controller);this.capturing=false;}
  }
}
