import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AppError} from './vault.mjs';
const execute=promisify(execFile);
export class Recovery {
  constructor({vault,data,profile,destination,source=new URL('../',import.meta.url).pathname}){Object.assign(this,{vault,data,profile,destination,source});}
  async create(){
    if(this.running)throw new AppError('A recovery bundle is already being created.',409);
    this.running=new AbortController();
    try{
      const args=[new URL('../scripts/recovery.py',import.meta.url).pathname,'create'];
      for(const key of ['vault','data','profile','destination','source'])args.push('--'+key,this[key]);
      const {stdout}=await execute('python3',args,{signal:this.running.signal,timeout:120000,maxBuffer:16000});return JSON.parse(stdout);
    }catch(e){throw new AppError(e.name==='AbortError'?'Recovery bundle stopped.':String(e.stderr||e.message).slice(-1000),503);}
    finally{this.running=null;}
  }
  stop(){this.running?.abort();}
}
