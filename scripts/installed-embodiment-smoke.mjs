import assert from 'node:assert/strict';
import {rm,writeFile,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {config} from '../src/config.mjs';
import {sha} from '../src/vault.mjs';
const base=`http://127.0.0.1:${config.port}`,bootstrap=await(await fetch(base+'/api/bootstrap')).json();
const post=async(path,data)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':bootstrap.token},body:JSON.stringify(data),signal:AbortSignal.timeout(240000)});if(!r.ok)throw new Error(await r.text());return r;};
assert((await(await fetch(base+'/api/embodiment')).json()).available,'Visible companion must have automatic expressions enabled');
const c=await(await post('/api/conversations',{})).json(),results=[];
try{
 for(const message of ['This is a temporary UI test, not a fact to remember: show a happy expression and nod through your avatar, then say one short encouraging sentence. Do not create tasks or memories or use computer/system tools.', 'Another temporary UI test: imagine I finally finished a difficult project. Give me one short, warm response as Aurora. Do not save this fictional event or use system tools.']){
  const start=Date.now(),cues=new Map(),phases=new Set();let stopped=false;
  const monitor=(async()=>{while(!stopped){const s=await(await fetch(base+'/api/embodiment')).json();phases.add(s.phase);if(s.cue&&s.cue.startedAt>=start)cues.set(s.cue.id,s.cue);await new Promise(r=>setTimeout(r,150));}})();
  let events=[];
  try{const response=await post('/api/chat',{id:c.id,message});const text=await response.text();events=text.trim().split('\n').map(line=>JSON.parse(line));await new Promise(r=>setTimeout(r,250));}
  finally{stopped=true;await monitor;}
  const done=events.find(e=>e.type==='done');assert(done,JSON.stringify(events.filter(e=>e.type==='error')));assert(events.some(e=>e.type==='avatar'||e.type==='tool'&&e.name==='express_avatar'),'Local model did not choose an expression');assert(cues.size,'No cue reached the desktop service');
  const result={seconds:Math.round((Date.now()-start)/100)/10,answer:done.conversation.messages.at(-1).content,cues:[...cues.values()].map(({mood,gesture})=>({mood,gesture})),phases:[...phases]};results.push(result);console.log(JSON.stringify(result));
 }
 await writeFile(new URL('../artifacts/installed-embodiment-smoke.json',import.meta.url),JSON.stringify({passed:true,version:bootstrap.version,model:bootstrap.model,results},null,2));
}finally{
 const journal=`90 Journal/${c.created.slice(0,10)} ${c.id}.md`;await rm(join(config.data,'conversations',c.id+'.json'),{force:true});await rm(join(config.vault,journal),{force:true});await rm(join(config.vault,'.aster/history',sha(journal)),{recursive:true,force:true});
 for(const folder of ['actions','proposals'])for(const name of await readdir(join(config.data,folder))){if(!name.endsWith('.json'))continue;const file=join(config.data,folder,name);const record=JSON.parse(await readFile(file,'utf8'));if(record.conversation===c.id)await rm(file);}
}
