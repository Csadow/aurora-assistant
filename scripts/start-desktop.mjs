import '../src/environment.mjs';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));const binary=process.env.AURORA_ELECTRON||join(homedir(),'.local/share/aurora-desktop-runtime/electron');
try{await access(binary);}catch{console.error('Desktop runtime missing. Run node scripts/install-desktop.mjs first.');process.exit(1);}
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(binary,[root,'--class=aurora-assistant',...(env.WAYLAND_DISPLAY?['--ozone-platform=wayland']:[]),...process.argv.slice(2)],{env,stdio:'inherit'});
child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',code=>process.exit(code??0));for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
