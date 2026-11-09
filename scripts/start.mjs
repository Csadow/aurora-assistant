import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { Ollama } from '../src/ollama.mjs';

let engine;
await mkdir(config.data,{recursive:true,mode:0o700});
const ollama=new Ollama(config.ollama,config.model);
if(!(await ollama.status()).online){
  const binary=join(config.runtime,'runtime/bin/ollama');
  try{
    await access(binary);
    const log=createWriteStream(join(config.data,'ollama.log'),{flags:'a',mode:0o600});
    engine=spawn(binary,['serve'],{env:{...process.env,OLLAMA_HOST:new URL(config.ollama).host,OLLAMA_MODELS:join(config.runtime,'models'),OLLAMA_NO_CLOUD:'1',OLLAMA_NUM_PARALLEL:'1',OLLAMA_MAX_LOADED_MODELS:'2',OLLAMA_CONTEXT_LENGTH:'12288'},stdio:['ignore','pipe','pipe']});
    engine.stdout.pipe(log,{end:false});engine.stderr.pipe(log,{end:false});engine.once('exit',()=>log.end());engine.on('error',e=>console.error('Ollama:',e.message));
    for(let i=0;i<40;i++){if((await ollama.status()).online)break;if(engine.exitCode!==null)break;await new Promise(r=>setTimeout(r,300));}
  }catch(e){console.error('Local model could not start:',e.message);}
}
const {server}=await createApp();
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`Aurora is already using port ${config.port}.`:e);engine?.kill();process.exitCode=1;});
server.listen(config.port,'127.0.0.1',()=>console.log(`Aurora: http://127.0.0.1:${config.port}\nMemory: ${config.vault}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{engine?.kill('SIGTERM');server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();});
