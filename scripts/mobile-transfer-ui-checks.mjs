import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {emptyState,readBundle,importBundle,saveNote,queueRequest,exportBundle} from '../mobile/web/core.js';
export async function mobileTransferUIChecks({app,evaluate,until,check,screenshot}){
  const path='60 Inbox/Mobile transfer fixture.md';let original;
  try{original=await app.vault.read(path);}catch(e){if(e.status!==404)throw e;}
  await app.vault.save(path,'# Desktop baseline',original?.revision??null);
  await evaluate('document.querySelector("#settings").click()');await until(()=>evaluate('!!document.querySelector("#mobile-export")&&document.querySelectorAll("[data-mobile-note]").length>0'),'mobile settings');
  const notes=await evaluate('[...document.querySelectorAll("[data-mobile-note]")].filter(n=>n.checked).length');assert.equal(notes,0);
  await evaluate(`document.querySelector('#mobile-transfer-section details').open=true;const c=[...document.querySelectorAll('[data-mobile-note]')].find(n=>n.dataset.mobileNote===${JSON.stringify(path)});c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#mobile-export').click();`);
  await until(()=>evaluate('document.querySelector("#mobile-export-status").textContent.includes("Prepared 1")'),'selected note export');
  const status=await evaluate('document.querySelector("#mobile-export-status").textContent'),prefix=status.match(/aurora-memory-([a-f0-9]{8})/)[1];
  const name=(await readdir(join(app.config.data,'mobile-transfers/exports'))).find(n=>n.startsWith(prefix));assert(name);
  const record=JSON.parse(await readFile(join(app.config.data,'mobile-transfers/exports',name),'utf8'));assert.equal(record.notes.length,1);assert.equal(record.notes[0].path,path);check('mobile panel exports only explicitly selected notes and saves their baseline');
  const phone=emptyState();importBundle(phone,readBundle(JSON.stringify({format:'aurora-mobile-v1',notes:[{path,content:'# Desktop baseline',desktop:{exportId:record.id,revision:record.notes[0].revision}}],requests:[]})));
  saveNote(phone,path,'# Phone edit\n<img src=x onerror="window.mobileXSS=true">',phone.notes[0].revision);queueRequest(phone,'Inspect the project later','laptop');
  const incoming=exportBundle(phone);
  const upload=async raw=>{await evaluate(`(()=>{const data=new DataTransfer();data.items.add(new File([${JSON.stringify(raw)}],'phone.json',{type:'application/json'}));const input=document.querySelector('#mobile-import');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);};
  await upload(incoming);await until(()=>evaluate('document.querySelectorAll("[data-mobile-row]").length===2'),'review phone changes');
  assert.equal((await app.vault.read(path)).content,'# Desktop baseline');assert.equal(await evaluate('window.mobileXSS'),undefined);
  await evaluate('document.querySelector("[data-mobile-row=note-0] details").open=true');await screenshot?.('desktop-mobile-transfer.png');
  await evaluate('document.querySelector("[data-mobile-row=note-0] [data-mobile-choice=save]").click()');await until(async()=>(await app.vault.read(path)).content.includes('# Phone edit'),'reviewed note saved');
  await until(()=>evaluate('!!document.querySelector("[data-mobile-row=note-0] .mobile-transfer-result")'),'saved note result');check('incoming note text is escaped and changes the vault only after explicit review');
  const before=(await app.store.list('workflows')).length;
  await evaluate('document.querySelector("[data-mobile-row=request-1] [data-mobile-choice=save]").click()');await until(()=>evaluate('!!document.querySelector("[data-mobile-row=request-1] .mobile-transfer-result")'),'request saved');
  assert.equal((await app.store.list('workflows')).length,before);const request=(await app.vault.list()).find(n=>n.kind==='mobile-request'&&n.content.includes('Inspect the project later'));assert.equal(request.status,'draft');check('phone task is saved as an unstarted draft without launching a workflow');
  let note=await app.vault.read(path);await app.vault.save(path,'# New desktop version',note.revision);
  await upload(incoming);await until(()=>evaluate('!!document.querySelector("[data-mobile-choice=copy]")'),'conflict review');
  await evaluate('document.querySelector("[data-mobile-choice=copy]").click()');await until(()=>evaluate('!!document.querySelector("[data-mobile-row=note-0] .mobile-transfer-result")'),'copy saved');assert.equal((await app.vault.read(path)).content,'# New desktop version');check('Keep both versions preserves a newer desktop edit');
  await evaluate('window.oldMobileSection=document.querySelector("#mobile-transfer-section");document.querySelector("#close-settings").click();document.querySelector("#settings").click()');await until(()=>evaluate('!window.oldMobileSection.isConnected'), 'fresh settings panel');await until(()=>evaluate('document.querySelectorAll("[data-mobile-review]").length>=2'),'durable transfer list');await evaluate('document.querySelector("[data-mobile-review]").click()');await until(()=>evaluate('!!document.querySelector(".mobile-transfer-result")'),'persisted review');check('transfer decisions reopen from durable review history');
  await evaluate('document.querySelector("#close-settings").click()');
}
