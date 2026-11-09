// Explicitly selected notes only; never package the entire private vault implicitly.
import {writeFile,access} from 'node:fs/promises';
import {Vault} from '../src/vault.mjs';
import {config} from '../src/config.mjs';
import {MobileTransfers} from '../src/mobile-transfers.mjs';
const [destination,...paths]=process.argv.slice(2);
if(!destination || !paths.length){console.error('Usage: node scripts/mobile-memory-export.mjs OUTPUT.json "10 Profile/About me.md" [other note paths]');process.exit(1);}
try{await access(destination);throw Error('Destination already exists. Choose a new filename.');}catch(e){if(e.code!=='ENOENT')throw e;}
const transfers=new MobileTransfers({vault:new Vault(config.vault),data:config.data});await transfers.init();
const {bundle}=await transfers.export(paths),content=JSON.stringify(bundle,null,2);
await writeFile(destination,content,{flag:'wx',mode:0o600});console.log(`Exported ${bundle.notes.length} selected Markdown notes to ${destination}. No cloud request was made.`);
