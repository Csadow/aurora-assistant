import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { microphone, pcmRms, wav, transcribe, voiceRoot } from './voice.mjs';
export function wakeMatch(text){const match=String(text).match(/(?:^|[.!?]\s*|\s)(?:hey|hi|okay|ok)[,\s]+(?:aurora|a\s*rora)\b[,.!?:\s-]*([\s\S]*)/i);return match?{text:match[1].trim()}:null;}
export class WakeListener extends EventEmitter {
  constructor(deps={}){super();this.enabled=false;this.starting=false;this.buffer=Buffer.alloc(0);this.processing=null;this.generation=0;this.deps={access,microphone,transcribe,...deps};}
  async start(){
    if(this.enabled||this.starting)return;const generation=++this.generation;this.starting=true;
    try{
      await this.deps.access(join(voiceRoot,'models/ggml-tiny.en.bin'));if(generation!==this.generation)return;
      this.controller=new AbortController();this.buffer=Buffer.alloc(0);const recorder=this.deps.microphone();this.recorder=recorder;this.enabled=true;
      const current=()=>this.enabled&&generation===this.generation&&this.recorder===recorder;
      recorder.stdout.on('data',d=>{if(!current())return;this.buffer=Buffer.concat([this.buffer,d]);if(this.buffer.length>192000)this.buffer=this.buffer.subarray(this.buffer.length-192000);});
      recorder.stderr.resume();
      const failed=()=>{if(current()){this.stop();this.emit('problem','Wake listening stopped: microphone unavailable.');}};
      recorder.on('error',failed);recorder.on('close',failed);
      this.timer=setInterval(()=>this.check(),3000);this.emit('state',true);
    }catch(e){if(generation===this.generation){this.stop();throw e;}}
    finally{if(generation===this.generation)this.starting=false;}
  }
  async check(){
    if(!this.enabled||this.processing!==null||this.buffer.length<64000||pcmRms(this.buffer)<200)return;
    const generation=this.generation,controller=this.controller,pcm=Buffer.from(this.buffer);this.processing=generation;let dir;
    const current=()=>this.enabled&&generation===this.generation;
    try{dir=await mkdtemp(join(tmpdir(),'aurora-wake-'));controller.signal.throwIfAborted();const file=join(dir,'window.wav');await writeFile(file,wav(pcm),{mode:0o600});controller.signal.throwIfAborted();const text=await this.deps.transcribe(file,{wake:true,signal:controller.signal});if(!current())return;if(wakeMatch(text)){const verified=await this.deps.transcribe(file,{signal:controller.signal});if(!current())return;const match=wakeMatch(verified);if(match){this.stop();this.emit('wake',match);}}}
    catch(e){if(current()&&e.name!=='AbortError'){this.stop();this.emit('problem','Wake recognition failed. Use the voice shortcut or restart listening.');}}
    finally{if(this.processing===generation)this.processing=null;if(dir)await rm(dir,{recursive:true,force:true});}
  }
  stop(){this.enabled=false;this.starting=false;this.generation++;clearInterval(this.timer);this.controller?.abort();const recorder=this.recorder;this.recorder=null;recorder?.kill('SIGKILL');this.buffer=Buffer.alloc(0);this.emit('state',false);}
}
