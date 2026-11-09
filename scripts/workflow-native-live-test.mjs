import '../src/environment.mjs';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,copyFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const artifactPrefix=process.env.AURORA_OUTPUT_REQUIREMENTS==='1'?'requirements-native':process.env.AURORA_OUTPUT_REQUIREMENTS==='format'?'formatted-native':'workflow-native';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=await mkdtemp(join(tmpdir(),'aurora-workflow-native-')),runId=new Date().toISOString().replaceAll(/[:.]/g,'-');
const source={};for(const file of ['src/workflows.mjs','src/workflow-requirements.mjs','src/workflow-evidence.mjs','src/actions.mjs','src/computer.mjs','src/assistant.mjs','desktop/computer.mjs'])source[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');
try{
  const report=join(dir,'report.json'),env={...process.env,AURORA_DESKTOP_TEST:'1',AURORA_WORKFLOW_NATIVE_TEST:'1',AURORA_TEST_REPORT:report,AURORA_DESKTOP_DATA:join(dir,'profile'),AURORA_VAULT:join(dir,'vault'),AURORA_DATA:join(dir,'data'),AURORA_BACKUPS:join(dir,'backups')};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(join(homedir(),'.local/share/aurora-desktop-runtime/electron'),[root,'--class=aurora-assistant',...(env.WAYLAND_DISPLAY?['--ozone-platform=wayland']:[])],{env,stdio:['ignore','pipe','pipe']});let log='';
  child.stdout.on('data',d=>{log+=d;process.stdout.write(d);});child.stderr.on('data',d=>{log+=d;});
  // Per-round deadlines live in the fixture; this only catches a hung desktop.
  let force;const timer=setTimeout(()=>{child.kill('SIGTERM');force=setTimeout(()=>child.kill('SIGKILL'),5000);},1250000);
  timer.unref();child.once('exit',()=>clearTimeout(force));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);
  let result;try{result=JSON.parse(await readFile(report,'utf8'));}catch{result={ok:false,error:'Desktop ended without a report'};}
  result.source=source;
  await writeFile(join(root,'artifacts/'+artifactPrefix+'-'+runId+'.log'),log);await writeFile(join(root,'artifacts/'+artifactPrefix+'-'+runId+'.json'),JSON.stringify(result,null,2));await writeFile(join(root,'artifacts/'+artifactPrefix+'-live-results.json'),JSON.stringify(result,null,2));
  for(let round=1;round<=2;round++)try{await copyFile(report+`.round-${round}.png`,join(root,`artifacts/workflow-native-round-${round}.png`));}catch{}
  if(code!==0||!result.ok)throw new Error(result.error||JSON.stringify(result.rounds?.filter(r=>!r.ok).map(r=>r.error))||'Native acceptance failed');
  console.log(JSON.stringify({ok:true,rounds:result.rounds.map(r=>({round:r.round,seconds:r.seconds,approvals:r.approvals,unaided:r.unaided,corrections:r.corrections.length}))}));
}finally{await rm(dir,{recursive:true,force:true});}
