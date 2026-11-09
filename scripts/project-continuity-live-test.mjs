// Two different fixes in one disposable project, with a reviewed Markdown
// handoff and backend restart between them. No real user files are editable.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';

const dir=await mkdtemp(join(tmpdir(),'aurora-continuity-live-')),project=join(dir,'project'),data=join(dir,'data'),file=join(project,'math.mjs');
const id=new Date().toISOString().replaceAll(/[:.]/g,'-'),report={date:new Date().toISOString(),model:'qwen3.5:9b',thinking:true,ok:false,runs:[],source:{}};
for(const path of ['src/workflows.mjs','src/workflow-handoffs.mjs','src/workflow-requirements.mjs','src/workflow-evidence.mjs','src/workflow-health.mjs','src/file-patch.mjs','src/actions.mjs','src/system.mjs','src/store.mjs','src/assistant.mjs'])report.source[path]=createHash('sha256').update(await readFile(new URL('../'+path,import.meta.url))).digest('hex');
await mkdir(project);await mkdir(data);await writeFile(join(data,'models.json'),JSON.stringify({model:report.model,thinking:true}));
const original='// Keep this comment: Ω 🦊\r\nexport function add(a, b) { return a - b; }\r\nexport function multiply(a, b) { return a + b; }\r\n// Preserve this final line.\r\n';await writeFile(file,original);
for(const operation of ['add','multiply'])await writeFile(join(project,operation+'.test.mjs'),`import {${operation}} from './math.mjs';import test from 'node:test';import assert from 'node:assert/strict';test('${operation} signed numbers',()=>{assert.equal(${operation}(5,3),${operation==='add'?8:15});assert.equal(${operation}(-2,7),${operation==='add'?5:-14});});\n`);
let app,handoff,source;
async function boot(){
  const a=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),embedding:'',projects:[],ollamaClient:new Ollama('http://127.0.0.1:11434',report.model)});
  const allowed=a.system.allowed.bind(a.system);a.system.allowed=path=>{assert(path===project||path.startsWith(project+'/'),'Only the disposable project is accessible');return allowed(path);};return a;
}
async function close(){if(!app)return;await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,30));}
try{
  const get=async path=>{const r=await fetch('http://127.0.0.1:4717'+path,{signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();};
  const installed=await get('/api/local-model');assert.equal(installed.model,report.model);assert.equal(installed.thinking,true);assert.equal((await get('/api/embodiment')).phase,'idle');assert(!(await get('/api/workflows')).some(w=>['planning','running','queued'].includes(w.status)));assert(!(await get('/api/actions')).some(a=>a.status==='running'));assert(!(await get('/api/agents')).runs.some(r=>['running','queued'].includes(r.status)));
  app=await boot();
  for(const operation of ['add','multiply']){
    const started=Date.now(),run={operation,mode:handoff?'reviewed handoff after restart':'fresh task',ok:false,approvals:0,planReviews:0};report.runs.push(run);
    try{
      if(handoff){await close();app=await boot();handoff=await app.workflows.handoffs.read(handoff.id);assert.equal((await app.store.list('actions')).filter(a=>a.status==='pending'||a.status==='running').length,0);}
      const args=['--test','add.test.mjs',...(handoff?['multiply.test.mjs']:[])];
      const w=await app.workflows.start({goal:`Fix only ${operation}(a,b) in math.mjs so it ${operation==='add'?'adds':'multiplies'} numbers correctly. Inspect the current source and relevant tests. Use propose_file_patch for a small exact replacement, preserving all other text and CRLF line endings. Run the required Node test command, verify its actual pass marker, and read the final file after the test before completing. ${handoff?'Preserve the previously fixed addition function; do not repeat its edit.':''}`,scope:`Only ${project}. Edit only math.mjs. Use only the explicitly required check command.`,requirements:{files:[{path:file,lineEndings:'crlf',finalNewline:'required'}],commands:[{program:'node',args,cwd:project,outputIncludes:handoff?'pass 2':'pass 1'}]},...(handoff?{handoffId:handoff.id,handoffRevision:handoff.revision}:{})});
      let previous='';
      while(Date.now()-started<600000){
        const r=await app.store.get('workflows',w.id);run.record=r;const progress=JSON.stringify([r.status,r.current,r.calls,r.operations.at(-1)?.requestedTool||r.operations.at(-1)?.name]);if(progress!==previous){console.log(operation+': '+progress);previous=progress;}
        if(['completed','paused','needs_help','needs_verification','waiting_input','cancelled'].includes(r.status)&&!app.workflows.running.has(w.id))break;
        if(r.status==='plan_review'&&!app.workflows.running.has(w.id)){assert.equal(run.planReviews,0);assert.equal(r.operations.length,0);if(handoff){assert.equal(r.handoff.sourceId,source.id);assert.equal(r.handoff.revision,handoff.revision);}await app.workflows.control(w.id,'approve_plan','',r.revision);run.planReviews++;}
        if(r.status==='waiting_approval')for(const op of r.operations.filter(o=>o.status==='waiting_approval'&&o.action)){
          const a=await app.store.get('actions',op.action);if(a.status!=='pending')continue;
          if(a.kind==='write'){
            assert.equal(a.payload.path,file);assert(a.payload.patch,'This trial requires the targeted replacement tool');const expected=operation==='add'?original.replace('return a - b','return a + b'):original.replace('return a - b','return a + b').replace('multiply(a, b) { return a + b','multiply(a, b) { return a * b');assert.equal(a.payload.content,expected,'Only the requested operator may change; every surrounding byte must match');
          }else{assert.equal(a.kind,'command');assert.equal(a.payload.program,'/usr/bin/node');assert.deepEqual(a.payload.args,args);assert.equal(a.payload.cwd,project);}
          await app.actions.decide(a.id,'approve',a.digest);run.approvals++;
        }
        await new Promise(r=>setTimeout(r,200));
      }
      assert.equal(run.record.status,'completed',run.record.error||'Task timed out');assert((await app.workflows.read(w.id)).requirementChecks.every(c=>c.passed));assert.equal(run.record.operations.filter(o=>o.name==='propose_file_edit'&&o.status==='completed').length,1);assert.equal(run.approvals,2);
      if(!handoff){source=run.record;const d=await app.workflows.handoffs.draft(w.id);handoff=await app.workflows.handoffs.save({sourceId:w.id,handoffId:d.id,draftRevision:d.draftRevision,title:'Arithmetic project handoff',body:d.body+'\n\nNext session: inspect and correct multiplication. Addition is already fixed; verify it with tests instead of repeating the edit.',project:'20 Projects/Example Project.md'});report.handoff=handoff;}
      else assert(run.record.operations.every(o=>!source.operations.some(old=>old.id===o.id)));
      run.ok=true;console.log('PASS '+operation);
    }catch(e){run.error=e.message;throw e;}finally{run.seconds=Math.round((Date.now()-started)/1000);run.calls=run.record?.calls;run.toolFailures=run.record?.operations.filter(o=>o.status==='failed').length;}
  }
  report.ok=true;
}catch(e){report.error=e.message;console.error(e.message);process.exitCode=1;}
finally{await close();for(const name of ['project-continuity-live-results.json',`project-continuity-live-${id}.json`])await writeFile(new URL('../artifacts/'+name,import.meta.url),JSON.stringify(report,null,2));await rm(dir,{recursive:true,force:true});}
