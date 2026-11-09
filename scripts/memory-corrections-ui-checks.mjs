import assert from 'node:assert/strict';
export async function memoryCorrectionsUIChecks({app,evaluate,until,check,screenshot}){
 const path='30 Knowledge/Correction UI fixture.md',before='The meeting is Thursday.',after='The meeting is Friday. <img src=x onerror=window.correctionXSS=true>';
 const note=await app.vault.save(path,'# Correction UI fixture\n\n'+before+'\n\nUnrelated detail.',null);
 await evaluate(`document.querySelector('[data-view=review]').click();document.querySelector('#memory-correct').click()`);
 await until(()=>evaluate(`!!document.querySelector('#correction-note')`),'correction note picker');
 await evaluate(`(()=>{const s=document.querySelector('#correction-note');s.value=${JSON.stringify(path)};s.dispatchEvent(new Event('change'));})()`);
 await until(()=>evaluate(`document.querySelector('#correction-current').textContent.includes('The meeting is Thursday.')&&!document.querySelector('#correction-draft').disabled`),'correction source loaded');
 await evaluate(`document.querySelector('#correction-before').value=${JSON.stringify(before)};document.querySelector('#correction-after').value=${JSON.stringify(after)};document.querySelector('#correction-reason').value='User updated the meeting';document.querySelector('#correction-draft').click()`);
 await until(()=>evaluate(`!document.querySelector('#memory-correction-dialog').open&&!document.querySelector('#inbox-view').hidden&&document.querySelector('#proposal-list').textContent.includes('Correct Correction UI fixture')`),'correction review inbox');
 assert.equal((await app.vault.read(path)).revision,note.revision);assert.equal(await evaluate('!!window.correctionXSS'),false);check('memory correction shows escaped before/after review without changing the note');
 const p=(await app.store.list('proposals')).find(p=>p.kind==='memory_correction'&&p.path===path);
 if(screenshot)await screenshot('memory-correction-review');
 await evaluate(`document.querySelector('[data-proposal="${p.id}"][data-action=accept]').click()`);await until(async()=>(await app.store.get('proposals',p.id)).status==='accepted','correction accepted');
 assert.equal((await app.vault.read(path)).content,note.content.replace(before,after));check('accepting a memory correction updates only its exact passage');
 await evaluate(`document.querySelector('[data-view=review]').click();document.querySelector('#memory-correction-history').click()`);
 await until(()=>evaluate(`document.querySelector('#memory-correction-dialog').open&&document.querySelector('#memory-correction-dialog').textContent.includes('User updated the meeting')`),'correction history');
 assert.equal(await evaluate('!!window.correctionXSS'),false);assert(await evaluate(`document.querySelector('#memory-correction-dialog').textContent.includes('accepted')`));check('correction history retains source and superseded text safely');
 await evaluate(`document.querySelector('#correction-close').click()`);
 const record=await app.store.get('proposals',p.id);for(const file of [path,record.historyPath]){const n=await app.vault.read(file);await app.vault.trash(file,n.revision);}
}
