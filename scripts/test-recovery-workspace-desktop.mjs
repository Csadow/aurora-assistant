import '../src/environment.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),binary=join(homedir(),'.local/share/aurora-desktop-runtime/electron');
const dir=await mkdtemp(join(tmpdir(),'aurora-recovery-workspace-desktop-'));const reports=[];
try{for(const phase of ['first','restart']){
  const report=join(dir,phase+'.json');const env={...process.env,AURORA_DESKTOP_TEST:'1',AURORA_RECOVERY_WORKSPACE_TEST:'1',AURORA_TEST_PHASE:phase,AURORA_TEST_REPORT:report,AURORA_VAULT:join(dir,'vault'),AURORA_DATA:join(dir,'data'),AURORA_BACKUPS:join(dir,'backups'),AURORA_DESKTOP_DATA:join(dir,'profile')};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(binary,[root,'--class=aurora-assistant',...(env.WAYLAND_DISPLAY?['--ozone-platform=wayland']:[]),'--disable-gpu'],{env,stdio:['ignore','pipe','pipe']});let output='',lastProgress=Date.now(),timedOut=false;let progressBuffer='';child.stdout.on('data',d=>{output+=d;if(String(d).includes('DESKTOP_PROGRESS '))lastProgress=Date.now();progressBuffer+=d;let end;while((end=progressBuffer.indexOf('\n'))>=0){const line=progressBuffer.slice(0,end);progressBuffer=progressBuffer.slice(end+1);if(line.startsWith('DESKTOP_PROGRESS ')){try{const p=JSON.parse(line.slice(17));if(p.checks%25===0)console.log('PROGRESS desktop '+phase+': '+p.checks+' checks · '+p.elapsedMs+' ms');}catch{}}}});child.stderr.on('data',d=>output+=d);
  // Keep the same phase limit and progress watchdog as the full native suite.
  const stop=()=>{timedOut=true;child.kill('SIGKILL');};const timeout=setTimeout(stop,360000),watchdog=setInterval(()=>{if(Date.now()-lastProgress>45000)stop();},1000);const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timeout);clearInterval(watchdog);if(timedOut)output+='\nDesktop '+phase+' exceeded its progress or total timeout.';
  let result;try{result=JSON.parse(await readFile(report,'utf8'));}catch{}if(code!==0||!result?.ok)throw new Error(JSON.stringify(result||{})+'\n'+output.slice(-7000));const windowState=JSON.parse(await readFile(join(dir,'profile/window.json'),'utf8'));if(!(windowState.width>0&&windowState.height>0))throw new Error('Main window settings were not durably saved');result.checks.push('main window settings are complete after graceful exit');reports.push(result);console.log('PASS desktop '+phase+': '+JSON.stringify(result.checks));
  await copyFile(report+'.png',join(root,'artifacts/recovery-workspace-native-'+phase+'.png'));
}await writeFile(join(root,'artifacts/recovery-workspace-native-focused-results.json'),JSON.stringify(reports,null,2));}finally{await rm(dir,{recursive:true,force:true});}
