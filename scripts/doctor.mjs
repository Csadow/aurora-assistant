import {LocalModels} from '../src/models.mjs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config.mjs';
import { Ollama } from '../src/ollama.mjs';
const model=new Ollama(config.ollama,config.model);await new LocalModels({data:config.data,ollama:model}).init();const status=await model.status();
console.log(`Aurora: http://127.0.0.1:${config.port}\nNode: ${process.version}\nVault: ${config.vault}\nState: ${config.data}\nRuntime: ${config.runtime}`);
for(const [name,path] of [['Vault',config.vault],['Ollama binary',join(config.runtime,'runtime/bin/ollama')]]){try{await access(path);console.log(`${name}: present`);}catch{console.log(`${name}: missing`);process.exitCode=1;}}
console.log(`Ollama: ${status.online?'online':'offline'}`);
for(const name of [model.model,config.embedding].filter(Boolean)){const found=status.models.some(m=>m.name===name);console.log(`${name}: ${found?'installed':'missing'}`);if(!found)process.exitCode=1;}
try{const s=await(await fetch(`http://127.0.0.1:${config.port}/api/status`,{signal:AbortSignal.timeout(3000)})).json();console.log(`App: online\nMemory search: ${s.recall}${s.recallError?' — '+s.recallError:''}`);}catch{console.log('App: offline. Launch Aurora from your desktop or run node scripts/start.mjs.');process.exitCode=1;}
