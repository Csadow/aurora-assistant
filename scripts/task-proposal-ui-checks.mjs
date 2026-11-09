import assert from 'node:assert/strict';
export async function taskProposalUIChecks({app,evaluate,until,check}){
  await app.vault.addTask('Conversation <img src=x onerror=window.taskXSS=true>',{planDate:'2026-10-18',startTime:'10:00',due:'2026-10-20'});
  const task=(await app.vault.tasks()).find(t=>t.text.startsWith('Conversation <'));
  await app.vault.addTask('Sunday conflict',{planDate:'2026-10-18',startTime:'11:00'});
  const current=(await app.vault.tasks()).find(t=>t.id===task.id);
  const p=await app.assistant.runTool({function:{name:'propose_task_update',arguments:{...current,changes:{startTime:'11:00'}}}});
  await until(()=>evaluate('!!document.querySelector("[data-view=inbox]")'),'review navigation');
  await evaluate('document.querySelector("[data-view=inbox]").click()');
  const root=`document.querySelector('[data-task-review="${p.id}"]')`;
  await until(()=>evaluate(`!!${root}`),'task review loaded');
  assert(await evaluate(`${root}.textContent.includes('10:00')&&${root}.textContent.includes('11:00')&&${root}.textContent.includes('2026-10-20')`));
  assert.equal(await evaluate('window.taskXSS'),undefined);
  await evaluate(`${root}.querySelector('[data-action=accept]').click()`);
  await until(()=>evaluate(`!${root}.querySelector('[data-action=accept]').disabled`),'overlap rejected');
  assert.equal((await app.vault.tasks()).find(t=>t.id===task.id).startTime,'10:00');check('chat task review shows before/after and rejects unacknowledged overlaps');
  await evaluate(`${root}.querySelector('input').click();${root}.querySelector('[data-action=accept]').click()`);
  await until(async()=>(await app.store.get('proposals',p.id)).status==='accepted','task saved');
  assert.equal((await app.vault.tasks()).find(t=>t.id===task.id).startTime,'11:00');
  await until(()=>evaluate(`!${root}`),'review removed');check('explicitly accepted task update saves once, escapes titles and leaves the inbox');
}
