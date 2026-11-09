import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=await mkdtemp(join(tmpdir(),'aurora-computer-native-'));
try{
 const report=join(dir,'report.json'),env={...process.env,AURORA_DESKTOP_TEST:'1',AURORA_COMPUTER_TEST:'1',AURORA_TEST_REPORT:report,AURORA_VAULT:join(dir,'vault'),AURORA_DATA:join(dir,'data'),AURORA_BACKUPS:join(dir,'backups'),AURORA_DESKTOP_DATA:join(dir,'profile')};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(join(homedir(),'.local/share/aurora-desktop-runtime/electron'),[root,'--class=aurora-assistant',...(env.WAYLAND_DISPLAY?['--ozone-platform=wayland']:[])],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);const timer=setTimeout(()=>child.kill('SIGKILL'),120000);const code=await new Promise((r,j)=>{child.on('exit',r);child.on('error',j);});clearTimeout(timer);
 let result;try{result=JSON.parse(await readFile(report,'utf8'));}catch{}await writeFile(join(root,'artifacts/computer-native-log.txt'),output);if(code!==0||!result?.ok)throw new Error(JSON.stringify(result||{})+'\n'+output.slice(-7000));
 await writeFile(join(root,'artifacts/computer-native-results.json'),JSON.stringify(result,null,2));await copyFile(report+'.png',join(root,'artifacts/computer-browser-native.png'));console.log(JSON.stringify(result,null,2));
}finally{await rm(dir,{recursive:true,force:true});}
