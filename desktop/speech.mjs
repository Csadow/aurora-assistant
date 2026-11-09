import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {access,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {atomic} from '../src/vault.mjs';

const root=join(homedir(),'.local/share/aurora-voice/piper');
const python=join(root,'venv/bin/python'),model=join(root,'en_GB-jenny_dioco-medium.onnx');
const helper=fileURLToPath(new URL('../scripts/synthesize.py',import.meta.url));
const defaults={muted:false,rate:1,volume:0.75,lipSync:true};
export function speechText(value){
  if(typeof value!=='string'||value.length>64000)throw new Error('Choose a reply under 64,000 characters.');
  let text=value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g,' ').replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g,' ')
    .replace(/<[^>]*>/g,' ').replace(/!\[[^\]]*\]\([^)]*\)/g,' ').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/https?:\/\/\S+/g,' ').replace(/`[^`]*`/g,' ').replace(/^\s*\|.*$/gm,' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm,'').replace(/\[(?:\d+|[MSP]\d+)\]/g,'')
    .replace(/[*_~]/g,'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  const truncated=text.length>3000;
  if(truncated){const clipped=text.slice(0,2950),end=Math.max(clipped.lastIndexOf('. '),clipped.lastIndexOf('! '),clipped.lastIndexOf('? '));text=(end>1800?clipped.slice(0,end+1):clipped.slice(0,clipped.lastIndexOf(' ')))+' The rest is in chat.';}
  if(!/[\p{L}\p{N}]/u.test(text))throw new Error('This reply has no prose to read aloud. Code blocks and tables stay in chat.');
  return {text,truncated};
}
export async function speechStatus(){
  try{await Promise.all([python,model,model+'.json','/usr/bin/pw-play'].map(p=>access(p)));return {available:true,voice:'Jenny (Dioco)',language:'English',engine:'Piper · local'};}
  catch{return {available:false,voice:'Jenny (Dioco)',language:'English',engine:'Piper · local',error:'Install the local voice with node scripts/install-speech.mjs.'};}
}
// Await process exit after cancellation: replacement speech can never overlap its predecessor.
function childRun(program,args,{input,signal,timeout,maxBytes=20000000,onSpawn}={}){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{stdio:['pipe','pipe','pipe'],env:{...process.env,OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'}});
    const chunks=[];let size=0,failure,killTimer,finished=false;
    const stop=error=>{failure??=error;child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),400);};
    const abort=()=>stop(signal.reason||new Error('Speech stopped.'));
    const timer=setTimeout(()=>stop(new Error('Local speech timed out.')),timeout);
    const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(Buffer.concat(chunks));};
    child.once('error',finish);child.once('close',code=>finish(failure||(code!==0?new Error('Local speech process failed.'):undefined)));
    child.stderr.resume();child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)stop(new Error('Local speech exceeded its audio limit.'));else chunks.push(chunk);});
    child.stdin.on('error',()=>{});child.once('spawn',()=>{if(!signal?.aborted)onSpawn?.();});
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();else child.stdin.end(input);
  });
}
export async function synthesize(text,settings,signal){
  const bytes=await childRun(python,[helper,model],{input:JSON.stringify({text,rate:settings.rate}),signal,timeout:120000});
  if(bytes.length<14||bytes.toString('ascii',0,4)!=='AUR1'||bytes.readUInt32LE(4)!==22050||bytes.readUInt32LE(8)!==1||(bytes.length-12)%2)throw new Error('The local voice returned invalid audio.');
  return {pcm:bytes.subarray(12),sampleRate:22050};
}
export function mouthLevel(pcm,sampleRate,seconds){
  const start=Math.floor(Math.max(0,seconds)*sampleRate)*2,end=Math.min(pcm.length,start+Math.floor(sampleRate*.04)*2);let sum=0;
  if(start>=end||seconds<0)return 0;
  for(let i=start;i<end;i+=2){const x=pcm.readInt16LE(i)/32768;sum+=x*x;}
  const rms=Math.sqrt(sum/((end-start)/2));return Math.max(0,Math.min(1,(rms-.007)*7));
}
export async function playSpeech(audio,settings,signal,onLevel){
  let timer;
  try{await childRun('/usr/bin/pw-play',['--raw','--rate',String(audio.sampleRate),'--channels','1','--format','s16','--latency','50ms','--volume',String(settings.volume),'-'],{
    input:audio.pcm,signal,timeout:Math.ceil(audio.pcm.length/(audio.sampleRate*2)*1000)+15000,
    onSpawn:()=>{const start=performance.now()+80;timer=setInterval(()=>onLevel(settings.lipSync&&settings.volume>0?mouthLevel(audio.pcm,audio.sampleRate,(performance.now()-start)/1000):0),40);}
  });}finally{clearInterval(timer);onLevel(0);}
}
export class Speech extends EventEmitter{
  constructor({file,status=speechStatus,synthesize:synth=synthesize,play=playSpeech}={}){super();this.file=file;this.check=status;this.synth=synth;this.play=play;this.settings={...defaults};this.state='idle';this.generation=0;this.pending=Promise.resolve();this.saving=Promise.resolve();this.error='';this.level=0;this.truncated=false;}
  async init(){if(this.file)try{const saved=JSON.parse(await readFile(this.file,'utf8'));this.settings=this.validate(saved);}catch(e){if(e.code==='ENOENT')await atomic(this.file,JSON.stringify(this.settings));else{this.settings={...defaults,muted:true};this.error='Saved speech settings could not be read. Speech is muted.';}}return this.snapshot();}
  validate(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(defaults,k)))throw new Error('Invalid speech settings.');
    const next={...this.settings,...value};
    if(typeof next.muted!=='boolean'||typeof next.lipSync!=='boolean'||!Number.isFinite(next.rate)||next.rate<.8||next.rate>1.3||!Number.isFinite(next.volume)||next.volume<0||next.volume>1)throw new Error('Invalid speech settings.');
    return next;
  }
  snapshot(){return {state:this.state,busy:this.state!=='idle',settings:{...this.settings},error:this.error,truncated:this.truncated};}
  update(){this.emit('update',this.snapshot());}
  frame(level){this.level=level;this.emit('frame',{active:this.state==='speaking'&&this.settings.lipSync&&!this.settings.muted,level});}
  async configure(value){const next=this.validate(value);const stopping=this.stop();this.settings=next;this.error='';this.update();if(this.file){const bytes=JSON.stringify(next);const saving=this.saving.catch(()=>{}).then(()=>atomic(this.file,bytes));this.saving=saving;await saving;}await stopping;return this.snapshot();}
  stop(){this.generation++;this.controller?.abort();this.state='idle';this.owner=null;this.frame(0);this.update();return this.pending.catch(()=>{});}
  async close(){await this.stop();await this.saving.catch(()=>{});}
  async say(value,owner){
    const prepared=speechText(value);if(this.settings.muted)throw new Error('Speech is muted. Unmute it before reading aloud.');
    const previous=this.stop(),generation=this.generation,controller=new AbortController();this.controller=controller;this.owner=owner;this.state='synthesizing';this.error='';this.truncated=prepared.truncated;this.update();
    const current=()=>generation===this.generation&&!controller.signal.aborted;
    const job=(async()=>{
      await previous;if(!current())return;
      const status=await this.check();if(!current())return;if(!status.available)throw new Error(status.error||'Local speech is not installed.');
      const audio=await this.synth(prepared.text,this.settings,controller.signal);if(!current())return;
      this.state='speaking';this.update();await this.play(audio,this.settings,controller.signal,level=>{if(current())this.frame(Math.max(0,Math.min(1,Number(level)||0)));});
    })().catch(e=>{if(current())this.error=e.message||'Local speech failed.';}).finally(()=>{if(current()){this.state='idle';this.owner=null;this.frame(0);this.update();}});
    this.pending=job;
    return {...this.snapshot(),accepted:true};
  }
}
