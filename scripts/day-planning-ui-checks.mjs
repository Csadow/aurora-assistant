import assert from 'node:assert/strict';
export async function dayPlanningUIChecks({app,evaluate,until,check}){
 const key='aurora-remainder-draft:'+app.vault.root,saved=await evaluate('localStorage.getItem('+JSON.stringify(key)+')');await evaluate('localStorage.removeItem('+JSON.stringify(key)+')');try{
 assert.equal(await evaluate('document.querySelector("#morning-briefing").parentElement.tagName'),'MAIN');
 await evaluate(`window.__briefingFetch=window.fetch;window.__briefingWarnings=['Critical planning source unavailable <img src=x>',...Array.from({length:7},(_,i)=>'2105-06-'+String(i+1).padStart(2,'0')+': Google Calendar coverage is incomplete. Refresh to check availability.')];window.fetch=async(...args)=>{const response=await window.__briefingFetch(...args);if(new URL(args[0],location.href).pathname!=='/api/briefing'||!response.ok)return response;const data=await response.json();data.warnings=window.__briefingWarnings;return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});};void 0`);
 await evaluate('document.querySelector("[data-view=overview]").click()');
 await evaluate('document.querySelector("#day-briefing").click()');
 await until(()=>evaluate('document.querySelector("#day-planning-dialog").open&&document.querySelector("#day-planning-body").textContent.includes("Today’s schedule")'),'briefing loaded');
 assert(await evaluate(`(()=>{const body=document.querySelector('#day-planning-body'),group=body.querySelector('#briefing-calendar-coverage');return !!group&&!group.open&&group.querySelectorAll('p').length===7&&group.querySelector('summary').textContent.includes('7 dates (2105-06-01–2105-06-07)')&&[...body.querySelectorAll(':scope > p.planner-warning')].some(p=>p.textContent.includes('Critical planning source unavailable'))&&!body.querySelector('img')&&!body.querySelector('#briefing-details').textContent.includes('Google Calendar coverage is incomplete')})()`));check('daily briefing groups repeated Calendar dates once while other warnings stay visible and escaped');
 await evaluate(`window.__briefingWarnings=['2105-06-01: Google Calendar coverage is incomplete. Refresh to check availability.'];document.querySelector('#day-planning-briefing').click();void 0`);
 await until(()=>evaluate(`!document.querySelector('#briefing-calendar-coverage')&&[...document.querySelectorAll('#day-planning-body > p.planner-warning')].some(p=>p.textContent.includes('2105-06-01: Google Calendar coverage is incomplete'))`),'one-off Calendar warning');
 check('one dated Calendar warning remains inline in the daily briefing');
 await evaluate('window.fetch=window.__briefingFetch;delete window.__briefingFetch;delete window.__briefingWarnings;void 0');
 assert(await evaluate('document.querySelector("#day-planning-body").textContent.includes("Overdue deadlines")'));check('daily briefing shows schedule and deadlines without model inference');
 await evaluate('document.querySelector("#day-planning-close").click();document.querySelector("#morning-dismiss").click()');
 const b=await evaluate('(async()=>await(await fetch("/api/bootstrap")).json())()');
 assert.equal(await evaluate('localStorage.getItem('+JSON.stringify('aurora-briefing-seen:'+b.vault)+')'),await evaluate('document.querySelector("#morning-briefing").dataset.date'));check('daily briefing dismissal persists for this vault and day');
 const data=await evaluate('(async()=>await(await fetch("/api/replan")).json())()');
 await app.vault.addTask('Replan <img src=x onerror=window.replanXSS=true>',{planDate:data.date,startTime:'00:00',duration:5});
 const before=await app.vault.tasks(),task=before.find(t=>t.text.startsWith('Replan <'));
 await evaluate('document.querySelector("#day-replan").click()');
 await until(()=>evaluate('!!document.querySelector("#replan-preview")&&!document.querySelector("#day-planning-dialog").hasAttribute("aria-busy")&&!document.querySelector("#day-planning-body").inert'),'interactive replan selection');
 // Other fixtures can have tasks on today's real date. Keep their saved plans intact.
 await evaluate(`for(const el of document.querySelectorAll('[data-replan-task]')){el.checked=el.dataset.replanTask===${JSON.stringify(task.id)};el.dispatchEvent(new Event('change',{bubbles:true}));}document.querySelector('#replan-end').value='23:59';document.querySelector('#replan-preview').click()`);
 await until(()=>evaluate('!!document.querySelector("#replan-accept")'),'replan preview');
 assert.deepEqual(await app.vault.tasks(),before);assert.equal(await evaluate('window.replanXSS'),undefined);check('replan preview is inert and escapes titles');
 await evaluate('document.querySelector("#replan-accept").click()');
 await until(()=>evaluate('!document.querySelector("#day-planning-dialog").open'),'replan saved');
 const saved=(await app.store.list('proposals')).find(p=>p.kind==='day_replan'&&p.status==='accepted'&&p.changes.some(c=>c.before.id===task.id));assert(saved);assert.deepEqual(saved.changes.map(c=>c.before.id),[task.id]);
 const unchanged=tasks=>tasks.filter(t=>t.id!==task.id).map(({revision,...t})=>t);assert.deepEqual(unchanged(await app.vault.tasks()),unchanged(before));check('reviewed day replan saves only its selected task through the desktop API');
 }finally{await evaluate('if(window.__briefingFetch){window.fetch=window.__briefingFetch;delete window.__briefingFetch;delete window.__briefingWarnings;}void 0');await evaluate(saved===null?'localStorage.removeItem('+JSON.stringify(key)+')':'localStorage.setItem('+JSON.stringify(key)+','+JSON.stringify(saved)+')');}
}
