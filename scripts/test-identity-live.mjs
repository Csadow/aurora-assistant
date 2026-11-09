import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {characterPresets} from '../src/character.mjs';
const dir=await mkdtemp(join(tmpdir(),'aurora-identity-live-')),results=[];
try{
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:''});
  const profile=await app.character.read();await app.character.save('# Character\n\n'+characterPresets.calm,profile.revision);
  const c=await app.store.conversation();c.messages=[{role:'user',content:'Introduce yourself.'},{role:'assistant',content:'I am Aster, your personal assistant.'}];await app.store.put('conversations',c);
  async function ask(name,message,check){const events=[];await app.assistant.chat({id:c.id,message},AbortSignal.timeout(120000),e=>events.push(e));const text=events.filter(e=>e.type==='chunk').map(e=>e.text).join('');check(text);results.push({name,passed:true,content:text});console.log(JSON.stringify(results.at(-1)));}
  await ask('calm preset and old conversation keep Aurora identity','What is your current name and what pronouns should I use for you? One sentence.',text=>{assert.match(text,/Aurora/);assert.match(text,/she\/her|she and her/i);assert.doesNotMatch(text,/he\/him|no (?:gender|pronouns)/i);});
  await ask('third-person self-reference remains feminine','Describe yourself in the third person in two short sentences. Use your name in the first and a pronoun in the second.',text=>{assert.match(text,/Aurora/);assert.match(text,/\bshe\b/i);assert.doesNotMatch(text,/\bhe\b|\bhis\b|\bthey\b/i);});
}catch(e){results.push({passed:false,error:e.message});throw e;}finally{await writeFile(new URL('../artifacts/identity-live-results.json',import.meta.url),JSON.stringify({date:new Date().toISOString(),results},null,2));await rm(dir,{recursive:true,force:true});}
