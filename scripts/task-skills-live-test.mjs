// Two comparable disposable projects: ordinary task, then its reviewed procedure
// with new inputs. Only the fixture edit and its exact Node test can be approved.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createApp} from '../src/server.mjs';
import {Ollama} from '../src/ollama.mjs';

const strict=process.env.AURORA_OUTPUT_REQUIREMENTS==='1';
const dir=await mkdtemp(join(tmpdir(),'aurora-skill-live-')),data=join(dir,'data');
const runId=new Date().toISOString().replaceAll(/[:.]/g,'-'),report={date:new Date().toISOString(),model:'qwen3.5:9b',thinking:true,requirements:strict,ok:false,source:{},runs:[]};
for(const file of ['src/workflows.mjs','src/task-skills.mjs','src/skills.mjs','src/workflow-evidence.mjs','src/workflow-requirements.mjs','src/actions.mjs','src/computer.mjs','src/assistant.mjs'])report.source[file]=createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex');
await mkdir(data);await writeFile(join(data,'models.json'),JSON.stringify({model:report.model,thinking:true}));
const app=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),ollamaClient:new Ollama('http://127.0.0.1:11434',report.model),embedding:'',projects:[]});
let project,source,skill,record;
const allowed=app.system.allowed.bind(app.system);app.system.allowed=path=>{assert(path===project||path.startsWith(project+'/'),'Only the current disposable project is allowed');return allowed(path);};
try{
  for(const mode of ['ordinary','reusable-skill']){
    project=join(dir,mode);await mkdir(project);
    const file=join(project,'math.mjs');await writeFile(file,'export function add(a, b) { return a - b; }\n');
    await writeFile(join(project,'math.test.mjs'),"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from './math.mjs';\ntest('adds signed numbers',()=>{assert.equal(add(5,3),8);assert.equal(add(-2,7),5);assert.equal(add(0,0),0);});\n");
    const run={mode,ok:false,approvals:0,planReviews:0};report.runs.push(run);const started=Date.now();
    try{
      const w=await app.workflows.start({goal:'Fix add(a,b) in math.mjs so it adds numbers correctly. Inspect math.mjs and math.test.mjs, propose the smallest edit, read the edited file back, then run node --test math.test.mjs and verify its actual output with verify_outcome kind=command_output using the pass marker before reporting the result. Complete the work using tools.'+(strict?' Use the exact required check arguments, then read math.mjs again after the command.':''),...(strict?{requirements:{files:[{path:file,finalNewline:'required',lineEndings:'lf'}],commands:[{program:'node',args:['--test','math.test.mjs'],cwd:project,outputIncludes:'pass 1'}]}}:{}),scope:`Only use ${project}. Edit only math.mjs. The only permitted command is node --test with this folder's math.test.mjs, ${strict?'named by the exact relative argument math.test.mjs':'named by its relative or absolute path'}, and this folder as cwd. No other arguments. Keep the exported function. Prefer a compact plan.`,...(skill?{skills:['project-repair'],skillRevision:skill.revision,skillInputs:{target_files:file,content_requirements:'Fix addition and preserve the exported function. Keep a final newline.',check_command:`node --test math.test.mjs with cwd ${project}`,success_condition:'The adds signed numbers test passes; output includes pass 1 and fail 0.'}}:{})});
      let previous='';
      while(Date.now()-started<600000){
        record=await app.store.get('workflows',w.id);run.record=record;
        const progress=JSON.stringify([record.status,record.current,record.calls,record.operations.at(-1)?.name]);if(progress!==previous){console.log(mode+': '+progress);previous=progress;}
        if(['completed','paused','needs_verification','failed','cancelled','needs_help','waiting_input'].includes(record.status)&&!app.workflows.running.has(w.id))break;
        if(record.status==='plan_review'&&!app.workflows.running.has(w.id)){
          assert(skill||strict);assert.equal(run.planReviews,0);assert.equal(record.operations.length,0);assert(record.steps.length);if(skill){assert(record.skills[0].content.includes(file));assert(!record.skills[0].content.includes(join(dir,'ordinary')));}assert.equal((await app.store.list('actions')).filter(a=>a.workflow?.id===w.id).length,0);
          await app.workflows.control(w.id,'approve_plan','',record.revision);run.planReviews++;
        }
        if(record.status==='waiting_approval')for(const op of record.operations.filter(o=>o.status==='waiting_approval'&&o.action)){
          const a=await app.store.get('actions',op.action);if(a.status!=='pending')continue;
          if(a.kind==='write'){assert.equal(a.payload.path,file);assert.match(a.payload.content,/^export function add\(a,\s*b\)\s*\{\s*return a\s*\+\s*b;?\s*\}\s*$/);}
          else{assert.equal(a.kind,'command');assert.equal(a.payload.program,'/usr/bin/node');assert.equal(a.payload.args.length,2);assert.equal(a.payload.args[0],'--test');assert.equal(resolve(project,a.payload.args[1]),join(project,'math.test.mjs'));assert.equal(a.payload.cwd,project);}
          await app.actions.decide(a.id,'approve',a.digest);run.approvals++;
        }
        await new Promise(r=>setTimeout(r,250));
      }
      assert.equal(record.status,'completed',record.error||'Task timed out');if(strict)assert((await app.workflows.read(w.id)).requirementChecks.every(x=>x.passed));
      assert.equal((await readFile(file,'utf8')).replaceAll(/\s/g,''),'exportfunctionadd(a,b){returna+b;}');
      assert(record.operations.some(o=>o.name==='propose_command'&&o.status==='completed'&&o.result.code===0&&/pass 1/.test(o.result.content)));
      assert.equal(app.workflows.unverifiedWrites(record).length,0);assert(record.operations.some(o=>o.name==='verify_outcome'&&o.status==='completed'&&o.result.kind==='command_output'));
      if(skill){assert.equal(run.planReviews,1);assert(record.operations.every(o=>!source.operations.some(old=>old.id===o.id)));}
      else{source=record;const draft=await app.workflows.skillDraft(w.id);assert(!draft.content.includes(project));skill=await app.workflows.skillDraft(w.id,{skillId:'project-repair',content:draft.content,revision:null});report.reviewedTemplate=draft.content;}
      run.ok=true;console.log('PASS '+mode);
    }catch(e){run.error=e.message;throw e;}finally{run.seconds=Math.round((Date.now()-started)/1000);run.calls=run.record?.calls;run.requirementRejections=run.record?.operations.filter(o=>o.result?.requirementFailures).length;run.toolFailures=run.record?.operations.filter(o=>o.status==='failed'||o.result?.error).length;}
  }
  report.ok=true;
}catch(e){report.error=e.message;process.exitCode=1;console.error(e.message);}
finally{
  await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(r=>setTimeout(r,30));
  await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});for(const name of [`${strict?'requirements-project':'task-skills'}-live-results.json`,`${strict?'requirements-project':'task-skills'}-live-${runId}.json`])await writeFile(new URL('../artifacts/'+name,import.meta.url),JSON.stringify(report,null,2));await rm(dir,{recursive:true,force:true});
}
