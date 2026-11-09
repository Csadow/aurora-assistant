import assert from 'node:assert/strict';
export async function plannerUIChecks({evaluate,until,check,root,open}){
  await evaluate(open);
  const q=JSON.stringify(root),r=`document.querySelector(${q})`;
  await until(()=>evaluate(`${r}&&!${r}.closest('section').hidden`),'planner visible');
  if(await evaluate(`!!document.querySelector('#day-refresh')`)){
    assert.equal(await evaluate(`${r}.querySelector('.planner-options').open`),false);
    assert(await evaluate(`/Plan [0-9]{4}-[0-9]{2}-[0-9]{2} · [0-9]{2}:[0-9]{2}–[0-9]{2}:[0-9]{2}/.test(${r}.querySelector('.planner-options > summary').textContent)`));
    assert.equal(await evaluate(`${r}.querySelector('h2').nextElementSibling.className`),'planner-capture');
    check('desktop planner keeps its hours available behind a compact dated summary');
    await evaluate(`(()=>{window.__statsFetch=window.fetch;window.__statsCounts={overdue:3,dueToday:2,open:47};window.fetch=async(...args)=>{const response=await window.__statsFetch(...args);if(String(args[0])!=='/api/overview')return response;const data=await response.json();data.counts={...data.counts,...window.__statsCounts};return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});};})()`);
    try{
      await evaluate(`document.querySelector('#day-refresh').onclick()`);
      await until(()=>evaluate(`!document.querySelector('#day-stats').hidden&&document.querySelector('#day-stats').textContent.includes('3 overdue')`),'urgent day counts');
      assert.equal(await evaluate(`document.querySelector('#day-stats').children.length`),2);
      assert.equal(await evaluate(`document.querySelector('#day-stats').textContent.includes('47 open')`),false);
      check('Your day shows only urgent counts above the planner');
      await evaluate(`window.__statsCounts={overdue:0,dueToday:0,open:47};document.querySelector('#day-refresh').onclick()`);
      await until(()=>evaluate(`document.querySelector('#day-stats').hidden&&getComputedStyle(document.querySelector('#day-stats')).display==='none'`),'quiet day counts');
      assert(await evaluate(`!!document.querySelector('#planner-execution')&&!!document.querySelector('#planner-attention')`));
      check('the count strip disappears on a quiet day without removing task panels');
    }finally{await evaluate(`window.fetch=window.__statsFetch;delete window.__statsFetch;delete window.__statsCounts;document.querySelector('#day-refresh').onclick()`);}
  }
  await evaluate(`${r}.querySelector('.planner-options').open=true`);
  const idle=()=>until(()=>evaluate(`!${r}.hasAttribute('aria-busy')`),'planner saved');
  const set=async(label,value)=>evaluate(`(()=>{const n=${r}.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const click=async text=>{await evaluate(`[...${r}.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);await idle();};
  const title='Planner fixture <img src=x onerror=window.plannerXSS=true>';
  await set('Planner new task',title);await evaluate(`${r}.querySelector('.planner-capture').requestSubmit()`);await idle();await until(()=>evaluate(`${r}.textContent.includes(${JSON.stringify(title)})`),'task capture');check('planner captures a Markdown task with inert HTML text');
  await evaluate(`[...[...${r}.querySelectorAll('.planner-task')].find(n=>n.querySelector('strong').textContent===${JSON.stringify(title)}).querySelectorAll('button')].find(b=>b.textContent==='Edit / schedule').click()`);await idle();
  await set('Duration (minutes)','45');await set('Task priority','high');await set('Due date','2090-10-20');await click('Save task');
  await set('Planner new task','Planner second task');await evaluate(`${r}.querySelector('.planner-capture').requestSubmit()`);await idle();
  await set('Plan date','2090-10-20');await idle();await set('Day starts','09:00');await idle();await set('Day ends','18:00');await idle();await click('Suggest schedule');
  if(await evaluate(`!!document.querySelector('#day-refresh')`)){assert(await evaluate(`${r}.querySelector('.planner-options > summary').textContent.includes('2090-10-20 · 09:00–18:00')`));check('planner summary keeps the selected date and hours readable after edits');}
  assert(await evaluate(`${r}.textContent.includes('Suggested schedule · not saved')`));check('planner previews a schedule without saving it');
  if(await evaluate(`!!document.querySelector('#day-refresh')`)){
    await evaluate(`${r}.querySelector('[aria-label="Day starts"]').value='08:15'`);
    await evaluate(`document.querySelector('#day-refresh').onclick()`);
    assert(await evaluate(`${r}.textContent.includes('Suggested schedule · not saved')`));assert.equal(await evaluate(`${r}.querySelector('[aria-label="Day starts"]').value`),'08:15');
    await evaluate(`${r}.querySelector('[aria-label="Day starts"]').value='09:00'`);check('desktop background refresh preserves schedule suggestions and hours being edited');
  }
  await click('Save suggested schedule');assert(await evaluate(`${r}.querySelector('.planner-message').textContent.includes('task blocks')`));assert(await evaluate(`${r}.textContent.includes('Planned 2090-10-20 at')`));assert.equal(await evaluate('window.plannerXSS'),undefined);check('reviewed schedule saves multiple tasks from the same Markdown note');
  await click('Refresh tasks');assert(await evaluate(`${r}.textContent.includes('Planned 2090-10-20 at')`));check('saved planner blocks reload from durable storage');
  await evaluate(`[...${r}.querySelectorAll('.planner-task')].find(n=>n.querySelector('strong').textContent===${JSON.stringify(title)}).querySelector('button').click()`);await idle();await set('Planner task filter','done');
  assert(await evaluate(`${r}.textContent.includes(${JSON.stringify(title)})`));check('completed planner tasks remain available in history');
  await set('Planner task filter','open');
  await click('Add weekly class');await set('Class name','Weekly class fixture');await set('Class room','Room 202');await set('Class weekday',String(new Date('2090-10-21T12:00:00Z').getUTCDay()));await set('Class starts','09:00');await set('Class ends','10:00');await click('Save weekly class');
  await set('Plan date','2090-10-21');await idle();assert(await evaluate(`${r}.textContent.includes('09:00–10:00 · Weekly class fixture')`));check('weekly classes save separately and appear on their weekday');
  await click('Travel and trimester settings');await set('Travel before first class (minutes)','15');await set('Travel after last class (minutes)','20');await click('Save timetable settings');
  await set('Planner new task','Fit around classes');await evaluate(`${r}.querySelector('.planner-capture').requestSubmit()`);await idle();await click('Suggest schedule');
  assert(await evaluate(`${r}.textContent.includes('10:30 · Fit around classes')`));check('schedule suggestions leave room for classes, travel and breaks');
  await click('Save suggested schedule');assert(await evaluate(`${r}.textContent.includes('Planned 2090-10-21 at 10:30')`));
  await click('Refresh tasks');assert(await evaluate(`${r}.textContent.includes('Travel: 15 min before first class, 20 min after last.')`));check('weekly timetable and travel settings reload from Markdown');
  await click('Travel and trimester settings');await set('Trimester ends','2090-10-20');await click('Save timetable settings');
  assert.equal(await evaluate(`${r}.querySelectorAll('.planner-class[data-start]').length`),0);check('classes stop recurring after the configured trimester end');
}
