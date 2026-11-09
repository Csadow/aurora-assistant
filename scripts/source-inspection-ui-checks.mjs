import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';

export async function sourceInspectionUIChecks({evaluate,wait,backend,directory,check}){
 const root=join(directory,'source-inspection-ui'),path=join(root,'value.mjs'),notePath='20 Projects/Source inspection fixture.md';
 const question='The snapshot contains <span data-question-injection>literal source</span>. Should I prepare a correction?';
 const prior=backend.assistant.ollama.chat;let id,projectId,turn=0;
 const call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});
 backend.assistant.ollama.chat=async()=>++turn===1?call('read_system_file',{path}):turn===2?call('inspect_source_lines',{evidence:'E1',startLine:2,count:1}):{content:question};
 try{
  await mkdir(root);await writeFile(path,'// Source fixture\nexport const value = "<span data-source-injection>literal</span>";\n');await writeFile(join(root,'test.mjs'),'// UI fixture\n');
  await backend.vault.save(notePath,'# Source inspection\n',null);
  const p=await backend.projectWorkspaces.save({name:'Source inspection',notePath,folders:[root],checks:[{name:'Tests',program:'node',args:['--test','test.mjs'],cwd:root,outputIncludes:'pass 1'}]});projectId=p.id;
  const w=await backend.workflows.start({goal:'Inspect the source and discuss findings before preparing any action.',projectId:p.id,projectRevision:p.revision,projectCheckNames:['Tests'],requirements:{files:[{path,lineEndings:'lf',finalNewline:'required'}],commands:[]}});id=w.id;
  await wait(async()=>{const x=await backend.workflows.read(id);return x.status==='plan_review'&&!backend.workflows.running.has(id);},'source inspection plan');await backend.workflows.control(id,'approve_plan','',w.revision);
  await wait(async()=>{const x=await backend.workflows.read(id);return x.status==='waiting_input'&&!backend.workflows.running.has(id);},'prose question pause');
  const state=await backend.workflows.read(id);assert.equal(state.calls,3);assert.equal(state.question,question);assert.equal((await backend.store.list('actions')).filter(a=>a.workflow?.id===id).length,0);
  await evaluate('document.querySelector("[data-view=chat]").click();document.querySelector("[data-view=workflows]").click()');
  await wait(()=>evaluate(`!!document.querySelector('[data-workflow-open="${id}"]')`),'source inspection task');await evaluate(`document.querySelector('[data-workflow-open="${id}"]').click()`);
  const view=state.operations.find(o=>o.name==='inspect_source_lines'),ask=state.operations.at(-1);
  await wait(()=>evaluate(`!!document.querySelector('[data-evidence="${view.id}"]')`),'source view evidence');
  assert(await evaluate(`(()=>{const p=document.querySelector('[data-evidence="${view.id}"]');return p.textContent.includes('2: export const value')&&p.textContent.includes('snapshotOnly')&&p.textContent.includes('<span data-source-injection>')&&!p.querySelector('[data-source-injection]')})()`));check('source-line inspection retains numbered literal text, snapshot provenance and escaped markup in the task journal');
  assert(await evaluate(`(()=>{const p=document.querySelector('#workflow-detail');return p.textContent.includes(${JSON.stringify(question)})&&document.querySelector('[data-evidence="${ask.id}"]').textContent.includes('model prose')&&!p.querySelector('[data-question-injection]')})()`));check('a prose question appears as a real paused task with escaped text and no action approval');
 }finally{
  if(id)await backend.workflows.control(id,'cancel').catch(()=>{});backend.assistant.ollama.chat=prior;
  if(projectId)await rm(backend.store.file('project-workspaces',projectId));await rm(join(backend.vault.root,notePath),{force:true});await rm(root,{recursive:true,force:true});
 }
}
