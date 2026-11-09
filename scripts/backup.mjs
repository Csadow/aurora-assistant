import { config } from '../src/config.mjs';
import { backup as createBackup } from '../src/backups.mjs';
export function backup(options={}){return createBackup({vault:config.vault,data:config.data,destination:config.backups,...options});}
if(process.argv[1]===new URL(import.meta.url).pathname){try{console.log(await backup());}catch(e){console.error(e.message);process.exitCode=1;}}
