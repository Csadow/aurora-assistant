import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,stat,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),live=process.argv.includes('--live'),selected=process.argv.find(a=>a.startsWith('--only='))?.slice(7),names=['project','research','desktop'];
if(selected&&!names.includes(selected))throw Error('Use --only=project, research or desktop.');
const id=new Date().toISOString().replaceAll(/[:.]/g,'-'),report={started:new Date().toISOString(),live,scope:'Disposable fixtures only; not a general capability score',source:{},runs:[]};
await mkdir(join(root,'artifacts'),{recursive:true});
for(const file of ['src/workflows.mjs','src/workflow-health.mjs','src/workflow-evidence.mjs','src/workflow-requirements.mjs','src/workflow-prompt.mjs','src/workflow-tools.mjs','src/workflow-critique.mjs','src/workflow-substance.mjs','src/workflow-delivery.mjs','src/workflow-claims.mjs','src/workflow-claim-note.mjs','src/workflow-source-links.mjs','src/workflow-calculations.mjs','src/workflow-arithmetic.mjs','src/workflow-citations.mjs','src/workflow-source-quotes.mjs','src/workflow-continuation.mjs','src/workflow-suggestions.mjs','scripts/workflow-live-test.mjs','scripts/research-workflow-live-test.mjs','scripts/research-output-checks.mjs','scripts/workflow-native-live-test.mjs','desktop/workflow-native-smoke.mjs'])report.source[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');
const cases=[{name:'project',script:'workflow-live-test.mjs',artifact:'workflow-live-results.json',env:{AURORA_WORKFLOW_ROUNDS:'2',AURORA_WORKFLOW_TIMEOUT_MS:'600000'}},{name:'research',script:'research-workflow-live-test.mjs',artifact:'research-workflow-live-results.json',env:{AURORA_RESEARCH_ROUNDS:'2',AURORA_RESEARCH_REQUIRED_TEXT:'1',AURORA_RESEARCH_SOURCE_REVIEW:'1'}},{name:'desktop',script:'workflow-native-live-test.mjs',artifact:'formatted-native-live-results.json',env:{AURORA_OUTPUT_REQUIREMENTS:'format'}}];
async function run(name,args,env={}){
 const start=Date.now(),log=`artifacts/quality-${id}-${name}.log`,handle=await open(join(root,log),'w',0o600);
 console.log('Starting '+name+'; log: '+log);
 try{const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:['ignore',handle.fd,handle.fd]});const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});return {name,ok:code===0,exitCode:code,seconds:Math.round((Date.now()-start)/1000),startedMs:start,log};}finally{await handle.close();}
}
try{
 report.runs.push(await run('regressions',['--test','--test-isolation=none','tests/workflow-critique.test.mjs','tests/workflow-substance.test.mjs','tests/workflow-claim-recovery.test.mjs','tests/workflow-delivery.test.mjs','tests/workflow-claims.test.mjs','tests/workflow-calculations.test.mjs','tests/workflow-arithmetic.test.mjs','tests/workflow-combined-repair.test.mjs','tests/workflow-citations.test.mjs','tests/workflow-source-quotes.test.mjs','tests/research-output-checks.test.mjs','tests/workflow-next-step.test.mjs','tests/workflow-file-freshness.test.mjs','tests/workflow-reliability.test.mjs','tests/workflow-requirements.test.mjs','tests/workflow-recovery.test.mjs','tests/task-execution.test.mjs']));
 if(!report.runs[0].ok)throw Error('Regression checks failed; live trials were not started.');
 if(live){
  const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Installed Aurora unavailable');return r.json();};
  const m=await get('local-model');if(m.model!=='qwen3.5:9b'||!m.thinking)throw Error('Tests require the selected Qwen3.5:9b thinking setup; no settings were changed.');report.model=m;
  if((await get('workflows')).some(w=>['running','planning','queued'].includes(w.status))||(await get('actions')).some(a=>a.status==='running')||(await get('agents')).runs.some(a=>['running','queued'].includes(a.status))||(await get('embodiment')).phase!=='idle')throw Error('Finish active Aurora work before live trials.');
  for(const c of cases.filter(c=>!selected||c.name===selected).sort((a,b)=>['research','project','desktop'].indexOf(a.name)-['research','project','desktop'].indexOf(b.name))){
   const sourceStart=Object.fromEntries(await Promise.all(Object.keys(report.source).filter(file=>file.startsWith('src/')||file==='scripts/'+c.script||c.name==='research'&&file==='scripts/research-output-checks.mjs'||c.name==='desktop'&&file==='desktop/workflow-native-smoke.mjs').map(async file=>[file,createHash('sha256').update(await readFile(join(root,file))).digest('hex')])));
   const r=await run(c.name,['scripts/'+c.script],c.env);report.runs.push(r);r.source=sourceStart;
   const changed=[];for(const [file,digest] of Object.entries(sourceStart))if(createHash('sha256').update(await readFile(join(root,file))).digest('hex')!==digest)changed.push(file);if(changed.length){r.ok=false;r.changedDuringRun=changed;r.error='Source changed during the trial; rerun this case.';}
   try{const path=join(root,'artifacts',c.artifact);if((await stat(path)).mtimeMs<r.startedMs)throw Error('No fresh report was written');const data=JSON.parse(await readFile(path,'utf8')),rounds=Array.isArray(data)?data:data.rounds;
    r.rounds=rounds.map(x=>({round:x.round,ok:x.ok,seconds:x.seconds,approvals:x.approvals??null,planReviews:x.planReviews??0,interventions:x.corrections?.length||0,falseCompletion:x.falseCompletion??(x.ok===false&&x.record?.status==='completed'),calls:x.record?.calls,toolErrors:x.record?.operations.filter(o=>o.status==='failed').map(o=>({name:o.name,error:o.result?.error})),symbolicRelations:x.symbolicRelations,sourceComparisons:x.calculations?.map(c=>c.expression),combinedRepairs:x.combinedRepairs,claimReviews:x.claimReviews,sourceReview:x.sourceReview,draftCritique:x.draftCritique,contentRequirements:x.contentRequirements,manualReviewRequired:x.manualReviewRequired,checksScope:x.checksScope,mode:x.mode,checks:x.checks,error:x.error}));r.expectedRounds=2;r.ok=r.ok&&r.rounds.length===2&&r.rounds.every(x=>x.ok);r.artifact=c.artifact;
   }catch(e){r.ok=false;r.error=e.message;}
   console.log(JSON.stringify({name:r.name,ok:r.ok,rounds:r.rounds}));
  }
 }
}catch(e){report.error=e.message;}
finally{report.finished=new Date().toISOString();report.ok=!report.error&&report.runs.length>0&&report.runs.every(r=>r.ok);await writeFile(join(root,`artifacts/workflow-quality-${id}.json`),JSON.stringify(report,null,2));await writeFile(join(root,'artifacts/workflow-quality-latest.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,error:report.error,report:`artifacts/workflow-quality-${id}.json`}));if(!report.ok)process.exitCode=1;}
