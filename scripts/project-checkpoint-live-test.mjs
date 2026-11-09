// Serial real-model repairs of copied production modules. Never edits the real
// project or personal vault; only exact restorations and the saved test may run.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex'),root=new URL('../',import.meta.url);
const stamp=new Date().toISOString().replaceAll(/[:.]/g,'-'),report={date:new Date().toISOString(),model:'qwen3.5:9b',thinking:true,ok:false,runs:[],source:{}};
await mkdir(new URL('artifacts/',root),{recursive:true});
for(const name of (await readdir(new URL('src/',root))).filter(n=>n.endsWith('.mjs')))report.source['src/'+name]=hash(await readFile(new URL('src/'+name,root)));
for(const path of ['scripts/project-checkpoint-live-test.mjs','desktop/placement.mjs','desktop/quick-window.mjs','tests/quick-window.test.mjs','mobile/web/tasks.js','mobile/web/task-links.js'])report.source[path]=hash(await readFile(new URL(path,root)));
const save=async()=>{for(const name of [`project-checkpoint-live-${stamp}.json`,'project-checkpoint-live-results.json'])await writeFile(new URL('artifacts/'+name,root),JSON.stringify(report,null,2));};
const get=async path=>{const r=await fetch('http://127.0.0.1:4717/api/'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
const selected=await get('local-model');assert.equal(selected.model,report.model);assert.equal(selected.thinking,true);report.generation=selected.generation;
assert.equal((await get('embodiment')).phase,'idle');assert(!(await get('workflows')).some(w=>['planning','running','queued'].includes(w.status)));assert(!(await get('actions')).some(a=>a.status==='running'));assert(!(await get('agents')).runs.some(r=>['running','queued'].includes(r.status)));
for(const interruption of ['pending second edit','after passing tests']){
  const dir=await mkdtemp(join(tmpdir(),'aurora-checkpoint-live-')),project=join(dir,'project'),data=join(dir,'data'),expected=new Map(),unchanged=new Map(),plantedFiles=new Map();
  const run={interruption,ok:false,approvals:0,restarts:0,planReviews:0},started=Date.now();report.runs.push(run);let app,w,interruptReady=false;
  const close=async()=>{if(!app)return;await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,20));};
  const boot=async()=>{
    const model=new Ollama('http://127.0.0.1:11434',report.model),chat=model.chat.bind(model);
    model.chat=async(...args)=>{
      if(w&&!run.restarts&&interruption==='after passing tests'&&!args[4]?.format?.properties.steps){
        const record=await app.store.get('workflows',w.id);
        if(record.operations.some(o=>o.name==='propose_command'&&o.status==='completed'&&o.result?.code===0)){
          interruptReady=true;const signal=args[2];signal.throwIfAborted();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
        }
      }
      return chat(...args);
    };
    const a=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),embedding:'',projects:[],ollamaClient:model});
    assert.deepEqual(a.assistant.ollama.generationOptions,report.generation);
    const allowed=a.system.allowed.bind(a.system);a.system.allowed=path=>{assert(path===project||path.startsWith(project+'/'),'Disposable project only');return allowed(path);};return a;
  };
  const restart=async()=>{
    await app.workflows.control(w.id,'pause');const before=await app.workflows.read(w.id),actions=await app.store.list('actions');await close();run.restarts++;app=await boot();
    const after=await app.workflows.read(w.id);assert.equal(after.status,'paused');assert.deepEqual(after.requirements,before.requirements);assert.deepEqual(after.project,before.project);assert.deepEqual(after.steps,before.steps);assert.equal(after.calls,before.calls);assert.equal(after.activeMs,before.activeMs);assert.deepEqual(await app.store.list('actions'),actions);
    assert(after.requirementChecks.every(c=>!c.passed));assert(after.projectRecovery);run.checkpoint=after.projectRecovery;
    for(const a of actions.filter(a=>a.status==='pending'))await assert.rejects(app.actions.decide(a.id,'approve',a.digest),/Resume/);
    await app.workflows.control(w.id,'resume');console.log('Restart verified: '+interruption);await save();
  };
  try{
    for(const path of ['desktop/quick-window.mjs','desktop/placement.mjs','src/vault.mjs','src/read-view.mjs','src/task-meta.mjs','mobile/web/tasks.js','mobile/web/task-links.js','tests/quick-window.test.mjs']){
      const original=await readFile(new URL(path,root),'utf8'),target=join(project,path);await mkdir(dirname(target),{recursive:true});let planted=original;
      if(path==='desktop/quick-window.mjs')planted=original.replace('Math.min(value.width,area.width)','Math.max(value.width,area.width)');
      if(path==='desktop/placement.mjs')planted=original.replace('width:width-left-right','width:width+left+right');
      (planted===original?unchanged:expected).set(target,original);if(planted!==original)plantedFiles.set(target,planted);await writeFile(target,original);
    }
    assert.equal(expected.size,2);
    // Verify the fixture before spending any model calls: intact dependencies,
    // original source passes, and each planted bug independently fails a test.
    const preflight=async(label,failures)=>{let result;try{result={code:0,...await promisify(execFile)(process.execPath,['--test','tests/quick-window.test.mjs'],{cwd:project,timeout:10000})};}catch(e){result={code:e.code,stdout:e.stdout,stderr:e.stderr};}
      assert.equal(result.code,failures?1:0,label);assert.match(result.stdout,new RegExp('fail '+(failures==='some'?'[1-9][0-9]*':failures)+'\\b'));assert(!result.stderr.includes('ERR_MODULE_NOT_FOUND'));run.preflight??=[];run.preflight.push({label,...result});};
    await preflight('pristine copied project',0);
    for(const [path,planted] of plantedFiles){await writeFile(path,planted);await preflight('independent regression: '+path.slice(project.length+1),'some');await writeFile(path,expected.get(path));}
    for(const [path,planted] of plantedFiles)await writeFile(path,planted);await preflight('both regressions',2);await save();
    if(process.argv.includes('--preflight')){run.ok=true;continue;}
    await mkdir(data);await writeFile(join(data,'models.json'),JSON.stringify({model:report.model,thinking:true}));app=await boot();
    const p=await app.projectWorkspaces.save({name:'Copied window placement',notePath:'20 Projects/Example Project.md',folders:[project],checks:[{name:'Window tests',program:'node',args:['--test','tests/quick-window.test.mjs'],cwd:project,outputIncludes:'pass 2'}]});
    w=await app.workflows.start({goal:'Repair the two window geometry regressions in desktop/quick-window.mjs and desktop/placement.mjs. Inspect both modules and tests/quick-window.test.mjs. Quick ask dimensions must be bounded by available dimensions: saved width 700 with area 1280 stays 700; saved width 460 with area 320 becomes 320. Monitor work-area width must subtract the left and right reserved margins from the scaled/rotated logical width (720 minus 10 on each side gives 700). Use small targeted replacements of only the wrong expressions; preserve all other code and tests. Run the saved Window tests, verify the actual pass marker, then read both final modules before completing. Preserve completed edits if interrupted; continue only remaining work.',scope:`Only ${project}. Edit only the two named modules.`,projectId:p.id,projectRevision:p.revision,projectCheckNames:['Window tests'],requirements:{files:[...expected.keys()].map(path=>({path,lineEndings:'lf',finalNewline:'required'})),commands:[]}});
    let previous='';
    while(Date.now()-started<900000){
      if(interruptReady&&!run.restarts)await restart();
      const r=await app.store.get('workflows',w.id);run.record=r;const progress=JSON.stringify([r.status,r.calls,r.operations.at(-1)?.requestedTool||r.operations.at(-1)?.name]);if(progress!==previous){console.log(interruption+': '+progress);previous=progress;await save();}
      if(['completed','paused','needs_help','needs_verification','waiting_input','cancelled'].includes(r.status)&&!app.workflows.running.has(w.id))break;
      if(r.status==='plan_review'&&!app.workflows.running.has(w.id)){assert.equal(run.planReviews++,0);await app.workflows.control(w.id,'approve_plan','',r.revision);}
      if(r.status==='waiting_approval')for(const op of r.operations.filter(o=>o.status==='waiting_approval'&&o.action)){
        const a=await app.store.get('actions',op.action);if(a.status!=='pending')continue;run.pendingAction=a;
        if(a.kind==='write'){
          assert(expected.has(a.payload.path),'Only the two modules may be edited');assert(a.payload.patch,'Require a targeted replacement');assert.equal(a.payload.content,expected.get(a.payload.path),'Proposal must restore only the planted expression');
          if(interruption==='pending second edit'&&!run.restarts&&r.operations.filter(o=>o.expected&&o.status==='completed').length===1)await restart();
        }else{assert.equal(a.kind,'command');assert.equal(a.payload.program,'/usr/bin/node');assert.deepEqual(a.payload.args,['--test','tests/quick-window.test.mjs']);assert.equal(a.payload.cwd,project);}
        await app.actions.decide(a.id,'approve',a.digest);run.approvals++;delete run.pendingAction;
      }
      await new Promise(r=>setTimeout(r,200));
    }
    assert.equal(run.record.status,'completed',run.record.error||'Timed out');assert.equal(run.restarts,1);assert((await app.workflows.read(w.id)).requirementChecks.every(c=>c.passed));
    for(const [path,text] of [...expected,...unchanged])assert.equal(await readFile(path,'utf8'),text);
    const actions=await app.store.list('actions');assert.equal(actions.filter(a=>a.kind==='write').length,2,'No repeated edit');assert(actions.every(a=>a.status==='completed'||a.kind==='command'&&a.status==='failed'));
    const checks=actions.filter(a=>a.kind==='command');run.checkRuns=checks.length;run.failedChecks=checks.filter(a=>a.status==='failed').length;
    assert(run.failedChecks<=2);assert.equal(checks.filter(a=>a.status==='completed').length,interruption==='pending second edit'?1:2);run.ok=true;
  }catch(e){run.error=e.message;console.error(interruption+': '+e.message.split('\n')[0]);}
  finally{await close();run.seconds=Math.round((Date.now()-started)/1000);if(w)run.record=await app.store.get('workflows',w.id);await save();await rm(dir,{recursive:true,force:true});}
}
for(const [path,digest] of Object.entries(report.source))assert.equal(hash(await readFile(new URL(path,root))),digest,'Source changed during trials: '+path);
report.ok=report.runs.every(r=>r.ok);await save();if(!report.ok)process.exitCode=1;
