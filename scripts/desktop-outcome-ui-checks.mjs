import assert from 'node:assert/strict';
export async function desktopOutcomeUIChecks({evaluate,wait,backend,check,screenshot}){
 const q=JSON.stringify,click=s=>evaluate(`document.querySelector(${q(s)}).click()`),set=(s,v)=>evaluate(`{const e=document.querySelector(${q(s)});e.value=${q(v)};e.dispatchEvent(new Event('input',{bubbles:true}));}`);
 const previous=backend.assistant.ollama.chat,evil='report.md <img src=x onerror="window.outcomeXSS=true">';let id;
 backend.assistant.ollama.chat=async()=>({content:JSON.stringify({steps:[{title:'Check the requested page and document',check:'Observe exact saved outcomes.'}]})});
 try{
  await click('[data-view=workflows]');await evaluate('document.querySelector("#workflow-output-requirements").open=true');await set('#workflow-goal','Verify the exact browser page and document window.');
  await click('#workflow-requirements-fields [data-add-browser]');await set('#workflow-requirements-fields [data-rule=browser] [data-req=url]','HTTPS://EXAMPLE.COM');await set('#workflow-requirements-fields [data-rule=browser] [data-req=title]','Expected report');
  await click('#workflow-requirements-fields [data-add-window]');await set('#workflow-requirements-fields [data-rule=window] [data-req=title]',evil);await set('#workflow-requirements-fields [data-rule=window] [data-req=app]','org.example.Editor');
  assert.equal(await evaluate('document.querySelector("#workflow-start").textContent'),'Prepare plan');
  const before=(await backend.store.list('workflows')).map(w=>w.id);await click('#workflow-start');
  await wait(async()=>{const w=(await backend.store.list('workflows')).find(w=>!before.includes(w.id));if(w?.status==='plan_review'){id=w.id;return true;}},'desktop outcome plan review');
  await wait(()=>evaluate('!!document.querySelector("#workflow-requirements-status [data-window-requirement]")'),'desktop outcome review');
  const w=await backend.workflows.read(id);assert.equal(w.operations.length,0);assert.equal(w.requirements.browser.url,'https://example.com/');assert.equal(w.requirements.window.title,evil);assert.equal(w.requirementChecks.length,2);assert(w.requirementChecks.every(c=>!c.passed));
  assert.equal(await evaluate('!!document.querySelector("#workflow-requirements-status img")'),false);assert.equal(await evaluate('window.outcomeXSS'),undefined);assert(await evaluate('document.querySelector("#workflow-requirements-status").textContent.includes("0/2 requirements")'));
  check('browser and window conditions alone require plan review, show normalized exact values and escape titles');
  if(screenshot){await evaluate('document.querySelector("#workflow-requirements-status").scrollIntoView({block:"center"});document.querySelector("#toast").hidden=true');await screenshot('desktop-outcome-requirements.png');}
  await click('#requirements-edit');await wait(()=>evaluate('!!document.querySelector("#workflow-requirements-edit [data-rule=browser]")'),'desktop outcome editor');
  assert.equal(await evaluate('document.querySelector("#workflow-requirements-edit [data-rule=window] [data-req=title]").value'),evil);
  await set('#workflow-requirements-edit [data-rule=window] [data-req=title]','report.md — Editor');await set('#workflow-requirements-edit [data-rule=browser] [data-req=title]','');await set('#workflow-requirements-edit [data-rule=window] [data-req=app]','');await click('#workflow-requirements-edit button.primary');
  await wait(async()=>{const r=await backend.workflows.read(id);return r.revision===2&&r.status==='plan_review';},'revised desktop conditions');
  const revised=await backend.workflows.read(id);assert.deepEqual(revised.requirements.browser,{url:'https://example.com/'});assert.deepEqual(revised.requirements.window,{title:'report.md — Editor'});assert.equal(revised.planHistory[0].requirements.window.title,evil);assert.equal(revised.operations.length,0);
  check('editing desktop conditions retains prior review and requires a new plan; empty optional matches are omitted');
  await backend.workflows.control(id,'cancel');await set('#workflow-goal','');
 }finally{backend.assistant.ollama.chat=previous;if(id){const w=await backend.workflows.read(id);if(!['completed','cancelled'].includes(w.status))await backend.workflows.control(id,'cancel');}}
}
