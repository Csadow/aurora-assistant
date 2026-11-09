import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';

const reports=[],runId=new Date().toISOString().replaceAll(/[:.]/g,'-');
for(let round=1;round<=Number(process.env.AURORA_WORKFLOW_ROUNDS||3);round++){
  const dir=await mkdtemp(join(tmpdir(),'aurora-workflow-live-')),project=join(dir,'project'),data=join(dir,'data');
  await mkdir(project);await mkdir(data);await writeFile(join(data,'models.json'),JSON.stringify({model:'qwen3.5:9b',thinking:true}));
  const file=join(project,'math.mjs'),expected='export function add(a, b) { return a + b; }\n';
  await writeFile(file,'export function add(a, b) { return a - b; }\n');
  await writeFile(join(project,'math.test.mjs'),"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from './math.mjs';\ntest('adds signed numbers',()=>{assert.equal(add(5,3),8);assert.equal(add(-2,7),5);assert.equal(add(0,0),0);});\n");
  const ollama=new Ollama('http://127.0.0.1:11434','qwen3.5:9b');
  const app=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),ollamaClient:ollama,embedding:'',projects:[{name:'Fixture',root:project}]});
  const allowed=app.system.allowed.bind(app.system);app.system.allowed=path=>{assert(path===project||path.startsWith(project+'/'),'Only disposable project access is allowed');return allowed(path);};
  let record,approvals=0;const started=Date.now();
  try{
    const w=await app.workflows.start({goal:'Fix add(a,b) in math.mjs so it adds numbers correctly. Inspect math.mjs and math.test.mjs, propose the smallest edit, read the edited file back, then run node --test math.test.mjs and verify its actual output with verify_outcome kind=command_output using the pass marker before reporting the result. Complete the work using tools.',scope:`Only use ${project}. Edit only math.mjs. The only permitted command is node --test with this folder's math.test.mjs, named by its relative or absolute path, and this folder as cwd. No other arguments. Keep the exported function. Prefer a compact plan.`});
    let previous='';
    while(Date.now()-started<Number(process.env.AURORA_WORKFLOW_TIMEOUT_MS||600000)){
      record=await app.store.get('workflows',w.id);
      const progress=JSON.stringify([record.status,record.current,record.calls,record.operations.at(-1)?.name]);
      if(progress!==previous){console.log(`Round ${round}: ${progress}`);previous=progress;}
      if(['completed','paused','needs_verification','failed','cancelled','needs_help','waiting_input'].includes(record.status))break;
      if(record.status==='waiting_approval')for(const op of record.operations.filter(o=>o.status==='waiting_approval'&&o.action)){
        const a=await app.store.get('actions',op.action);if(a.status!=='pending')continue;
        // Approval in this test is restricted to the disposable fixture. Reject
        // every other target, executable, argument and kind, including cloud/UI.
        if(a.kind==='write'){assert.equal(a.payload.path,file);assert.match(a.payload.content,/^export function add\(a,\s*b\)\s*\{\s*return a\s*\+\s*b;?\s*\}\s*$/);}
        else{assert.equal(a.kind,'command');assert.equal(a.payload.program,'/usr/bin/node');assert.equal(a.payload.args.length,2);assert.equal(a.payload.args[0],'--test');assert.equal(resolve(project,a.payload.args[1]),join(project,'math.test.mjs'));assert.equal(a.payload.cwd,project);}
        await app.actions.decide(a.id,'approve',a.digest);approvals++;
      }
      await new Promise(r=>setTimeout(r,400));
    }
    assert.equal(record.status,'completed',record.error||'Workflow timed out');
    assert.equal((await readFile(file,'utf8')).replaceAll(/\s/g,''),expected.replaceAll(/\s/g,''));
    assert(record.operations.some(o=>o.name==='propose_command'&&o.status==='completed'&&o.result.code===0&&/pass 1/.test(o.result.content)));
    assert.equal(app.workflows.unverifiedWrites(record).length,0);
    assert(record.operations.some(o=>o.name==='verify_outcome'&&o.status==='completed'&&o.result.kind==='command_output'));
    assert.equal((await app.workflows.read(w.id)).health.code,'completed');
    reports.push({round,ok:true,approvals,seconds:Math.round((Date.now()-started)/1000),record});console.log(`PASS round ${round}`);
  }catch(e){reports.push({round,ok:false,approvals,seconds:Math.round((Date.now()-started)/1000),error:e.message,record});throw e;}
  finally{await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});await writeFile(new URL('../artifacts/workflow-live-results.json',import.meta.url),JSON.stringify(reports,null,2));await writeFile(new URL('../artifacts/workflow-live-'+runId+'.json',import.meta.url),JSON.stringify(reports,null,2));await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,30));await rm(dir,{recursive:true,force:true});}
}
