import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
export const voiceRoot=join(homedir(),'.local/share/aurora-voice/whisper.cpp');
export function pcmRms(bytes){let sum=0,count=0;for(let i=0;i+1<bytes.length;i+=2){const n=bytes.readInt16LE(i);sum+=n*n;count++;}return Math.sqrt(sum/Math.max(count,1));}
export function wav(pcm){const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(pcm.length+36,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);}
export async function voiceStatus(){try{await access(join(voiceRoot,'build/bin/whisper-cli'));await access(join(voiceRoot,'models/ggml-base.bin'));return {available:true,engine:'Whisper base · local',limitSeconds:60};}catch{return {available:false,engine:'Whisper not installed',limitSeconds:60};}}
export async function transcribe(file,{signal,wake=false}={}){
  const output=file+'.transcript';
  try{
    await new Promise((resolve,reject)=>{
      const child=spawn(join(voiceRoot,'build/bin/whisper-cli'),['-m',join(voiceRoot,'models',wake?'ggml-tiny.en.bin':'ggml-base.bin'),'-f',file,'-l',wake?'en':'auto','-t','4','-ng','-nt','-otxt','-of',output,'-sns',...(wake?['--prompt','Aurora is the name of my assistant.']:[])],{stdio:['ignore','ignore','pipe'],signal});let error='';child.stderr.on('data',d=>error=(error+d).slice(-1500));const timer=setTimeout(()=>child.kill('SIGKILL'),90000);
      child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Local transcription failed. Check the voice installation.'));});
    });
    return (await readFile(output+'.txt','utf8')).trim().replace(/\[[^\]]*\]/g,'').trim();
  }finally{await rm(output+'.txt',{force:true});}
}
export function microphone(){return spawn('pw-record',['--rate','16000','--channels','1','--format','s16','--raw','-'],{stdio:['ignore','pipe','pipe']});}
export class VoiceCapture extends EventEmitter {
  constructor(deps={}){super();this.state='idle';this.generation=0;this.deps={voiceStatus,microphone,transcribe,mkdtemp,...deps};}
  update(state,extra={}){this.state=state;this.emit('update',{state,...extra});}
  async start({handsFree=false}={}){
    if(this.state!=='idle')return;
    const session={generation:++this.generation,handsFree,controller:new AbortController(),chunks:[],bytes:0,speech:0,silence:0};
    this.session=session;this.update('starting',{handsFree});
    const current=()=>this.session===session&&session.generation===this.generation;
    try{
      const status=await this.deps.voiceStatus();if(!current())return;
      if(!status.available)throw new Error('Local voice is not installed.');
      session.dir=await this.deps.mkdtemp(join(tmpdir(),'aurora-voice-'));
      if(!current()){await rm(session.dir,{recursive:true,force:true});return;}
      session.file=join(session.dir,'recording.wav');const recorder=this.deps.microphone();session.recorder=recorder;let error='';
      recorder.stderr.on('data',d=>error=(error+d).slice(-500));
      recorder.stdout.on('data',d=>{if(!current()||this.state!=='recording')return;session.chunks.push(d);session.bytes+=d.length;if(pcmRms(d)>240){session.speech+=d.length;session.silence=0;}else session.silence+=d.length;if(handsFree&&session.speech>12000&&session.silence>64000||session.bytes>1920000)this.stop();});
      session.closed=new Promise((resolve,reject)=>{recorder.on('error',reject);recorder.on('close',(code,signal)=>code===0||signal==='SIGINT'?resolve():reject(new Error(error||'Microphone recording stopped.')));});
      session.closed.catch(e=>{if(current()&&this.state==='recording'){this.cancel().catch(()=>{});this.emit('update',{state:'idle',error:e.message});}});
      this.update('recording',{handsFree});session.timer=setTimeout(()=>this.stop(),handsFree?30000:60000);
    }catch(e){if(current()){await this.cancel();throw e;}if(session.dir)await rm(session.dir,{recursive:true,force:true});}
  }
  async stop(){
    if(this.state!=='recording')return;
    const session=this.session,{handsFree,controller}=session,current=()=>this.session===session&&session.generation===this.generation;
    clearTimeout(session.timer);this.update('transcribing',{handsFree});session.recorder.kill('SIGINT');
    try{
      await session.closed;controller.signal.throwIfAborted();const pcm=Buffer.concat(session.chunks);session.chunks=[];
      if(pcm.length<4000||pcmRms(pcm)<100)throw new Error('No clear speech detected. Try again.');
      await writeFile(session.file,wav(pcm),{mode:0o600});controller.signal.throwIfAborted();
      const text=await this.deps.transcribe(session.file,{signal:controller.signal});
      if(current()){this.session=null;this.update('idle',{handsFree,text:text||'',...(text?{}:{error:'No speech detected.'})});}
    }catch(e){if(current()){this.session=null;this.update('idle',{error:e.name==='AbortError'?'Recording cancelled.':e.message});}}
    finally{await rm(session.dir,{recursive:true,force:true});}
  }
  async cancel(){
    const session=this.session;this.session=null;this.generation++;
    if(session){clearTimeout(session.timer);session.controller.abort();session.recorder?.kill('SIGKILL');session.chunks=[];}
    // Publish cancellation before cleanup; a newer recording owns its own state and resources.
    this.update('idle');if(session?.dir)await rm(session.dir,{recursive:true,force:true});
  }
}
