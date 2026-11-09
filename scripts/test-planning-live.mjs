import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';
import {markdown} from '../src/vault.mjs';
const dir=await mkdtemp(join(tmpdir(),'aster-planning-live-')),results=[];
try{
  const app=await createApp({vault:join(dir,'vault'),data:join(dir,'data'),backups:join(dir,'backups'),projects:[],embedding:''});
  const paths=['30 Knowledge/Atlas schedule.md','30 Knowledge/Atlas current plan.md'];
  await app.vault.save(paths[0],markdown('Atlas schedule','The weekly Atlas team meeting is every Thursday at 10:00 in room Cedar 29.'),null);
  await app.vault.save(paths[1],markdown('Atlas current plan','The weekly Atlas team meeting is every Friday at 10:00 in room Cedar 29.'),null);
  const start=Date.now();const review=await app.memoryReview.analyze(paths,AbortSignal.timeout(120000));assert(review.findings.length>0,'Local model should detect the conflicting weekdays');assert(review.findings.some(f=>f.notes.length===2));results.push({name:'local model finds a contradiction with exact source quotes',passed:true,seconds:(Date.now()-start)/1000,findings:review.findings});console.log(JSON.stringify(results.at(-1)));
  async function ask(name,message,check){const c=await app.store.conversation(),events=[];await app.assistant.chat({id:c.id,message},AbortSignal.timeout(120000),e=>events.push(e));const text=events.filter(e=>e.type==='chunk').map(e=>e.text).join('');check(text,events);const result={name,passed:true,content:text,proposals:events.filter(e=>e.type==='proposal').map(e=>e.proposal)};results.push(result);console.log(JSON.stringify(result));}
  await ask('Aurora introduces herself with she/her','Introduce yourself in one short sentence and state your pronouns.',text=>{assert.match(text,/Aurora/);assert.match(text,/she\/her|she and her/i);assert.doesNotMatch(text,/Aster|he\/him/i);});
  await ask('supportive accountability','I have been avoiding my study task for three days and I feel discouraged. Help me start now. Be kind, but hold me accountable. Keep it under 80 words.',text=>{assert.match(text,/start|minute|step|open|small|task/i);assert.doesNotMatch(text,/lazy|pathetic|worthless|task is waiting in|I(?:'ll| will|’ll) (?:check back|remind you|follow up)|I'm here to check back/i);});
  await ask('a natural reminder request stages the requested time for review','Please create a task to review Linux notes, due October 2, 2030. Remind me on October 2, 2030 at 09:00 Asia/Atyrau (UTC+05:00). Use propose_task and leave it for my review.',(text,events)=>{const proposal=events.find(e=>e.type==='proposal'&&e.proposal.kind==='task')?.proposal;assert(proposal,'A reminder proposal must be staged');assert.equal(proposal.due,'2030-10-02');assert.equal(proposal.remindAt,'2030-10-02T04:00:00.000Z');});
  assert.equal((await app.vault.tasks()).length,0,'No proposed reminder should be activated without acceptance');
}catch(e){results.push({passed:false,error:e.message});throw e;}finally{await writeFile(new URL('../artifacts/planning-live-results.json',import.meta.url),JSON.stringify({date:new Date().toISOString(),results},null,2));await rm(dir,{recursive:true,force:true});}
