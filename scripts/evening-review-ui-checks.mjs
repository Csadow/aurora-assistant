import assert from 'node:assert/strict';
export async function eveningReviewUIChecks({app,evaluate,until,check}){
 const date=(await evaluate('(async()=>await(await fetch("/api/replan")).json())()')).date;
 await app.vault.addTask('Evening <img src=x onerror=window.eveningXSS=true>',{planDate:date,duration:30,due:date});
 const task=(await app.vault.tasks()).find(t=>t.text.startsWith('Evening <'));
 await evaluate('document.querySelector("[data-view=overview]").click();document.querySelector("#day-evening").click()');
 await until(()=>evaluate('!!document.querySelector("#evening-preview")'),'evening loaded');
 assert(await evaluate('document.querySelector("#day-planning-body").textContent.includes("Currently marked complete")'));
 assert.equal(await evaluate('window.eveningXSS'),undefined);
 const row=`[...document.querySelectorAll('[data-evening-row]')].find(r=>r.textContent.includes('Evening <'))`;
 assert.equal(await evaluate(`${row}.querySelector('[data-evening-action]').value`),'keep');
 await evaluate(`(()=>{const r=${row},s=r.querySelector('[data-evening-action]');s.value='move';s.dispatchEvent(new Event('change'));r.querySelector('[data-evening-text]').value='Read one small section';r.querySelector('[data-evening-duration]').value='10';document.querySelector('#evening-preview').click();})()`);
 await until(()=>evaluate('!!document.querySelector("#replan-accept")'),'evening preview');
 assert.equal((await app.vault.tasks()).find(t=>t.id===task.id).text,task.text);
 assert(await evaluate('document.querySelector("#day-planning-body").textContent.includes("Read one small section")'));check('evening review defaults to unchanged, escapes titles and previews explicit smaller carried-forward work');
 await evaluate('document.querySelector("#day-planning-close").click();document.querySelector("[data-view=inbox]").click()');
 const p=(await app.store.list('proposals')).find(p=>p.kind==='evening_review');
 await until(()=>evaluate(`!!document.querySelector('[data-day-review="${p.id}"]')`),'evening inbox');
 await evaluate(`document.querySelector('[data-day-review="${p.id}"]').click()`);
 await until(()=>evaluate('document.querySelector("#day-planning-dialog").open'),'evening reopened');
 await evaluate('document.querySelector("#replan-accept").click()');
 await until(async()=>(await app.store.get('proposals',p.id)).status==='accepted','evening saved');
 const saved=(await app.vault.tasks()).find(t=>t.id===task.id);assert.equal(saved.text,'Read one small section');assert.equal(saved.duration,10);assert(saved.planDate>date);assert.equal(saved.startTime,null);assert.equal(saved.due,date);assert.equal(saved.done,false);check('evening draft reopens from Review inbox and preserves deadline, identity and completion state');
 await until(()=>evaluate('!document.querySelector("#day-planning-dialog").open'),'evening closed');
}
