import { readdir, realpath, open, stat, lstat, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { AppError, atomic, sha } from './vault.mjs';
import {filePatch} from './file-patch.mjs';

export function redact(text){return String(text).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[private key removed]').replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,'[credential removed]').replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret|password|authorization)\s*[=:]\s*)[^\n]+/gi,'$1[redacted]');}
export class SystemAccess {
  constructor({data,home=homedir(),blocked=[]}){this.home=home;this.data=data;this.blocked=[data,join(home,'.config/aurora-assistant'),resolve(new URL('..',import.meta.url).pathname),...blocked].map(p=>resolve(p));}
  allowed(path){
    const p=resolve(path);
    if(['/proc','/sys','/dev','/run','/root','/etc/shadow','/etc/gshadow','/etc/ssl/private'].some(x=>p===x||p.startsWith(x+'/'))||this.blocked.some(x=>p===x||p.startsWith(x+'/')))throw new AppError('This path is protected from assistant access.',403);
    if(p.split('/').some(s=>/^(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.codex|\.git|\.mozilla|\.pki|keyrings|chromium|google-chrome|BraveSoftware)$/i.test(s)||/^\.env(?:\.|$)/i.test(s)||/(?:credential|password|secret|token|auth\.json|\.pem$|\.key$|\.kdbx$|history$)/i.test(s)))throw new AppError('Credentials, browser profiles, and private configuration are protected.',403);
    return p;
  }
  async path(input,{missing=false}={}){
    if(typeof input!=='string'||!input||input.length>4096||/[\x00-\x1f]/.test(input))throw new AppError('Use an absolute file path.');
    const expanded=input==='~'?this.home:input.startsWith('~/')?join(this.home,input.slice(2)):input;
    if(!isAbsolute(expanded))throw new AppError('Use an absolute file path.');
    const p=this.allowed(expanded);
    try{return this.allowed(await realpath(p));}catch(e){if(e.code==='ENOENT'&&missing)return this.allowed(join(await realpath(dirname(p)),basename(p)));if(e.code==='ENOENT')throw new AppError('Path not found.',404);throw e;}
  }
  async read(input,{offset=0,limit=24000}={}){
    if(!Number.isInteger(offset)||offset<0||offset>262144||!Number.isInteger(limit)||limit<1||limit>262144)throw new AppError('Use a valid text offset and read limit.');
    const path=await this.path(input);let handle;
    try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=await handle.stat();if(!info.isFile()||info.size>262144)throw new AppError('Read a regular text file of at most 256 KiB.');
      const bytes=await handle.readFile();if(bytes.includes(0))throw new AppError('This appears to be a binary file.');const raw=bytes.toString('utf8');if(!Buffer.from(raw).equals(bytes))throw new AppError('This file is not valid UTF-8 text. Edit it with an application that supports its encoding.');const safe=redact(raw),end=Math.min(safe.length,offset+limit);return {path,content:safe.slice(offset,end),revision:sha(raw),offset,totalCharacters:safe.length,nextOffset:end<safe.length?end:null,truncated:offset>0||end<safe.length};
    }finally{await handle?.close();}
  }
  async list(input){const path=await this.path(input),entries=await readdir(path,{withFileTypes:true});return {path,entries:entries.filter(e=>{try{this.allowed(join(path,e.name));return true;}catch{return false;}}).slice(0,150).map(e=>({name:e.name,type:e.isDirectory()?'directory':e.isSymbolicLink()?'link':'file'})),truncated:entries.length>150};}
  async search(input,query,signal){
    if(typeof query!=='string'||!query.trim()||query.length>100)throw new AppError('Use a filename search of 1–100 characters.');
    const root=await this.path(input),queue=[root],matches=[];let scanned=0;
    while(queue.length&&scanned<150&&matches.length<60){signal?.throwIfAborted();const dir=queue.shift();let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{continue;}scanned++;
      for(const e of entries){if(e.isSymbolicLink()||['node_modules','.cache','.venv','venv','dist','build'].includes(e.name))continue;const path=join(dir,e.name);try{this.allowed(path);}catch{continue;}
        if(e.name.toLowerCase().includes(query.toLowerCase()))matches.push({path,type:e.isDirectory()?'directory':'file'});
        if(e.isDirectory()&&queue.length<300)queue.push(path);if(matches.length>=60)break;
      }
    }return {matches,limited:queue.length>0,warning:'Filename search only; protected files and large dependency folders are skipped.'};
  }
  async searchContent(input,query,signal){
    if(typeof query!=='string'||!query.trim()||query.length>160||/[\x00-\x1f]/.test(query))throw new AppError('Search for a line of literal text, 1–160 characters.');
    const root=await this.path(input),queue=[root],matches=[];let directories=0,files=0,characters=0,limited=false;
    const needle=query.toLowerCase(),skip=new Set(['node_modules','.cache','.venv','venv','dist','build','__pycache__','.git']);
    scan:while(queue.length){
      signal?.throwIfAborted();if(directories++>=100){limited=true;break;}
      let entries;try{entries=await readdir(queue.shift(),{withFileTypes:true});}catch{continue;}
      for(const entry of entries){
        signal?.throwIfAborted();if(entry.isSymbolicLink()||skip.has(entry.name))continue;
        const path=join(entry.parentPath,entry.name);try{this.allowed(path);}catch{continue;}
        if(entry.isDirectory()){if(queue.length<200)queue.push(path);else limited=true;continue;}
        if(!entry.isFile())continue;
        if(files++>=200||characters>=2000000||matches.length>=40){limited=true;break scan;}
        let result;try{result=await this.read(path,{limit:Math.min(262144,2000000-characters)});}catch{continue;}
        characters+=result.content.length;if(result.truncated)limited=true;
        const lines=result.content.split('\n');
        for(let i=0;i<lines.length;i++)if(lines[i].toLowerCase().includes(needle)){
          const at=lines[i].toLowerCase().indexOf(needle);matches.push({path:result.path,line:i+1,excerpt:lines[i].slice(Math.max(0,at-100),at+300),revision:result.revision});
          if(matches.length>=40){limited=true;break scan;}
        }
      }
    }
    return {root,query,matches,scannedFiles:files,limited,warning:'Literal text search; protected paths, symlinks, dependencies and non-text files are skipped.'};
  }
  async prepareWrite(input,content){
    if(typeof content!=='string'||Buffer.byteLength(content)>64000)throw new AppError('A proposed file edit must be text, up to 64 KiB.');
    const path=await this.path(input,{missing:true});let original=null,mode=0o600;
    try{const info=await lstat(path);if(!info.isFile()||info.nlink>1)throw new AppError('Edit only ordinary files with a single hard link.');const result=await this.read(path);if(result.truncated)throw new AppError('This file is too large for a complete edit preview.');if(result.revision!==sha(result.content))throw new AppError('This file appears to contain credentials; edit it manually.',403);original=result.content;mode=info.mode&0o777;}catch(e){if(e.code!=='ENOENT'&&e.status!==404)throw e;}
    if(redact(content)!==content||original!==null&&redact(original)!==original)throw new AppError('This file appears to contain credentials; edit it manually.',403);
    return {path,content,before:original,revision:original===null?null:sha(original),mode};
  }
  async write(payload,id,signal){
    signal?.throwIfAborted();
    const fresh=await this.prepareWrite(payload.path,payload.content);
    if(fresh.path!==payload.path||fresh.revision!==payload.revision)throw new AppError('The file changed after this edit was proposed. Ask for a new proposal.',409);
    signal?.throwIfAborted();
    let backup=null;if(fresh.before!==null){const dir=join(this.data,'action-backups');await mkdir(dir,{recursive:true,mode:0o700});backup=join(dir,id+'.txt');await writeFile(backup,fresh.before,{flag:'wx',mode:0o600});}
    await atomic(payload.path,payload.content,{mode:fresh.mode,signal,beforeCommit:async()=>{const final=await this.prepareWrite(payload.path,payload.content);if(final.path!==payload.path||final.revision!==payload.revision||final.mode!==fresh.mode)throw new AppError('The file changed before saving. Ask for a new proposal.',409);}});
    return {committed:true,path:payload.path,backup,content:'File saved. '+(backup?'The original has a local recovery copy.':'A new file was created.')};
  }
  async preparePatch(input,revision,edits){
    if(typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision))throw new AppError('Use the exact file revision from a recent complete read.');
    const original=await this.prepareWrite(input,'');
    if(original.before===null)throw new AppError('Targeted replacements require an existing file. Use a complete file proposal to create one.');
    if(original.revision!==revision)throw new AppError('The file changed since that read. Read it again before proposing replacements.',409);
    const patch=filePatch(original.before,edits),payload=await this.prepareWrite(original.path,patch.content);
    if(payload.revision!==revision)throw new AppError('The file changed while preparing this replacement. Read it again.',409);
    return {...payload,patch:{revision,changes:patch.changes,diff:patch.diff}};
  }
  async prepareCommand(program,args,cwd){
    if(typeof program!=='string'||!/^[\w./+-]+$/.test(program)||!Array.isArray(args)||args.length>40||args.some(a=>typeof a!=='string'||a.length>8000||/[\x00-\x1f]/.test(a)))throw new AppError('Supply an executable and an array of plain arguments. Shell expansion is not automatic.');
    if(['sudo','su','doas','pkexec','shutdown','reboot','poweroff','halt','mkfs','fdisk','parted','dd'].some(n=>basename(program)===n||basename(program).startsWith(n+'.')))throw new AppError('Administrator, power, and disk-formatting commands must be run manually.',403);
    let executable;
    for(const candidate of isAbsolute(program)?[program]:['/usr/bin','/bin','/usr/local/bin'].map(dir=>join(dir,program))){try{executable=await realpath(candidate);if((await stat(executable)).isFile())break;}catch{}}
    if(!executable)throw new AppError('Executable not found.');
    const path=await this.path(cwd||this.home);if(!(await stat(path)).isDirectory())throw new AppError('Working directory must be a folder.');
    return {program:executable,args,cwd:path,warning:'Runs with your Linux user permissions. It may change or delete files, use the network, or launch other programs. Review every argument. No automatic rollback.'};
  }
  async routine(name,value){
    const commands={disk:['df',['-h']],memory:['free',['-h']],uptime:['uptime',[]],volume:['wpctl',['get-volume','@DEFAULT_AUDIO_SINK@']],mute:['wpctl',['set-mute','@DEFAULT_AUDIO_SINK@','1']],unmute:['wpctl',['set-mute','@DEFAULT_AUDIO_SINK@','0']],pause_media:['playerctl',['pause']],play_media:['playerctl',['play']],next_track:['playerctl',['next']],previous_track:['playerctl',['previous']]};
    if(name==='set_volume'){const n=Number(value);if(!Number.isInteger(n)||n<0||n>80)throw new AppError('Automatic volume changes must be between 0 and 80 percent.');commands.set_volume=['wpctl',['set-volume','-l','0.8','@DEFAULT_AUDIO_SINK@',`${n}%`]];}
    if(!Object.hasOwn(commands,name))throw new AppError('This is not an automatic routine action.');
    const [program,args]=commands[name];return this.prepareCommand(program,args,this.home);
  }
}

export function runCommand(payload,{signal,timeout=45000,onStart}={}){
  return new Promise((resolve,reject)=>{
    const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:homedir(),LANG:process.env.LANG||'C.UTF-8'};
    for(const k of ['USER','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','WAYLAND_DISPLAY','DISPLAY'])if(process.env[k])env[k]=process.env[k];
    const child=spawn('/usr/bin/setpriv',['--no-new-privs','--',payload.program,...payload.args],{cwd:payload.cwd,env,detached:true,stdio:['ignore','pipe','pipe']});let output='',truncated=false,stopped=false;
    const stop=()=>{stopped=true;try{process.kill(-child.pid,'SIGKILL');}catch{}};
    const timer=setTimeout(stop,timeout);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    onStart?.(stop);
    const collect=d=>{if(output.length<32000)output+=d.toString().slice(0,32000-output.length);else{truncated=true;stop();}};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.on('error',e=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(new AppError('Could not start the command: '+e.message));});
    child.on('close',(code,exitSignal)=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);try{process.kill(-child.pid,'SIGKILL');}catch{}resolve({code,signal:exitSignal,stopped,truncated,content:redact(output)||'(No output)'});});
  });
}
