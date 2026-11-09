import assert from 'node:assert/strict';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config.mjs';
import { sha } from '../src/vault.mjs';
const base=`http://127.0.0.1:${config.port}`;
for(let i=0;i<30;i++){try{if((await fetch(base+'/api/status')).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));}
const bootstrap=await(await fetch(base+'/api/bootstrap')).json();
const post=async(path,data)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':bootstrap.token},body:JSON.stringify(data)});if(!r.ok)throw new Error(await r.text());return r;};
const c=await(await post('/api/conversations',{})).json();const start=Date.now();
try{
  const r=await post('/api/chat',{id:c.id,message:'Briefly state your current name and pronouns, what this assistant is for, and how its memory should be stored. Answer from my saved profile notes, cite the source notes, and keep it brief.'});
  const events=(await r.text()).trim().split('\n').map(JSON.parse);const done=events.find(e=>e.type==='done');assert(done,JSON.stringify(events));
  const answer=done.conversation.messages.at(-1).content;
  assert.match(answer,/markdown|obsidian/i);assert.match(answer,/life|project|general|personal/i);
  assert.match(answer,/Aurora/);assert.match(answer,/she\/her|she and her/i);
  const status=await(await fetch(base+'/api/status')).json();assert.equal(status.recall,'hybrid');
  const record={date:new Date().toISOString(),url:base,model:status.model,passed:true,seconds:Math.round((Date.now()-start)/100)/10,answer,recall:status.recall,sources:done.conversation.messages.at(-1).sources.map(s=>s.path)};
  await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});await writeFile(new URL('../artifacts/installed-smoke.json',import.meta.url),JSON.stringify(record,null,2));console.log(JSON.stringify(record));
}finally{
  // Remove only the conversation created above and its own journal/revisions.
  const journal=`90 Journal/${c.created.slice(0,10)} ${c.id}.md`;
  await rm(join(config.data,'conversations',`${c.id}.json`),{force:true});
  await rm(join(config.vault,journal),{force:true});await rm(join(config.vault,'.aster/history',sha(journal)),{recursive:true,force:true});
}
