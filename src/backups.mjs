import { spawn } from 'node:child_process';
import { mkdir, open, rename, rm, realpath, readdir, lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './vault.mjs';

export async function backup({vault,data,destination,timeout=120000,signal,spawnImpl=spawn}){
  signal?.throwIfAborted();
  await mkdir(destination,{recursive:true,mode:0o700});
  const [v,d,target]=await Promise.all([vault,data,destination].map(p=>realpath(p)));
  if([v,d].some(p=>target===p||target.startsWith(p+'/')))throw new AppError('Choose a backup folder outside the vault and application data.');
  if(basename(v)===basename(d))throw new AppError('Vault and data folders must have different names for restoration.');
  const file=join(target,`aurora-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.tar.gz`),temp=file+'.partial';
  const handle=await open(temp,'wx',0o600);
  try{
    signal?.throwIfAborted();
    await new Promise((resolve,reject)=>{
      const child=spawnImpl('tar',['-czf','-','--exclude=ollama.log','--exclude=integrations.json','--exclude=integrations.json.*','--exclude=google-calendar-auth.json','--exclude=google-calendar-auth.json.*','--exclude=chatgpt-plan-auth.json','--exclude=chatgpt-plan-auth.json.*','--exclude=*.tmp','-C',dirname(v),'./'+basename(v),'-C',dirname(d),'./'+basename(d)],{stdio:['ignore',handle.fd,'pipe']});
      let error='',timedOut=false;const stop=()=>child.kill('SIGKILL');
      const timer=setTimeout(()=>{timedOut=true;stop();},timeout);
      signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
      const clear=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);};
      child.stderr.on('data',d=>error=(error+d).slice(-2000));
      child.once('error',e=>{clear();reject(new AppError('Could not start backup: '+e.message,503));});
      child.once('close',code=>{clear();if(signal?.aborted)return reject(signal.reason);if(timedOut)return reject(new AppError('Backup timed out. No partial archive was kept.',503));code===0?resolve():reject(new AppError('Backup failed; no partial archive was kept. Files may have changed during backup. Retry when Aurora is idle. '+error,503));});
    });
    await handle.sync();await handle.close();signal?.throwIfAborted();await rename(temp,file);return file;
  }finally{await handle.close().catch(()=>{});await rm(temp,{force:true});}
}
export class Backups {
  constructor(options){this.options=options;this.running=false;this.controller=null;}
  async list(){
    let names;try{names=await readdir(this.options.destination);}catch(e){if(e.code==='ENOENT')return [];throw e;}
    const entries=[];
    for(const name of names.filter(n=>/^(?:(?:aurora|aster)-[\w.-]+\.tar\.gz|aurora-recovery-[\w.-]+\.zip)$/.test(n))){
      try{const path=join(this.options.destination,name),s=await lstat(path);if(s.isFile())entries.push({name,path,kind:name.endsWith('.zip')?'recovery':'memory',bytes:s.size,created:s.mtime.toISOString(),private:(s.mode&0o077)===0});}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    return entries.sort((a,b)=>b.created.localeCompare(a.created)||b.name.localeCompare(a.name)).slice(0,200);
  }
  async create(){
    if(this.running)throw new AppError('A backup is already running.',409);
    this.running=true;this.controller=new AbortController();
    try{const path=await backup({...this.options,signal:this.controller.signal});return {path,created:new Date().toISOString()};}
    finally{this.running=false;this.controller=null;}
  }
  stop(){this.controller?.abort();}
}
