import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AvatarStore} from '../desktop/avatar.mjs';
const [model,core]=process.argv.slice(2);if(!model||!core)throw new Error('Usage: node scripts/test-avatar.mjs /path/model.model3.json /path/live2dcubismcore.min.js');
const root=fileURLToPath(new URL('../',import.meta.url)),dir=await mkdtemp(join(tmpdir(),'aurora-avatar-test-'));
try{
  const profile=join(dir,'profile'),avatars=new AvatarStore(join(profile,'avatars'));await avatars.init();await avatars.importModel(model);await avatars.importCore(core);
  const report=join(dir,'avatar.json'),env={...process.env,AURORA_DESKTOP_TEST:'1',AURORA_AVATAR_TEST:'1',AURORA_TEST_REPORT:report,AURORA_VAULT:join(dir,'vault'),AURORA_DATA:join(dir,'data'),AURORA_BACKUPS:join(dir,'backups'),AURORA_DESKTOP_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(join(homedir(),'.local/share/aurora-desktop-runtime/electron'),[root,'--class=aurora-assistant',...(env.WAYLAND_DISPLAY?['--ozone-platform=wayland']:[])],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const timeout=setTimeout(()=>child.kill('SIGKILL'),90000);const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timeout);
  let result;try{result=JSON.parse(await readFile(report,'utf8'));}catch{}await writeFile(join(root,'artifacts/avatar-native-log.txt'),output);
  if(code!==0||!result?.ok)throw new Error(JSON.stringify(result||{})+'\n'+output.slice(-9000));
  await writeFile(join(root,'artifacts/avatar-native-results.json'),JSON.stringify(result,null,2));for(const name of ['compact','chat','screen','arrange'])await copyFile(report+'.'+name+'.png',join(root,'artifacts/aurora-model-'+name+'.png'));
  console.log(JSON.stringify(result,null,2));
}finally{await rm(dir,{recursive:true,force:true});}
