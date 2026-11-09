import assert from 'node:assert/strict';
import {TIMETABLE_PATH,readTimetable} from '../mobile/web/timetable.js';
import {RECURRING_PATH} from '../src/recurring-tasks.mjs';
export async function planningSettingsUIChecks({app,evaluate,until,check,screenshot}){
 let original=null;try{original=await app.vault.read(TIMETABLE_PATH);}catch(e){if(e.status!==404)throw e;}
 const click=text=>evaluate(`[...document.querySelectorAll('#planning-settings-dialog button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
 const idle=()=>until(()=>evaluate(`document.querySelector('#planning-settings-dialog [role=status]').textContent==='Saved.'&&!document.querySelector('#planning-settings-dialog').hasAttribute('aria-busy')`),'planning settings saved');
 await evaluate(`document.querySelector('[data-view=overview]').click();document.querySelector('#day-planning-settings').click()`);
 await until(()=>evaluate(`!!document.querySelector('[aria-label="Monday windows"]')`),'planning settings loaded');
 await evaluate(`(()=>{const q=s=>document.querySelector('[aria-label="'+s+'"]');q('Use weekly availability').checked=true;q('Monday windows').value='09:00-12:00, 14:00-21:00';})()`);await click('Save availability');await idle();
 let cal=readTimetable(await app.vault.read(TIMETABLE_PATH));assert.deepEqual(cal.availability.days[1],[['09:00','12:00'],['14:00','21:00']]);assert.deepEqual(cal.availability.days[6],[]);check('desktop settings persist split weekday windows and explicit days off');if(screenshot)await screenshot('desktop-planning-settings.png');
 const before=(await app.vault.read(TIMETABLE_PATH)).revision;
 await evaluate(`document.querySelector('[aria-label="Monday windows"]').value='12:00-09:00'`);await click('Save availability');await until(()=>evaluate(`document.querySelector('#planning-settings-dialog [role=status]').textContent.includes('end after')`),'invalid window message');assert.equal((await app.vault.read(TIMETABLE_PATH)).revision,before);check('invalid availability reports an error without replacing saved settings');
 await click('Close settings');await evaluate(`document.querySelector('#day-planning-settings').click()`);await until(()=>evaluate(`!!document.querySelector('[aria-label="Original class date"]')`),'settings reopened');
 await click('Save exception');await idle();cal=readTimetable(await app.vault.read(TIMETABLE_PATH));assert.equal(cal.exceptions.at(-1).kind,'holiday');check('one-off no-class date saves without changing weekly classes');
 await evaluate(`(()=>{document.querySelector('[aria-label="Recurring task title"]').value='Practice <img src=x onerror=window.repeatXSS=true>';for(const i of document.querySelectorAll('[aria-label^="Repeat on "]'))i.checked=true;})()`);await click('Create recurring task');await idle();
 let state=await app.recurring.report();assert.equal(state.rules.length,1);let tasks=(await app.vault.tasks()).filter(t=>t.path===RECURRING_PATH);assert.equal(tasks.length,14);assert(tasks.every(t=>!t.scheduleError));assert.equal(await evaluate('window.repeatXSS'),undefined);check('recurring form creates fourteen valid independent tasks and renders title as text');if(screenshot){await evaluate(`document.querySelector('.recurring-rule').scrollIntoView({block:'center'})`);await screenshot('desktop-recurring-tasks.png');}
 await click('Pause series');await idle();assert((await app.recurring.report()).rules[0].paused);
 await click('Resume series');await idle();assert.equal((await app.vault.tasks()).filter(t=>t.path===RECURRING_PATH).length,14);
 await click('Skip occurrence');await idle();assert.equal((await app.vault.tasks()).filter(t=>t.path===RECURRING_PATH).length,13);check('pause, resume and skip controls preserve siblings without duplicate occurrences');
 await click('Set series end');await idle();state=await app.recurring.report();assert.equal(state.rules[0].until,state.today);check('series end is saved explicitly and keeps existing occurrences');
 await click('Close settings');
 await evaluate(`(()=>{const i=document.querySelector('[aria-label="Plan date"]');i.value='2026-10-12';i.dispatchEvent(new Event('change'));})()`);
 await until(()=>evaluate(`document.querySelector('[aria-label="Day ends"]').value==='21:00'`),'saved evening hours');check('weekday availability fills daily planner hours beyond the former 18:00 default');
 const n=await app.vault.read(TIMETABLE_PATH);if(original)await app.vault.save(TIMETABLE_PATH,original.content,n.revision);else await app.vault.trash(TIMETABLE_PATH,n.revision);
 const r=await app.vault.read(RECURRING_PATH);await app.vault.trash(RECURRING_PATH,r.revision);
}
