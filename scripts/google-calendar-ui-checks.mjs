import assert from 'node:assert/strict';
import {googleFixture} from '../tests/fixtures/google-calendar.mjs';
import {eventBody,dateParts} from '../src/calendar-time.mjs';
export async function googleCalendarUIChecks({backend,evaluate,wait,check,screenshot}){
 const calendar=backend.calendar,original={state:structuredClone(calendar.state),auth:structuredClone(calendar.oauth.value),fetch:calendar.oauth.fetch};
 let note=null;try{note=await backend.vault.read('40 Tasks/Tasks.md');}catch(e){if(e.status!==404)throw e;}
 const google=googleFixture(),date=dateParts(Date.now()+86400000).date;
 const click=text=>evaluate(`[...document.querySelectorAll('#google-calendar-dialog button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
 const idle=()=>wait(()=>evaluate(`!document.querySelector('#google-calendar-dialog').hasAttribute('aria-busy')`),'calendar dialog ready');
 const choice=direction=>evaluate(`(()=>{const s=document.querySelector('#google-calendar-dialog .calendar-change select');s.value=${JSON.stringify(direction)};s.dispatchEvent(new Event('change'));})()`);
 try{
  await evaluate(`document.querySelector('[data-view=overview]').click();document.querySelector('#day-google-calendar').click()`);await idle();
  assert(await evaluate(`!!document.querySelector('[aria-label="Google Desktop client JSON"]')`));check('Google Calendar opens in the native planner with one-time desktop OAuth setup');
  calendar.oauth.fetch=google.fetchImpl;calendar.oauth.value={client:{client_id:'fixture.apps.googleusercontent.com',client_secret:'secret'},tokens:{access_token:'test-token',refresh_token:'refresh',expiresAt:Date.now()+3600000}};
  const event=google.put(eventBody({title:'Appointment <img src=x onerror=window.calendarXSS=true>',date,time:'15:00',duration:60}));
  await backend.vault.addTask('Calendar UI task',{planDate:date,startTime:'11:00',duration:30});const task=(await backend.vault.tasks()).find(t=>t.text==='Calendar UI task');
  await click('Refresh connection');await idle();assert.equal(await evaluate('window.calendarXSS'),undefined);assert((await evaluate(`document.querySelector('#google-calendar-dialog').textContent`)).includes('Appointment <img'));check('Google events render as text and calendar credentials are absent from the UI');
  const openTask=async id=>{await wait(()=>evaluate(`!document.querySelector('#daily-planner').hasAttribute('aria-busy')`),'planner ready for calendar link');await evaluate(`[...document.querySelectorAll('#daily-planner [data-task-id="${id}"] button')].find(b=>/^(Link Google Calendar|Review calendar sync)$/.test(b.textContent)).click()`);};
  // Earlier native fixtures can leave a saved search and an old plan date in this test profile.
  await evaluate(`(()=>{const input=document.querySelector('#daily-planner [aria-label="Plan date"]');input.value=${JSON.stringify(date)};input.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#planner-task-list .task-list-controls button').click();})()`);
  await wait(()=>evaluate(`!document.querySelector('#daily-planner').hasAttribute('aria-busy')&&!![...document.querySelectorAll('#daily-planner [data-task-id="${task.id}"] button')].find(b=>/^(Link Google Calendar|Review calendar sync)$/.test(b.textContent))`),'calendar task row after selecting its date');
  await click('Close calendar');await openTask(task.id);await idle();assert.equal(calendar.state.review.items.length,1);assert.equal(calendar.state.review.items[0].link.taskId,task.id);assert.equal(google.writes().length,0);check('planner task linking opens a focused review without writing to Google');
  await click('Apply reviewed changes');await idle();assert.match(await evaluate(`document.querySelector('#google-calendar-dialog [role=status]').textContent`),/Choose at least one/);assert.equal(google.writes().length,0);check('sync previews and unselected review rows cannot write to Google');
  await choice('aurora');await evaluate(`document.querySelector('#day-refresh').onclick()`);assert.equal(await evaluate(`document.querySelector('.calendar-change select').value`),'aurora');check('planner refresh preserves open sync review choices');
  await click('Apply reviewed changes');await idle();assert.equal(google.events.size,2);check('explicit reviewed task export creates one Google event');
  const linked=calendar.state.links.find(l=>l.taskId===task.id);let current=(await backend.vault.tasks()).find(t=>t.id===task.id);await backend.vault.scheduleTask({...current,text:'Aurora edit'});google.put({...google.events.get(linked.eventId),summary:'Google edit'},linked.eventId);
  await calendar.refresh();await evaluate(`document.querySelector('#day-refresh').onclick()`);assert.match(await evaluate(`document.querySelector('#day-calendar-status').textContent`),/1 pending change.*1 conflict/);assert.match(await evaluate(`document.querySelector('#day-google-calendar').textContent`),/1 pending/);check('day summary and planner rows expose pending calendar conflicts');
  await click('Close calendar');await openTask(task.id);await idle();await wait(()=>evaluate(`document.querySelector('.calendar-review')?.textContent.includes('Both copies changed')`),'calendar conflict review ready');assert.match(await evaluate(`document.querySelector('.calendar-review').textContent`),/Both copies changed/);assert.equal(await evaluate(`document.querySelector('.calendar-change select').value`),'skip');
  const reviewId=calendar.state.review.id;await click('Close calendar');await openTask(task.id);await idle();assert.equal(calendar.state.review.id,reviewId);assert.match(await evaluate(`document.querySelector('#google-calendar-dialog [role=status]').textContent`),/saved review is still open/);check('opening a planner link preserves an existing unfinished review');
  if(screenshot)await screenshot('desktop-google-calendar-review.png');
  await choice('google');await click('Apply reviewed changes');await idle();current=(await backend.vault.tasks()).find(t=>t.id===task.id);assert.equal(current.text,'Google edit');check('conflicts show both copies and apply the explicitly chosen direction');
  google.events.delete(linked.eventId);await click('Preview two-way sync');await idle();assert(await evaluate(`document.querySelector('.calendar-review').textContent.includes('Remove Aurora block (keep task)')`));await choice('google');await click('Apply reviewed changes');await idle();current=(await backend.vault.tasks()).find(t=>t.id===task.id);assert.equal(current.planDate,null);assert.equal(current.done,false);check('reviewed Google deletion clears the schedule while preserving the Aurora to-do');
  await click('Refresh connection');await idle();await evaluate(`document.querySelector('[aria-label^="Import event Appointment"]').checked=true`);await evaluate(`document.querySelector('#day-refresh').onclick()`);assert(await evaluate(`document.querySelector('[aria-label^="Import event Appointment"]').checked`));check('background planner refresh keeps selected calendar import checkboxes');
  await click('Preview two-way sync');await idle();await click('Discard review');await idle();assert.equal((await backend.vault.tasks()).some(t=>t.text.startsWith('Appointment <img')),false);assert(google.events.has(event.id));check('discarding an import review leaves Google events and Markdown tasks unchanged');
  await click('Close calendar');current=(await backend.vault.tasks()).find(t=>t.id===task.id);await backend.vault.scheduleTask({...current,planDate:date,startTime:'11:00'});await evaluate(`document.querySelector('#day-refresh').onclick()`);
  current=(await backend.vault.tasks()).find(t=>t.id===task.id);await backend.vault.scheduleTask({...current,text:'Changed after rendering'});const writes=google.writes().length;await openTask(task.id);await idle();assert.match(await evaluate(`document.querySelector('#google-calendar-dialog [role=status]').textContent`),/planner task changed/);assert.equal(google.writes().length,writes);assert.equal(calendar.state.review,null);check('a stale planner link cannot prepare or apply an export');
  google.state.offline=true;await click('Refresh connection');await idle();assert.match(await evaluate(`document.querySelector('#google-calendar-dialog [role=status]').textContent`),/could not be reached/);assert((await calendar.context()).warnings.length);check('offline refresh preserves the downloaded calendar and exposes stale availability');
  await evaluate(`document.querySelector('#day-refresh').onclick()`);assert.match(await evaluate(`document.querySelector('#day-calendar-status').textContent`),/needs refresh/);check('failed refresh marks the persistent calendar status as stale');
  await click('Close calendar');
  const race=await evaluate(`(async()=>{
   const {mountGoogleCalendar}=await import('/google-calendar.js'),host=document.createElement('div');document.body.append(host);
   const pending=[],reads=[];const ui=mountGoogleCalendar(host,{api:path=>new Promise(resolve=>(path.endsWith('/summary')?pending:reads).push(resolve)),refresh:async()=>{}});
   const panel=[...document.querySelectorAll('#google-calendar-dialog')].at(-1),summary=host.nextElementSibling;
   const status=n=>({connected:true,fresh:true,lastChecked:Date.now(),counts:{pending:n,conflict:0,blocked:0,unknown:0},links:[],review:null});
   try{
    const a=ui.check(),b=ui.check();pending[1](status(2));await b;pending[0](status(0));await a;
    const latest=host.querySelector('button').textContent.includes('2 pending');
    host.querySelector('button').click();panel.close();reads[0]({sync:status(0)});
    await new Promise(resolve=>setTimeout(resolve,0));
    return {latest,closed:!panel.open,empty:!panel.querySelector('.calendar-review').children.length};
   }finally{panel.remove();summary.remove();host.remove();}
  })()`);
  assert.deepEqual(race,{latest:true,closed:true,empty:true});check('late calendar status responses cannot replace newer counts or reopen a closed review');
 }finally{
  await evaluate(`document.querySelector('#google-calendar-dialog').close()`);
  const current=await backend.vault.read('40 Tasks/Tasks.md');if(note)await backend.vault.save(current.path,note.content,current.revision);else await backend.vault.trash(current.path,current.revision);
  calendar.state=original.state;calendar.oauth.value=original.auth;calendar.oauth.fetch=original.fetch;await calendar.save();await calendar.oauth.save();
 }
}
