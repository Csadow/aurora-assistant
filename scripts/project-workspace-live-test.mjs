// Real Aurora modules and their existing tests, copied into an isolated project.
// Plant two exact defects; approve only restoration of the original source.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';
const dir=await mkdtemp(join(tmpdir(),'aurora-workspace-live-')),project=join(dir,'project'),data=join(dir,'data');
const stamp=new Date().toISOString().replaceAll(/[:.]/g,'-'),report={date:new Date().toISOString(),model:'qwen3.5:9b',thinking:true,ok:false,runs:[],source:{},fixture:{}};
for(const path of ['src/project-workspaces.mjs','src/workflows.mjs','src/ollama.mjs','src/workflow-tools.mjs','src/workflow-prompt.mjs','src/workflow-recovery.mjs','src/workflow-changes.mjs','src/workflow-handoffs.mjs','src/workflow-requirements.mjs','src/workflow-evidence.mjs','src/workflow-health.mjs','src/file-patch.mjs','src/actions.mjs','src/system.mjs','src/store.mjs','src/assistant.mjs'])report.source[path]=createHash('sha256').update(await readFile(new URL('../'+path,import.meta.url))).digest('hex');
const expected=new Map(),plantedFiles=new Map();
for(const path of ['desktop/quick-window.mjs','desktop/placement.mjs','src/vault.mjs','src/read-view.mjs','src/task-meta.mjs','mobile/web/tasks.js','mobile/web/task-links.js','tests/quick-window.test.mjs']){
  const text=await readFile(new URL('../'+path,import.meta.url),'utf8');report.fixture[path]=createHash('sha256').update(text).digest('hex');const target=join(project,path);await mkdir(dirname(target),{recursive:true});
  let planted=text;if(path==='desktop/quick-window.mjs')planted=text.replace('Math.min(value.width,area.width)','Math.max(value.width,area.width)');if(path==='desktop/placement.mjs')planted=text.replace('width:width-left-right','width:width+left+right');if(planted!==text){expected.set(target,text);plantedFiles.set(target,planted);}await writeFile(target,planted);
}
await mkdir(data);await writeFile(join(data,'models.json'),JSON.stringify({model:report.model,thinking:true}));
let app,profile,handoff,first;
async function boot(){const a=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),embedding:'',projects:[],ollamaClient:new Ollama('http://127.0.0.1:11434',report.model)});const allowed=a.system.allowed.bind(a.system);a.system.allowed=path=>{assert(path===project||path.startsWith(project+'/'),'Only copied fixture files are accessible');return allowed(path);};return a;}
async function close(){if(!app)return;await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,30));}
try{
  const get=async path=>{const r=await fetch('http://127.0.0.1:4717'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
  const selected=await get('/api/local-model');assert.equal(selected.model,report.model);assert.equal(selected.thinking,true);assert.equal((await get('/api/embodiment')).phase,'idle');assert(!(await get('/api/workflows')).some(w=>['planning','running','queued'].includes(w.status)));assert(!(await get('/api/actions')).some(a=>a.status==='running'));assert(!(await get('/api/agents')).runs.some(r=>['running','queued'].includes(r.status)));
  app=await boot();profile=await app.projectWorkspaces.save({name:'Copied Aurora window placement',notePath:'20 Projects/Example Project.md',folders:[project],checks:[{name:'Window placement tests',program:'node',args:['--test','tests/quick-window.test.mjs'],cwd:project,outputIncludes:'pass 2'}]});
  for(const phase of ['repair','follow-up']){
    const started=Date.now(),run={phase,ok:false,approvals:0,planReviews:0,restarts:0,verificationRecoveries:0,outputLimitResumes:0};report.runs.push(run);
    try{
      if(handoff){await close();app=await boot();profile=await app.projectWorkspaces.read(profile.id);handoff=await app.workflows.handoffs.read(handoff.id);}
      const w=await app.workflows.start({goal:phase==='repair'?'Fix the two window geometry regressions in desktop/quick-window.mjs and desktop/placement.mjs. Inspect both modules and tests/quick-window.test.mjs. Quick ask width and height must each be the smaller of the saved dimension and available dimension, including when a saved position exists: saved width 700 with area width 1280 stays 700; saved width 460 with area width 320 becomes 320. Monitor work-area width must subtract the left and right reserved margins after scaling/rotation (720 logical pixels minus 10 on each side gives 700). Read the existing tests to verify these expectations. Use targeted patches to change only the incorrect expressions and preserve all other code. Run the saved Window placement tests, verify the actual pass marker, and read both final modules after the test.':'In one verification step, continue from the reviewed handoff: inspect both current window geometry modules, rerun the saved Window placement tests and report whether both corrections still pass. Do not repeat the completed edits. Read both modules after testing. Once the required command and fresh file observations are recorded, finish with a short summary.',scope:`Only the copied project at ${project}. The only editable files are desktop/quick-window.mjs and desktop/placement.mjs.`,projectId:profile.id,projectRevision:profile.revision,projectCheckNames:['Window placement tests'],requirements:{files:[...expected.keys()].map(path=>({path,lineEndings:'lf',finalNewline:'required'})),commands:[]},...(handoff?{handoffId:handoff.id,handoffRevision:handoff.revision}:{})});
      let previous='';
      while(Date.now()-started<900000){
        const r=await app.store.get('workflows',w.id);run.record=r;const progress=JSON.stringify([r.status,r.current,r.calls,r.operations.at(-1)?.requestedTool||r.operations.at(-1)?.name]);if(progress!==previous){console.log(phase+': '+progress);previous=progress;}
        if(['completed','paused','needs_help','needs_verification','waiting_input','cancelled'].includes(r.status)&&!app.workflows.running.has(w.id))break;
        if(r.status==='plan_review'&&!app.workflows.running.has(w.id)){assert.equal(run.planReviews,0);assert.equal(r.operations.length,0);await app.workflows.control(w.id,'approve_plan','',r.revision);run.planReviews++;}
        if(r.status==='waiting_approval')for(const op of r.operations.filter(o=>o.status==='waiting_approval'&&o.action)){
          const a=await app.store.get('actions',op.action);if(a.status!=='pending')continue;
          if(a.kind==='test_copy'){
            const payload=a.payload,candidate=payload.candidate;
            assert.equal(payload.root,project);assert(expected.has(candidate.path));
            assert.equal(candidate.before,await readFile(candidate.path,'utf8'));
            assert.equal(candidate.content,expected.get(candidate.path),'Only the known original source may be tested as a candidate');
            assert.equal(payload.check.program,'/usr/bin/node');assert.deepEqual(payload.check.args,['--test','tests/quick-window.test.mjs']);
            assert.equal(payload.check.cwd,project);assert.equal(payload.check.outputIncludes,'pass 2');
            for(const source of payload.files){assert(source.path.startsWith(project+'/'));assert.equal(source.content,await readFile(source.path,'utf8'));}
          }else if(a.kind==='write'){
            assert.equal(phase,'repair');assert(expected.has(a.payload.path));assert(a.payload.patch,'Require targeted edits');assert.equal(a.payload.content,expected.get(a.payload.path),'Only restore the known original source');
            if(r.operations.filter(o=>o.name==='propose_file_edit'&&o.status==='completed').length===1&&!run.restarts){
              await app.workflows.control(w.id,'pause');await close();app=await boot();assert.equal((await app.workflows.read(w.id)).status,'paused');assert.equal((await app.store.get('actions',a.id)).status,'pending');await assert.rejects(app.actions.decide(a.id,'approve',a.digest),/Resume/);await app.workflows.control(w.id,'resume');run.restarts++;run.interruptedAction=a.id;console.log('PASS restart retained the exact pending action without executing it');
            }
          }else{assert.equal(a.kind,'command');assert.equal(a.payload.program,'/usr/bin/node');assert.deepEqual(a.payload.args,['--test','tests/quick-window.test.mjs']);assert.equal(a.payload.cwd,project);}
          await app.actions.decide(a.id,'approve',a.digest);run.approvals++;
        }
        await new Promise(r=>setTimeout(r,200));
      }
      assert.equal(run.record.status,'completed',run.record.error||'Task timed out');assert((await app.workflows.read(w.id)).requirementChecks.every(c=>c.passed));for(const [path,text] of expected)assert.equal(await readFile(path,'utf8'),text);
      if(phase==='repair'){
        assert.equal(run.restarts,1);assert.equal(run.record.operations.filter(o=>o.name==='propose_file_edit'&&o.status==='completed').length,2);first=run.record;const d=await app.workflows.handoffs.draft(w.id);handoff=await app.workflows.handoffs.save({sourceId:w.id,handoffId:d.id,draftRevision:d.draftRevision,title:'Window geometry corrections',body:d.body+'\n\nNext session: recheck current code and tests without repeating either edit.',project:d.project});report.handoff=handoff;
      }else{assert.equal(run.record.handoff.sourceId,first.id);assert.equal(run.record.operations.filter(o=>o.name==='propose_file_edit').length,0);const dashboard=await app.projectWorkspaces.dashboard(profile.id,app.workflows.handoffs);assert.equal(dashboard.tasks.length,2);assert.equal(dashboard.tasks.find(t=>t.id===first.id).children[0].id,w.id);assert.equal(dashboard.handoffs[0].id,handoff.id);report.dashboard=dashboard;}
      run.ok=true;console.log('PASS '+phase);
    }catch(e){run.error=e.message;throw e;}finally{run.seconds=Math.round((Date.now()-started)/1000);run.calls=run.record?.calls;run.automaticCheckRecoveries=run.record?.checkRecoveries?.length||0;run.generationFailures=run.record?.generationFailures?.length||0;run.toolFailures=run.record?.operations.filter(o=>o.status==='failed').length;}
  }
  report.ok=true;
}catch(e){report.error=e.message;console.error(e.message);process.exitCode=1;}
finally{await close();for(const name of ['project-workspace-live-results.json',`project-workspace-live-${stamp}.json`])await writeFile(new URL('../artifacts/'+name,import.meta.url),JSON.stringify(report,null,2));await rm(dir,{recursive:true,force:true});}
