import assert from 'node:assert/strict';
import {writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
export async function exampleReviewUIChecks({evaluate,wait,backend,directory,check,screenshot}){
 const path=join(directory,'example-review.mjs'),notePath='20 Projects/Example review UI fixture.md',before='const result=width+left+right;\n',prior=backend.assistant.ollama.chat;let id,projectId,n=0;
 const call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});
 backend.assistant.ollama.chat=async m=>{
  const c=JSON.parse(m.at(-1).content);n++;
  if(n===1||n===6)return call('read_system_file',{path});
  if(n===2)return call('record_repair_plan',{repairs:[{file:path,line:1,before:'width+left+right',after:'width-left-right',reason:'Subtract both margins.'}]});
  if(n===3||n===4)return call('check_repair_expression',{repair:c.repairPlan.repairs[0].id,cases:[{inputs:{width:n===3?1280:720,left:10,right:10},expected:700}]});
  if(n===5)return call('request_help',{reason:'The original example used a pixel width.',question:'Please review the example against the task goal.'});
  return call('propose_repair',{repair:c.repairPlan.repairs[0].id});
 };
 const open=async()=>{await evaluate('document.querySelector("[data-view=chat]").click();document.querySelector("[data-view=workflows]").click()');await wait(()=>evaluate(`!!document.querySelector('[data-workflow-open="${id}"]')`),'example task');await evaluate(`document.querySelector('[data-workflow-open="${id}"]').click()`);await wait(()=>evaluate('document.querySelector("#workflow-detail > .panel-heading h3")?.textContent.startsWith("Use logical width:")&&!!document.querySelector("[data-example-ledger]")'),'example ledger for selected task');};
 try{
  await writeFile(path,before);await writeFile(join(backend.vault.root,notePath),'# Example review fixture\n',{flag:'wx'});
  const p=await backend.projectWorkspaces.save({name:'Example review fixture',notePath,folders:[directory],checks:[{name:'Check',program:'node',args:['--version'],cwd:directory,outputIncludes:'v'}]});projectId=p.id;
  const w=await backend.workflows.start({goal:'Use logical width: 720 minus 10 on each side gives 700. <span data-fake-example> is text.',projectId:p.id,projectRevision:p.revision,projectCheckNames:['Check'],requirements:{files:[{path,lineEndings:'lf',finalNewline:'required'}],commands:[]}});id=w.id;
  await wait(async()=>{const w=await backend.workflows.read(id);return w.status==='plan_review'&&!backend.workflows.running.has(id);},'example plan');await backend.workflows.control(id,'approve_plan','',w.revision);
  await wait(async()=>{const w=await backend.workflows.read(id);return w.status==='needs_help'&&!backend.workflows.running.has(id);},'example help');await open();
  assert(await evaluate('(()=>{const t=document.querySelector("[data-example-ledger]").textContent;return t.includes("1/2 match")&&t.includes("Original proposed result: 1260")&&t.includes("absent from latest check, retained")})()'));check('example ledger retains the original failure when a different scenario passes');
  await evaluate('document.querySelector("[data-review-example]").click()');await wait(()=>evaluate('document.querySelector("[data-example-review]")?.open'),'example editor');
  await evaluate('(()=>{const f=document.querySelector("[data-example-review] form");f.elements.inputs.value=JSON.stringify({width:720,left:10,right:10});f.elements.reason.value="Use logical width <span data-fake-example>";f.elements.quote.value="720 minus 10 on each side gives 700";f.dispatchEvent(new Event("input",{bubbles:true}));f.requestSubmit()})()');
  await wait(()=>evaluate('!document.querySelector("[data-example-save]").disabled'),'example preview');
  assert(await evaluate('(()=>{const d=document.querySelector("[data-example-review]");return d.textContent.includes("Computed result: 700")&&d.textContent.includes("Previous effective example")&&d.textContent.includes("1280")&&d.textContent.includes("<span data-fake-example>")&&!d.querySelector("[data-fake-example]")})()'));check('editable review previews old and new values, computed result and quoted provenance with escaped text');if(screenshot)await screenshot('example-review-preview.png');
  await evaluate('(()=>{const f=document.querySelector("[data-example-review] form");f.elements.reason.value+=" confirmed";f.elements.reason.dispatchEvent(new Event("input",{bubbles:true}))})()');assert(await evaluate('document.querySelector("[data-example-save]").disabled'));check('editing a reviewed draft invalidates its previous preview');
  await open();assert(await evaluate('document.querySelector("[data-example-review] form").elements.reason.value.endsWith("confirmed")'));check('task panel refresh preserves the open example draft');
  await evaluate('document.querySelector("[data-example-review] form").requestSubmit()');await wait(()=>evaluate('!document.querySelector("[data-example-save]").disabled'),'new preview');await evaluate('document.querySelector("[data-example-save]").click()');await wait(()=>evaluate('document.querySelector("[data-example-preview]").textContent.includes("Reviewed correction saved")'),'saved example');
  const saved=await backend.workflows.read(id),r=saved.repairPlan.repairs[0];assert.equal(r.exampleLedger.failed,0);assert.equal(r.exampleLedger.cases[0].original.matches,false);assert.equal(saved.status,'needs_help');assert.equal(await readFile(path,'utf8'),before);assert.equal((await backend.store.list('actions')).filter(a=>a.workflow?.id===id).length,0);check('saving a correction retains failure history and leaves execution paused with no actions');
  await evaluate('document.querySelector("[data-example-close]").click()');await backend.workflows.control(id,'resume');await wait(async()=>{const w=await backend.workflows.read(id);return w.status==='waiting_approval'&&!backend.workflows.running.has(id);},'reviewed repair approval');
  assert.equal(await readFile(path,'utf8'),before);const pending=await backend.workflows.read(id),a=await backend.store.get('actions',pending.operations.at(-1).action);assert.equal(a.payload.content,before.replace('width+left+right','width-left-right'));check('resuming stages the exact repair for a separate approval without writing it');
 }finally{await evaluate('document.querySelector("[data-example-review]")?.close()').catch(()=>{});if(id)await backend.workflows.control(id,'cancel').catch(()=>{});backend.assistant.ollama.chat=prior;if(projectId)await rm(backend.store.file('project-workspaces',projectId));await rm(join(backend.vault.root,notePath),{force:true});}
}
