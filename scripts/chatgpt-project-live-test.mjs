import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../src/server.mjs';
import {ChatGPTPlan} from '../src/chatgpt-plan.mjs';

if(!process.argv.includes('--live'))throw Error('Pass --live to use the connected ChatGPT account for this isolated fixture.');
const base='http://127.0.0.1:4717';
const get=async path=>{const response=await fetch(base+path,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Installed Aurora is unavailable: '+path);return response.json();};
const [workflows,actions,agents]=await Promise.all(['/api/workflows','/api/actions','/api/agents'].map(get));
if(workflows.some(w=>['running','planning','queued'].includes(w.status))||actions.some(a=>a.status==='running')||agents.runs.some(a=>['running','queued'].includes(a.status)))throw Error('Wait for active Aurora work to finish before refreshing the account token.');

const plan=new ChatGPTPlan({data:process.env.AURORA_CHATGPT_DATA||join(homedir(),'.local/share/aurora-assistant')});
await plan.init();assert.equal(plan.active()?.model,'gpt-6-astra','Keep the selected ChatGPT model unchanged for this comparison.');
assert.equal(plan.status().connected,true,'Reconnect the saved ChatGPT account in Aurora Settings before this trial.');
const expiresAt=plan.active().expiresAt;
await plan.access();
const refreshed=plan.active().expiresAt!==expiresAt;
const dir=await mkdtemp(join(tmpdir(),'aurora-chatgpt-project-live-')),project=join(dir,'project'),data=join(dir,'data');
await mkdir(project);await mkdir(data);
const file=join(project,'math.mjs'),testFile=join(project,'math.test.mjs');
await writeFile(file,'export function add(a, b) { return a - b; }\n');
await writeFile(testFile,"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from './math.mjs';\ntest('adds signed numbers',()=>{assert.equal(add(5,3),8);assert.equal(add(-2,7),5);assert.equal(add(0,0),0);});\n");
let app,record,approvals=0,error=null;
const started=Date.now(),timeout=Number(process.env.AURORA_CHATGPT_PROJECT_TIMEOUT_MS||600000);
try{
 const local={model:'qwen3.5:9b',generationOptions:{},chat:async()=>{throw Error('Cloud fixture used local inference.');},check:async()=>{throw Error('Cloud fixture used local inference.');},status:async()=>({online:true,model:'qwen3.5:9b',models:[{name:'qwen3.5:9b'}]})};
 app=await createApp({vault:join(dir,'vault'),data,backups:join(dir,'backups'),ollamaClient:local,embedding:'',projects:[{name:'Fixture',root:project}]});
 app.assistant.chatgpt.plan=plan;
 const allowed=app.system.allowed.bind(app.system);app.system.allowed=path=>{assert(path===project||path.startsWith(project+'/'),'Only disposable project access is allowed');return allowed(path);};
 const workflow=await app.workflows.start({engine:'chatgpt',goal:'Fix add(a,b) in math.mjs so it adds numbers correctly. Inspect math.mjs and math.test.mjs, propose the smallest edit, read the edited file back, then run node --test math.test.mjs and verify its actual output with verify_outcome kind=command_output using the pass marker before reporting the result. Complete the work using tools.',scope:`Only use ${project}. Edit only math.mjs. The only permitted command is node --test with this folder's math.test.mjs, named by its relative or absolute path, and this folder as cwd. No other arguments. Keep the exported function. Prefer a compact plan.`});
 let previous='';
 while(Date.now()-started<timeout){
  record=await app.store.get('workflows',workflow.id);
  const progress=JSON.stringify([record.status,record.current,record.calls,record.operations.at(-1)?.name]);
  if(progress!==previous){console.log('ChatGPT fixture: '+progress);previous=progress;}
  if(['completed','paused','needs_verification','failed','cancelled','needs_help','waiting_input'].includes(record.status))break;
  if(record.status==='waiting_approval')for(const op of record.operations.filter(o=>o.status==='waiting_approval'&&o.action)){
   const action=await app.store.get('actions',op.action);if(action.status!=='pending')continue;
   if(action.kind==='write'){
    assert.equal(action.payload.path,file);
    assert.match(action.payload.content,/^export function add\(a,\s*b\)\s*\{\s*return a\s*\+\s*b;?\s*\}\s*$/);
   }else{
    assert.equal(action.kind,'command');assert.equal(action.payload.program,'/usr/bin/node');
    assert.equal(action.payload.args.length,2);assert.equal(action.payload.args[0],'--test');
    assert.equal(resolve(project,action.payload.args[1]),testFile);assert.equal(action.payload.cwd,project);
   }
   await app.actions.decide(action.id,'approve',action.digest);approvals++;
  }
  await new Promise(resolve=>setTimeout(resolve,400));
 }
 assert.equal(record?.status,'completed',record?.error||'ChatGPT workflow timed out');
 assert.equal((await readFile(file,'utf8')).replaceAll(/\s/g,''),'exportfunctionadd(a,b){returna+b;}');
 assert(record.operations.some(o=>o.name==='propose_command'&&o.status==='completed'&&o.result.code===0&&/pass 1/.test(o.result.content)));
 assert(record.operations.some(o=>o.name==='verify_outcome'&&o.status==='completed'&&o.result.kind==='command_output'));
 assert.equal(app.workflows.unverifiedWrites(record).length,0);
 assert.equal((await app.workflows.read(record.id)).health.code,'completed');
}catch(caught){error=caught.message;throw caught;}
finally{
 const result={ok:!error&&record?.status==='completed',error,refreshed,seconds:Math.round((Date.now()-started)/1000),approvals,status:record?.status||null,calls:record?.calls||0,steps:record?.steps?.map(s=>({title:s.title,status:s.status}))||[],operations:record?.operations?.map(o=>({name:o.name,status:o.status,error:o.result?.error||null}))||[]};
 await writeFile(new URL('../artifacts/chatgpt-project-live-result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
 if(app){await app.workflows.close();app.actions.stopAll();while(app.actions.running.size)await new Promise(resolve=>setTimeout(resolve,30));}
 await rm(dir,{recursive:true,force:true});plan.close();
}
