import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
export async function testCopyUIChecks({evaluate,wait,backend,directory,check,screenshot}){
  const root=join(directory,'copy-test-project'),path=join(root,'fit.mjs'),notePath='20 Projects/Copy test UI fixture.md';
  const source='// <em data-copy-injected>literal source</em>\nexport const fit=(w,a)=>Math.max(w,a);\n';
  const files={'fit.mjs':source,'package.json':'{"type":"module"}\n','fit.test.mjs':"import test from 'node:test';import assert from 'node:assert/strict';import {fit} from './fit.mjs';test('small',()=>assert.equal(fit(700,1280),700));test('large',()=>assert.equal(fit(460,320),320));\n"};
  const priorProject=await evaluate('localStorage.getItem("aurora-project")');
  const priorProjectName=priorProject?(await backend.projectWorkspaces.read(priorProject)).name:null;
  const prior=backend.assistant.ollama.chat;let id,routineId,projectId,n=0;
  const call=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});
  backend.assistant.ollama.chat=async messages=>{
    const c=JSON.parse(messages.at(-1).content);n++;
    if(n<=3)return call('read_system_file',{path:join(root,Object.keys(files)[n-1])});
    if(n===4)return call('record_repair_plan',{repairs:[{file:path,line:2,before:'Math.max(w,a)',after:'Math.min(w,a)',reason:'Bound width while preserving the other source.'}]});
    if(n===5)return call('propose_test_copy',{repair:c.repairPlan.repairs[0].id,check:'C1'});
    if(n===6)return call('request_help',{reason:'The diagnostic check is complete.',question:'Review the copy result before applying the repair.'});
    if(n===7)return call('read_system_file',{path});
    return call('propose_repair',{repair:c.repairPlan.repairs[0].id});
  };
  try{
    await mkdir(root);for(const [p,c] of Object.entries(files))await writeFile(join(root,p),c);
    await backend.vault.save(notePath,'# Copy test fixture\n',null);
    const p=await backend.projectWorkspaces.save({name:'Copy test fixture',notePath,folders:[root],checks:[{name:'Window tests',program:'node',args:['--test','fit.test.mjs'],cwd:root,outputIncludes:'pass 2'}]});projectId=p.id;
    await evaluate('document.querySelector("[data-view=projects]").click()');
    if(priorProject)await wait(()=>evaluate(`document.querySelector('#project-name')?.value===${JSON.stringify(priorProjectName)}&&document.querySelector('#project-history h3')?.textContent===${JSON.stringify(priorProjectName)}`),'prior project fully loaded before fixture selection');
    await wait(()=>evaluate(`!!document.querySelector('[data-project-open="${p.id}"]')`),'routine fixture project');
    await evaluate(`document.querySelector('[data-project-open="${p.id}"]').click()`);
    await wait(()=>evaluate(`document.querySelector('#project-name')?.value==='Copy test fixture'&&document.querySelector('#project-history h3')?.textContent==='Copy test fixture'&&localStorage.getItem('aurora-project')===${JSON.stringify(p.id)}`),'routine project fully loaded');
    await evaluate('document.querySelector("#project-new-task").click()');
    await wait(()=>evaluate('!!document.querySelector("#workflow-routine-continuation")'),'routine option');
    assert.equal(await evaluate('document.querySelector("#workflow-routine-continuation").checked'),false);
    await evaluate(`(()=>{document.querySelector('#workflow-goal').value='Routine review fixture';document.querySelector('#workflow-goal').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-project-check]').click();document.querySelector('#workflow-routine-continuation').click();document.querySelector('#workflow-requirements-fields [data-add-file]').click();const field=document.querySelector('#workflow-requirements-fields [data-req=path]');field.value=${JSON.stringify(path)};field.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#workflow-form').requestSubmit();})()`);
    await wait(async()=>(await backend.store.list('workflows')).some(w=>w.goal==='Routine review fixture'&&w.status==='plan_review'),'routine plan');
    const routine=(await backend.store.list('workflows')).find(w=>w.goal==='Routine review fixture'&&w.status==='plan_review');routineId=routine.id;
    assert.equal(routine.routineContinuation,true);assert.equal(routine.operations.length,0);assert.equal(n,0);
    await wait(()=>evaluate('!!document.querySelector("[data-routine-policy]")'),'routine disclosure');
    assert(await evaluate('document.querySelector("[data-routine-policy]").textContent.includes("exact approval")'));check('routine choice reaches the saved task and is disclosed before plan approval, without executing work');
    await backend.workflows.control(routine.id,'cancel');
    const w=await backend.workflows.start({goal:'Repair width, test the proposed repair in a temporary copy before applying it, then verify the original project.',projectId:p.id,projectRevision:p.revision,projectCheckNames:['Window tests'],copyBeforeEditCheck:'Window tests',requirements:{files:[{path,lineEndings:'lf',finalNewline:'required'}],commands:[]}});id=w.id;
    await wait(async()=>{const w=await backend.workflows.read(id);return w.status==='plan_review'&&!backend.workflows.running.has(id);},'copy plan review');await backend.workflows.control(id,'approve_plan','',w.revision);
    await wait(async()=>{const w=await backend.workflows.read(id);return w.status==='waiting_approval'&&!backend.workflows.running.has(id);},'copy action review');
    const pending=await backend.workflows.read(id),action=await backend.store.get('actions',pending.operations.at(-1).action);assert.equal(action.kind,'test_copy');
    await evaluate('document.querySelector("[data-view=actions]").click()');
    await wait(()=>evaluate(`!!document.querySelector('[data-review="${action.id}"]')`),'copy action card');await evaluate(`document.querySelector('[data-review="${action.id}"]').click()`);
    await wait(()=>evaluate('document.querySelector("#action-review-dialog").open&&!!document.querySelector("[data-copy-preview]")'),'copy preview');
    assert(await evaluate('document.querySelector("#action-review-title").textContent==="Review test in a copy"&&document.querySelector("#action-approve").disabled'));check('copy execution is a distinct action with explicit acknowledgement');
    assert(await evaluate('(()=>{const p=document.querySelector("[data-copy-preview]");return p.querySelectorAll("[data-copy-file]").length===3&&p.textContent.includes("/usr/bin/bwrap")&&p.textContent.includes("--test")&&p.textContent.includes("pass 2")&&p.textContent.includes("/tmp/aurora-task-copy-")})()'));check('copy preview shows the saved check, exact isolated commands, temporary folder and dependency snapshot');
    assert(await evaluate('document.querySelector("[data-copy-preview]").textContent.includes("<em data-copy-injected>")&&!document.querySelector("[data-copy-injected]")'));check('source and candidate markup is escaped in copy review');
    if(screenshot)await screenshot('test-copy-review.png');assert.equal(await readFile(path,'utf8'),source);
    await evaluate('document.querySelector("#action-ack").click();document.querySelector("#action-approve").click()');
    await wait(async()=>{const a=await backend.store.get('actions',action.id);return a.status==='completed'&&!backend.actions.running.has(a.id);},'actual isolated tests');
    const tested=await backend.store.get('actions',action.id);assert.deepEqual(tested.result.runs.map(r=>r.passed),[false,true]);assert.equal(await readFile(path,'utf8'),source);check('reviewed copies run real tests while the original source remains unchanged');
    await wait(async()=>{const w=await backend.workflows.read(id);return w.status==='needs_help'&&!backend.workflows.running.has(id);},'copy results pause');
    await evaluate(`document.querySelector('[data-review="${action.id}"]').click()`);await wait(()=>evaluate('!!document.querySelector("[data-copy-result]")'),'copy result panel');
    assert(await evaluate('(()=>{const p=document.querySelector("[data-copy-result]");return p.textContent.includes("baseline")&&p.textContent.includes("candidate")&&p.textContent.includes("Saved check passed")&&p.textContent.includes("Saved check did not pass")&&p.textContent.includes("Temporary copies removed")})()'));check('copy results retain both failing baseline and passing candidate with cleanup receipt');
    assert(await evaluate('(()=>{const p=document.querySelector("[data-copy-diagnosis]");return p&&p.textContent.includes("Math.max(w,a)")&&p.textContent.includes("Math.min(w,a)")&&p.querySelectorAll("tbody tr").length===2&&p.textContent.includes("2 failed → passed")&&p.querySelectorAll("[data-copy-failure]").length===2&&p.textContent.includes("assert.equal(fit(700,1280),700)")})()'));check('repair review connects the exact change, observed failures and copied test source without approving an edit');
    assert(await evaluate('(()=>{const runs=[...document.querySelectorAll("#action-review-content [data-copy-run]")];return runs.length===2&&runs.every(r=>!r.open)})()'));await evaluate('document.querySelector("#action-review-content [data-copy-run=candidate]").open=true');assert(await evaluate('document.querySelector("#action-review-content [data-copy-run=candidate]").open'));check('parsed copy comparison folds raw logs but keeps both available for inspection');
    await evaluate('document.querySelector("#action-review-close").click();document.querySelector("[data-view=workflows]").click()');await wait(()=>evaluate(`!!document.querySelector('[data-workflow-open="${id}"]')`),'copy workflow');await evaluate(`document.querySelector('[data-workflow-open="${id}"]').click()`);await wait(()=>evaluate('!!document.querySelector("[data-workflow-copies]")'),'copy workflow history');check('task review retains copy-test history separately from file edits');
    assert(await evaluate('!!document.querySelector("[data-copy-policy]")'));check('the reviewed task displays its fixed test-before-edit requirement');
    await backend.workflows.control(id,'resume');await wait(async()=>{const w=await backend.workflows.read(id);return w.status==='waiting_approval'&&!backend.workflows.running.has(id);},'separate repair approval');
    const next=await backend.workflows.read(id),edit=await backend.store.get('actions',next.operations.at(-1).action);assert.equal(edit.kind,'write');assert.equal(await readFile(path,'utf8'),source);assert(next.requirementChecks.some(c=>c.kind==='command'&&!c.passed));check('passing copy tests still require separate original edit and saved-check approval');
    await evaluate('document.querySelector("[data-view=actions]").click()');await wait(()=>evaluate(`!!document.querySelector('[data-review="${edit.id}"]')`),'tested edit card');await evaluate(`document.querySelector('[data-review="${edit.id}"]').click()`);
    await wait(()=>evaluate('!!document.querySelector("[data-copy-edit-review]")'),'tested edit result review');
    assert(await evaluate('document.querySelector("#action-approve").disabled&&!document.querySelector("#action-ack-label").hidden&&document.querySelector("[data-copy-edit-review]").textContent.includes("assertion failure")'));check('applying a tested candidate displays both results and requires acknowledgement');

  }finally{
    await evaluate('document.querySelector("#action-review-dialog")?.close()').catch(()=>{});
    if(routineId)await backend.workflows.control(routineId,'cancel').catch(()=>{});
    if(id)await backend.workflows.control(id,'cancel').catch(()=>{});backend.assistant.ollama.chat=prior;
    if(priorProject&&await evaluate(`!!document.querySelector('[data-project-open="${priorProject}"]')`)){
      await evaluate(`document.querySelector('[data-project-open="${priorProject}"]').click()`);
      await wait(()=>evaluate(`localStorage.getItem('aurora-project')===${JSON.stringify(priorProject)}&&document.querySelector('#project-name')?.value===${JSON.stringify(priorProjectName)}&&document.querySelector('#project-history h3')?.textContent===${JSON.stringify(priorProjectName)}`),'original project selection and editor restored');
    }else await evaluate('document.querySelector("#project-create")?.click()');
    if(projectId)await rm(backend.store.file('project-workspaces',projectId));await rm(join(backend.vault.root,notePath),{force:true});await rm(root,{recursive:true,force:true});
  }
}
