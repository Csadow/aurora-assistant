import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
const model=process.argv[2]||'qwen3.5:4b',dir=await mkdtemp(join(tmpdir(),'aurora-agents-live-'));
const app=await createApp({model,vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:''});
const thinking=process.argv.includes('--thinking');
await app.models.save({model,thinking});
const report={model,thinking,at:new Date().toISOString(),checks:[]};
try{
 await app.vault.save('20 Projects/Beacon.md','# Beacon\n\nBeacon is a local note-organizing project. Its review is Thursday at 14:00. Before review, prepare a Markdown export and check three sample notes. The user has 40 minutes available.\n',null);
 const job=await app.agents.start({role:'team',task:'Read the Beacon project note, then plan how to prepare for its review within the available time. Cite the project note. Keep each specialist response under 120 words.',skills:['daily-planning']});
 const run=await app.agents.running.get(job.id).work;
 report.run=run;assert.equal(run.status,'completed',run.error);assert.equal(run.steps.length,3);assert.match(run.result,/Beacon/);assert.match(run.result,/Thursday|14:00|2\s*PM/i);assert.match(run.result,/40/);assert((run.result.match(/[а-яё]/gi)||[]).length<30,'English task unexpectedly answered in Russian');assert.equal((await app.store.list('actions')).length,0);assert.equal((await app.store.list('proposals')).length,0);report.checks.push('real local planner, researcher, and reviewer produce a grounded report using a selected Markdown skill without taking actions');
 const c=await app.store.conversation();let result='';await app.assistant.chat({id:c.id,message:'Use the researcher agent to find the Beacon review time. Then tell me the time and the supporting note. Delegate once; do not schedule or change anything.'},AbortSignal.timeout(900000),e=>{if(e.type==='chunk')result+=e.text;});
 const delegated=(await app.store.list('runs')).filter(r=>r.conversation===c.id);report.delegation={result,runs:delegated};assert(delegated.some(r=>r.status==='completed'),'Model did not successfully delegate');assert.match(result,/Thursday|14:00|2\s*PM/i);report.checks.push('real Aurora chat delegates to a specialist and incorporates its report');report.ok=true;
}finally{await writeFile(new URL('../artifacts/agents-live-'+model.replace(/[^a-z0-9-]/gi,'_')+'.json',import.meta.url),JSON.stringify(report,null,2));app.agents.stopAll();await Promise.allSettled([...app.agents.running.values()].map(r=>r.work));await rm(dir,{recursive:true,force:true});}
console.log(JSON.stringify({model,ok:report.ok,checks:report.checks}));
