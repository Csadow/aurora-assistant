import assert from 'node:assert/strict';

export async function workflowFormDraftUIChecks({app,evaluate,command,click,set,until,check,handoffId,dir}){
  const key='aurora-workflow-form-draft';
  const workflowsBefore=(await app.workflows.list()).length,actionsBefore=(await app.store.list('actions')).length;
  const reload=async()=>{const before=await evaluate('performance.timeOrigin');await command('Page.reload');await until(()=>evaluate(`performance.timeOrigin!==${before}&&document.body.dataset.ready==="true"`),'draft page reload');await click('[data-view="workflows"]');};
  await click('[data-view="agents"]');
  await until(()=>evaluate('!!document.querySelector("#workflow-skill option[value=reviewed-task]")'),'saved skill available');
  await click('[data-view="workflows"]');
  await until(()=>evaluate('!document.querySelector("#workflows-view").hidden'),'workflow draft view');
  const selected=await evaluate('localStorage.getItem("aurora-workflow")');
  if(!await evaluate('document.querySelector("#workflow-compose").open'))await click('#workflow-compose > summary');
  await set('#workflow-goal','Recover a fresh workflow draft <script>window.draftXSS=true</script>');
  await set('#workflow-scope',dir);
  await set('#workflow-engine','chatgpt');
  await click('#workflow-requirements-fields [data-add-file]');
  await set('#workflow-requirements-fields [data-rule=file] [data-req=path]',dir+'/draft-output.txt');
  await set('#workflow-skill','reviewed-task');
  await evaluate('document.querySelector("#workflow-skill").dispatchEvent(new Event("change",{bubbles:true}))');
  await until(()=>evaluate('document.querySelectorAll("[data-skill-input]").length===2'),'draft skill inputs');
  const skillRevision=(await app.skills.read('reviewed-task')).revision;
  await until(()=>evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)})).data.skill.revision===${JSON.stringify(skillRevision)}`),'selected skill revision saved');
  await set('[data-skill-input=target_files]',dir+'/draft-output.txt');
  await set('[data-skill-input=content_requirements]','Keep exact current wording.');
  if(handoffId){await set('#workflow-handoff',handoffId);await evaluate('document.querySelector("#workflow-handoff").dispatchEvent(new Event("change",{bubbles:true}))');await until(()=>evaluate('document.querySelector("#workflow-handoff-preview").textContent.includes("Previous context only")'),'draft handoff source');}
  const projects=await app.projectWorkspaces.list();
  if(projects.length){await set('#workflow-project',projects[0].id);await evaluate('document.querySelector("#workflow-project").dispatchEvent(new Event("change",{bubbles:true}))');await until(()=>evaluate('document.querySelector("#workflow-project-preview").textContent.includes("Settings revision")'),'draft project source');if(await evaluate('!!document.querySelector("[data-project-check]")'))await evaluate('(()=>{const box=document.querySelector("[data-project-check]");box.checked=true;box.dispatchEvent(new Event("change",{bubbles:true}));})()');}
  const saved=JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify(key)})`));
  assert.equal(saved.version,1);assert.match(saved.data.goal,/Recover a fresh workflow draft/);assert.equal(saved.data.engine,'chatgpt');assert.equal(saved.data.requirements.files.length,1);assert.equal(saved.data.skill.id,'reviewed-task');
  assert.equal((await app.workflows.list()).length,workflowsBefore);assert.equal((await app.store.list('actions')).length,actionsBefore);
  await reload();
  await until(()=>evaluate('document.querySelector("#workflow-draft-status").textContent.includes("recovered")'),'workflow draft recovered');
  assert.equal(await evaluate('document.querySelector("#workflow-compose").open'),true);
  assert.match(await evaluate('document.querySelector("#workflow-goal").value'),/Recover a fresh workflow draft/);
  assert.equal(await evaluate('document.querySelector("#workflow-scope").value'),dir);
  assert.equal(await evaluate('document.querySelector("#workflow-engine").value'),'chatgpt');
  assert.equal(await evaluate('document.querySelector("#workflow-skill").value'),'reviewed-task');
  assert.equal(await evaluate('document.querySelector("[data-skill-input=content_requirements]").value'),'Keep exact current wording.');
  assert.equal(await evaluate('document.querySelector("#workflow-requirements-fields [data-rule=file] [data-req=path]").value'),dir+'/draft-output.txt');
  if(handoffId)assert.equal(await evaluate('document.querySelector("#workflow-handoff").value'),handoffId);
  if(projects.length)assert.equal(await evaluate('document.querySelector("#workflow-project").value'),projects[0].id);
  if(saved.data.project.checks.length)assert.equal(await evaluate('document.querySelectorAll("[data-project-check]:checked").length'),saved.data.project.checks.length);
  assert.equal(await evaluate('localStorage.getItem("aurora-workflow")'),selected);
  assert.equal(await evaluate('window.draftXSS'),undefined);
  assert.equal((await app.workflows.list()).length,workflowsBefore);assert.equal((await app.store.list('actions')).length,actionsBefore);
  check('full reload recovers goal, route, checks and current source selections without creating work or approval');

  const stale=structuredClone(saved);stale.data.skill.revision='older-skill-revision';
  if(stale.data.project.id)stale.data.project.revision='older-project-revision';
  if(stale.data.handoff.id)stale.data.handoff.revision='older-handoff-revision';
  await evaluate(`localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify(stale))})`);
  await reload();
  await until(()=>evaluate('document.querySelector("#workflow-draft-status").textContent.includes("skill revision")'),'changed source warning');
  assert.equal(JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify(key)})`)).data.skill.revision,'older-skill-revision');
  await submitBlocked();
  await click('#workflow-draft-use-current');
  await until(()=>evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)})).data.skill.revision!=="older-skill-revision"`),'fresh source choice saved');
  check('changed skill, project and handoff revisions require explicit use of current sources before planning');

  const other={...saved,data:{...saved.data,goal:'Other window draft'}};
  await evaluate(`localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify(other))})`);
  await set('#workflow-goal','This window edit');
  assert.match(await evaluate('document.querySelector("#workflow-draft-status").textContent'),/another window/);
  assert.equal(JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify(key)})`)).data.goal,'Other window draft');
  await submitBlocked();
  await click('#workflow-draft-reload');
  await until(()=>evaluate('document.querySelector("#workflow-goal").value==="Other window draft"&&document.querySelector("#workflow-draft-status").textContent.includes("recovered")&&!document.querySelector("#workflow-form").inert'),'other window draft reloaded');
  check('another-window draft blocks overwrite and task start until the user reloads it');

  await evaluate(`localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify(saved))})`);
  await set('#workflow-goal','Reviewed replacement wording');
  await until(()=>evaluate('document.querySelector("#workflow-draft-status").textContent.includes("another window")'),'second draft conflict');
  await click('#workflow-draft-use-current');
  await until(()=>evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)})).data.goal==="Reviewed replacement wording"`),'reviewed draft replacement').catch(async error=>{const detail=await evaluate(`(()=>({goal:document.querySelector("#workflow-goal").value,status:document.querySelector("#workflow-draft-status").textContent,saved:localStorage.getItem(${JSON.stringify(key)}),controlHidden:document.querySelector("#workflow-draft-use-current").hidden}))()`);throw Error(error.message+' '+JSON.stringify(detail).slice(0,700));});
  check('explicit keep-current choice replaces only the changed local draft');

  await evaluate(`localStorage.setItem(${JSON.stringify(key)},'{broken')`);
  await reload();
  await until(()=>evaluate('document.querySelector("#workflow-draft-status").textContent.includes("could not be read")'),'unreadable draft warning');
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(key)})`),'{broken');
  await set('#workflow-goal','Do not overwrite the unreadable draft');
  await submitBlocked();
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(key)})`),'{broken');
  await click('#workflow-draft-discard');
  await until(()=>evaluate(`localStorage.getItem(${JSON.stringify(key)})===null`),'reviewed draft discard');
  check('unreadable draft stays intact until reviewed discard and cannot silently start work');

  const damaged={...saved,data:{...saved.data,skill:'unreadable source selection'}};
  await evaluate(`localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify(damaged))})`);
  await reload();
  await until(()=>evaluate('document.querySelector("#workflow-draft-status").textContent.includes("could not be read")'),'damaged source draft warning');
  assert.equal(JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify(key)})`)).data.skill,'unreadable source selection');
  await click('#workflow-draft-discard');
  await until(()=>evaluate(`localStorage.getItem(${JSON.stringify(key)})===null`),'damaged source draft discard');
  check('valid JSON with damaged source choices remains recoverable until reviewed discard');

  await evaluate(`(()=>{const original=Storage.prototype.setItem;window.fixtureSetItem=original;Storage.prototype.setItem=function(k,v){if(k===${JSON.stringify(key)})throw new DOMException('Full','QuotaExceededError');return original.call(this,k,v);};})()`);
  await set('#workflow-goal','Storage unavailable wording');
  assert.match(await evaluate('document.querySelector("#workflow-draft-status").textContent'),/storage is unavailable/);
  assert.equal(await evaluate('document.querySelector("#workflow-goal").value'),'Storage unavailable wording');
  await evaluate('Storage.prototype.setItem=window.fixtureSetItem');
  await set('#workflow-goal','Storage recovered wording');
  assert.equal(JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify(key)})`)).data.goal,'Storage recovered wording');
  await click('#workflow-draft-discard');
  await until(()=>evaluate(`localStorage.getItem(${JSON.stringify(key)})===null`),'final draft discard');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#workflow-draft-controls")).display'),'none');
  assert.equal((await app.workflows.list()).length,workflowsBefore);assert.equal((await app.store.list('actions')).length,actionsBefore);
  check('local storage failure keeps visible wording and recovery can save a later edit without task effects');

  async function submitBlocked(){await evaluate('document.querySelector("#workflow-engine").value="local"');await evaluate('document.querySelector("#workflow-form").requestSubmit()');await until(()=>evaluate('document.querySelector("#toast").textContent.includes("Resolve the saved workflow draft")'),'blocked workflow start');assert.equal((await app.workflows.list()).length,workflowsBefore);}
}
