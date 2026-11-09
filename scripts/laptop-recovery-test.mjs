import '../src/environment.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,readdir,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {sha} from '../src/vault.mjs';

const args=process.argv.slice(2),live=args.includes('--live'),chosen=args.find(a=>a.startsWith('--case='))?.slice(7);
assert(args.every(a=>['--live','--case=pending','--case=lost'].includes(a))&&new Set(args).size===args.length&&args.filter(a=>a.startsWith('--case=')).length<=1,'Use --live optionally, and --case=pending|lost.');
const root=fileURLToPath(new URL('../',import.meta.url)),stamp=new Date().toISOString().replaceAll(/[:.]/g,'-'),dir=await mkdtemp(join(tmpdir(),'aurora-laptop-recovery-'));
const destination=join(root,'artifacts/laptop-recovery-'+stamp),lockPath=join(root,'artifacts/repair-diagnosis.lock');let lock,child,result;
const get=async p=>{const r=await fetch('http://127.0.0.1:4717/api/'+p,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
const sources=async()=>{const names=['scripts/laptop-recovery-test.mjs',...(await readdir(join(root,'src'))).filter(n=>n.endsWith('.mjs')).map(n=>'src/'+n),...(await readdir(join(root,'desktop'))).filter(n=>n.endsWith('.mjs')).map(n=>'desktop/'+n),'public/workflow-review.js','public/workflow-requirements.js','public/workflow-completion.js','public/workflows.js'];return Object.fromEntries(await Promise.all(names.map(async n=>[n,sha(await readFile(join(root,n)))])));};
try{
 lock=await open(lockPath,'wx');const selected=await get('local-model');
 assert.equal((await get('embodiment')).phase,'idle');assert(!(await get('workflows')).some(w=>['running','planning','queued'].includes(w.status)));assert(!(await get('actions')).some(a=>a.status==='running'));assert(!(await get('agents')).runs.some(a=>['running','queued'].includes(a.status)));
 const source=await sources(),report=join(dir,'report.json'),env={...process.env,AURORA_DESKTOP_TEST:'1',AURORA_LAPTOP_RECOVERY_TEST:'1',AURORA_RECOVERY_LIVE:live?'1':'0',AURORA_RECOVERY_CASE:chosen||'',AURORA_RECOVERY_MODEL:JSON.stringify({model:selected.model,thinking:selected.thinking,generation:selected.generation}),AURORA_TEST_REPORT:report,AURORA_VAULT:join(dir,'vault'),AURORA_DATA:join(dir,'data'),AURORA_BACKUPS:join(dir,'backups'),AURORA_DESKTOP_DATA:join(dir,'profile')};delete env.ELECTRON_RUN_AS_NODE;
 child=spawn(join(homedir(),'.local/share/aurora-desktop-runtime/electron'),[root,'--class=aurora-assistant',...(env.WAYLAND_DISPLAY?['--ozone-platform=wayland']:[]),'--disable-gpu'],{env,stdio:['ignore','pipe','pipe']});let log='';
 child.stdout.on('data',d=>{log+=d;process.stdout.write(d);});child.stderr.on('data',d=>{log+=d;});
 let force;child.once('exit',()=>clearTimeout(force));
 const stop=()=>{child.kill('SIGTERM');force=setTimeout(()=>child.kill('SIGKILL'),5000);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const timer=setTimeout(stop,live?1500000:180000);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
 try{result=JSON.parse(await readFile(report,'utf8'));}catch{result={ok:false,error:'Native test ended without a report'};}
 const after=await sources(),modelAfter=await get('local-model');result.source=source;result.changedSources=Object.keys(source).filter(n=>source[n]!==after[n]);result.modelSettingsUnchanged=JSON.stringify({model:selected.model,thinking:selected.thinking,generation:selected.generation})===JSON.stringify({model:modelAfter.model,thinking:modelAfter.thinking,generation:modelAfter.generation});
 await writeFile(destination+'.log',log);result.ok=code===0&&result.ok&&!result.changedSources.length&&result.modelSettingsUnchanged;
}finally{
 await rm(dir,{recursive:true,force:true});if(lock){await lock.close();await rm(lockPath);}
 if(result){result.cleanedUp=true;await writeFile(destination+'.json',JSON.stringify(result,null,2));textResult(result);}
}
function textResult(r){console.log(JSON.stringify({report:destination+'.json',ok:r.ok,cases:r.cases?.map(c=>({id:c.id,ok:c.ok,seconds:c.seconds,error:c.error}))}));if(!r.ok)process.exitCode=1;}
