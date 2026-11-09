import assert from 'node:assert/strict';
export async function taskHistoryUIChecks({app,evaluate,until,check}){
 await app.vault.addTask('History <img src=x onerror=window.historyXSS=true>');const task=(await app.vault.tasks()).find(t=>t.text.startsWith('History <'));await app.vault.toggleTask(task.path,task.line,task.revision,true);
 await evaluate('document.querySelector("[data-view=overview]").click();document.querySelector("#day-history").click()');
 await until(()=>evaluate('document.querySelector("#day-planning-dialog").open&&document.querySelector("#day-planning-body").textContent.includes("Task history")'),'history loaded');
 assert(await evaluate('document.querySelector("#day-planning-body").textContent.includes("Marked complete")'));assert(await evaluate('document.querySelector("#day-planning-body").textContent.includes("Saved through Aurora")'));assert(await evaluate('document.querySelector("#day-planning-body").textContent.includes("starting baseline")||document.querySelector("#day-planning-body").textContent.includes("a baseline")'));assert.equal(await evaluate('window.historyXSS'),undefined);check('task history shows saved changes, escapes task text and explains incomplete history');
 const read=()=>evaluate('(async()=>await(await fetch("/api/task-history")).json())()');const first=await read(),second=await read();assert.equal(second.total,first.total);const events=second.events.filter(e=>e.taskId===task.id);assert.equal(events.filter(e=>e.kinds.includes('marked_complete')).length,1);check('refreshing task history never repeats a recorded completion');
 await evaluate('document.querySelector("#day-planning-close").click()');
}
