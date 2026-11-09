import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url)),live=process.argv.includes('--live'),requirements=process.argv.includes('--requirements'),continuity=process.argv.includes('--continuity'),workspace=process.argv.includes('--workspace'),report={ok:false,started:new Date().toISOString(),mode:live?'deterministic plus real local model/native desktop':'deterministic fixtures',requirements,continuity,workspace,runs:[],source:{}};
const runId=report.started.replaceAll(/[:.]/g,'-');
await mkdir(join(root,'artifacts'),{recursive:true});
for(const file of ['src/project-workspaces.mjs','src/workflows.mjs','src/workflow-tools.mjs','src/workflow-recovery.mjs','src/workflow-prompt.mjs','src/workflow-changes.mjs','src/ollama.mjs','src/workflow-evidence.mjs','src/workflow-health.mjs','src/workflow-requirements.mjs','src/workflow-handoffs.mjs','src/file-patch.mjs','src/system.mjs','src/store.mjs','src/actions.mjs','src/assistant.mjs','src/computer.mjs','desktop/computer.mjs'])report.source[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');
const run=(name,args,env={},keepGoing=false)=>new Promise((resolve,reject)=>{
  const start=Date.now(),child=spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>{report.runs.push({name,ok:code===0,seconds:(Date.now()-start)/1000});code===0||keepGoing?resolve():reject(new Error(name+' failed; see the saved trace.'));});
});
try{
  await run('executor and recovery scenarios',['--test','--test-timeout=30000','tests/task-execution.test.mjs','tests/workflow-reliability.test.mjs','tests/workflow-requirements.test.mjs','tests/project-continuity.test.mjs','tests/project-workspaces.test.mjs','tests/workflow-recovery.test.mjs']);
  for(const file of ['task-benchmark.json','reliability-benchmark.json'])report.runs.push({artifact:file,...JSON.parse(await readFile(join(root,'artifacts',file),'utf8'))});
  if(live){
    // These runs use the existing accepted model; never download or switch it.
    const base='http://127.0.0.1:4717',get=async path=>{const r=await fetch(base+path,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('Cannot check the installed assistant');return r.json();};
    const m=await get('/api/local-model');if(m.model!=='qwen3.5:9b'||!m.thinking)throw new Error('This acceptance pack expects the accepted Qwen3.5 9B reasoning setup. It will not change your model.');
    if((await get('/api/workflows')).some(w=>['running','planning','queued'].includes(w.status))||(await get('/api/actions')).some(a=>a.status==='running')||(await get('/api/agents')).runs.some(r=>['running','queued'].includes(r.status))||(await get('/api/embodiment')).phase!=='idle')throw new Error('Finish active assistant work before running the live acceptance pack.');
    if(workspace){await run('multi-file project repair, interrupted approval and follow-up',['scripts/project-workspace-live-test.mjs'],{},true);report.runs.push({artifact:'project-workspace-live-results.json',...JSON.parse(await readFile(join(root,'artifacts/project-workspace-live-results.json'),'utf8'))});}
    else if(continuity){await run('targeted edits and reviewed project handoff across restart',['scripts/project-continuity-live-test.mjs'],{},true);report.runs.push({artifact:'project-continuity-live-results.json',...JSON.parse(await readFile(join(root,'artifacts/project-continuity-live-results.json'),'utf8'))});}
    else{
    const nativeArtifact=requirements?'requirements-native-live-results.json':'workflow-native-live-results.json';
    await run('browser to file to real application, two rounds',['scripts/workflow-native-live-test.mjs'],requirements?{AURORA_OUTPUT_REQUIREMENTS:'1'}:{},true);
    report.runs.push({artifact:nativeArtifact,...JSON.parse(await readFile(join(root,'artifacts',nativeArtifact),'utf8'))});
    if(requirements){await run('ordinary and saved-skill project tasks with output requirements',['scripts/task-skills-live-test.mjs'],{AURORA_OUTPUT_REQUIREMENTS:'1'},true);report.runs.push({artifact:'requirements-project-live-results.json',...JSON.parse(await readFile(join(root,'artifacts/requirements-project-live-results.json'),'utf8'))});}
    else{await run('project edit and real tests, two rounds',['scripts/workflow-live-test.mjs'],{AURORA_WORKFLOW_ROUNDS:'2',AURORA_WORKFLOW_TIMEOUT_MS:'600000'},true);report.runs.push({artifact:'workflow-live-results.json',rounds:JSON.parse(await readFile(join(root,'artifacts/workflow-live-results.json'),'utf8'))});}
    }
  }
  report.ok=report.runs.every(r=>r.ok!==false);
  if(!report.ok){report.error=report.runs.filter(r=>r.name&&r.ok===false).map(r=>r.name+' failed').join('; ');process.exitCode=1;}
}catch(e){report.error=e.message;process.exitCode=1;}
finally{report.finished=new Date().toISOString();await writeFile(join(root,'artifacts/task-acceptance-'+runId+'.json'),JSON.stringify(report,null,2));await writeFile(join(root,'artifacts/task-acceptance-latest.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,mode:report.mode,error:report.error}));}
