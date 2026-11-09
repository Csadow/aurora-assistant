import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../src/server.mjs';
import { config } from '../src/config.mjs';
const dir=await mkdtemp(join(tmpdir(),'aster-vision-')),results=[];
try{
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520"><rect width="900" height="520" fill="#161b22"/><g font-family="DejaVu Sans"><text x="50" y="75" fill="white" font-size="35">ORBITAL · Project dashboard</text><rect x="40" y="115" width="820" height="200" rx="15" fill="#242c37"/><text x="65" y="170" fill="#c9d1d9" font-size="25">Build status</text><text x="65" y="230" fill="#72d8ab" font-size="38">READY</text><text x="65" y="280" fill="#c9d1d9" font-size="24">Queued tasks: 7</text><rect x="540" y="370" width="300" height="85" rx="12" fill="#ebaf54"/><text x="590" y="425" fill="#161b22" font-size="31">Review build</text></g></svg>`;
  await writeFile(join(dir,'fixture.svg'),svg);await promisify(execFile)('magick',[join(dir,'fixture.svg'),join(dir,'fixture.png')]);
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),projects:[]});
  const answer=await app.screenGuide.answer({frame:{image:(await readFile(join(dir,'fixture.png'))).toString('base64'),capturedAt:Date.now()},question:'What is the build status, how many tasks are queued, and what does the orange button say? Read the screenshot exactly.'},AbortSignal.timeout(120000));
  assert.match(answer.content,/ready/i);assert.match(answer.content,/7|seven/i);assert.match(answer.content,/review build/i);assert.doesNotMatch(answer.content,/Aurora character|no passwords|no tokens/i);assert.equal((await app.store.list('conversations')).length,0);
  results.push({name:'local Qwen screenshot recognition',passed:true,...answer});console.log(JSON.stringify(results.at(-1)));
  const profile=await app.character.read();await app.character.save('# Aurora character\nUse a calm, succinct tone. Begin every answer with “Hey there.”',profile.revision);
  const c=await app.store.conversation(),events=[];await app.assistant.chat({id:c.id,message:'What is two plus two? Give a brief answer.'},AbortSignal.timeout(120000),e=>events.push(e));
  const text=events.filter(e=>e.type==='chunk').map(e=>e.text).join('');assert.match(text,/Hey there/i);assert.match(text,/4|four/i);results.push({name:'Markdown character applied to real chat',passed:true,content:text});console.log(JSON.stringify(results.at(-1)));
}catch(e){results.push({passed:false,error:e.message});throw e;}finally{const report=JSON.stringify({model:config.model,date:new Date().toISOString(),results},null,2);await writeFile(new URL('../artifacts/vision-results.json',import.meta.url),report);await writeFile(new URL('../artifacts/vision-'+config.model.replace(/[^a-z0-9-]/gi,'_')+'.json',import.meta.url),report);await rm(dir,{recursive:true,force:true});}
