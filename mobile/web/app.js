import {TIMETABLE_PATH} from './timetable.js';
import {mountPlanner} from './planner.js';
import {mobileTasks,editTaskContent,TASK_PATH} from './planner-core.js';
import {taskLine} from './tasks.js';
import {transact} from './storage.js';
import {emptyState,saveNote,queueRequest,updateRequest,recover,searchNotes,prepareRequest,parseReply,exportBundle,readBundle,importBundle,LIMIT} from './core.js';
const $=s=>document.querySelector(s), native=window.AuroraNative;
let state=emptyState(), editor=null, review=null, sending=null, importing=null, noticeTimer;
function notice(message){$('#notice').textContent=message;$('#notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#notice').hidden=true,9000);}
const safe=fn=>async(...args)=>{try{return await fn(...args);}catch(e){notice(e.message);}};
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function button(text,fn){const n=el('button',text);n.type='button';n.onclick=safe(fn);return n;}
const planner=mountPlanner($('#mobile-planner'),{
  compact:true,
  description:'Tasks and plans stay on this phone, even offline or with your laptop off. Use backup transfer to share them with desktop.',
  list:async()=>mobileTasks(await transact()),
  timetable:async()=>(await transact()).notes.find(n=>n.path===TIMETABLE_PATH)||null,
  saveTimetable:(content,revision)=>transact(s=>saveNote(s,TIMETABLE_PATH,content,revision)),
  add:async text=>transact(s=>{
    const n=s.notes.find(n=>n.path===TASK_PATH);
    saveNote(s,TASK_PATH,(n?.content||'# Tasks\n').trimEnd()+'\n- [ ] '+taskLine(text)+'\n',n?.revision??null);
  }),
  update:async(t,changes)=>transact(s=>{
    const n=s.notes.find(n=>n.path===t.path);if(!n)throw Error('Task note is missing. Refresh your planner.');
    saveNote(s,n.path,editTaskContent(n,t,changes),n.revision);
  })
});
async function refresh(){state=await transact();render();await planner.load();}
function tab(name){if(name==='planner')safe(()=>planner.load())();if(name==='memory')safe(async()=>{state=await transact();renderNotes();})();for(const n of ['planner','chat','memory','settings'])$(`#${n}-view`).hidden=n!==name;for(const b of document.querySelectorAll('[data-tab]')){if(b.dataset.tab===name)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}window.scrollTo(0,0);}
function render(){
  $('#requests').replaceChildren();
  const labels={queued:'Saved on device',sending:'Waiting for Gemini',uncertain:'Reply not confirmed',answered:'Aurora · Gemini',cancelled:'Cancelled'};
  for(const r of state.requests){
    const card=el('article',undefined,'request');card.dataset.request=r.id;
    card.append(el('div',r.target==='laptop'?'For your laptop · saved only':labels[r.status],'meta'),el('p',r.text,'user'));
    if(r.answer)card.append(el('p',r.answer,'answer'));
    const actions=el('div',undefined,'actions');
    if(['queued','uncertain'].includes(r.status)){
      if(r.target==='chat'){const b=button('Review & send',()=>openReview(r.id));b.disabled=!!sending;actions.append(b);}
      actions.append(button('Cancel',async()=>{await transact(s=>updateRequest(s,r.id,'cancelled'));await refresh();}));
    }
    if(r.status==='sending')actions.append(button('Stop waiting',()=>stopSending()));
    if(r.status==='answered'){
      actions.append(button('Read aloud',()=>{if(native)native.speak(r.answer);else notice('Read aloud is available in the Android app.');}));
      actions.append(button('Save as note',()=>{tab('memory');openNote(null,`# Conversation note\n\n${r.text}\n\n${r.answer}\n`);}));
    }
    card.append(actions);$('#requests').append(card);
  }
  renderNotes();$('#model').value=state.model;
  $('#key-status').textContent=native?(native.hasKey()?'API key saved on this device.':'Add your own free-tier API key to enable replies.'):'Desktop preview: cloud replies require the Android app.';
  $('#runtime').textContent=native?'Aurora Mobile 0.3 · Android · offline assets included':'Aurora Mobile 0.3 · browser preview. Preview data is separate from your desktop vault.';
}
function renderNotes(){
  $('#notes').replaceChildren();const notes=searchNotes(state,$('#search').value);
  if(!notes.length)$('#notes').append(el('p','No matching notes yet. Add a thought or import Markdown.','hint'));
  for(const n of notes){const b=button(n.path,async()=>openNote((await transact()).notes.find(current=>current.path===n.path)));b.className='note';b.append(el('small',n.content.slice(0,110)));$('#notes').append(b);}
}
function openNote(n,content='',restoring=false){
  if(!$('#note-editor').hidden && ($('#content').value!==editor.content || $('#path').value!==editor.path) && !confirm('Discard the unsaved note draft?'))return;
  editor={path:n?.path||'',content:n?.content||content,revision:n?.revision??null};
  $('#path').value=editor.path;$('#path').readOnly=!!n;$('#content').value=editor.content;$('#note-status').textContent='';$('#note-editor').hidden=false;$('#note-editor').scrollIntoView({behavior:'smooth'});
  if(!restoring){const draft={...editor,draftPath:editor.path,draftContent:editor.content};safe(()=>transact(s=>{s.noteDraft=draft;}))();}
}
async function openReview(id){
  if(!native){notice('Install the Android APK to configure Gemini. This preview never sends cloud requests.');return;}
  if(!native.hasKey()){tab('settings');notice('Set your own Gemini API key first.');return;}
  if(sending)throw Error('Wait for the current reply or stop it first.');
  state=await transact();review={id,prepared:null};$('#memory-choice').replaceChildren();
  for(const n of state.notes){const label=el('label'),check=el('input');check.type='checkbox';check.value=n.path;check.onchange=safe(preview);label.append(check,document.createTextNode(n.path));$('#memory-choice').append(label);}
  preview();$('#review').showModal();
}
function preview(){
  try{review.prepared=prepareRequest(state,review.id,[...document.querySelectorAll('#memory-choice input:checked')].map(n=>n.value));$('#payload').textContent=JSON.stringify(review.prepared,null,2);$('#send').disabled=false;}
  catch(e){review.prepared=null;$('#send').disabled=true;$('#payload').textContent=e.message;}
}
async function stopSending(){
  if(!sending)return;const id=sending;sending=null;native?.cancel();
  await transact(s=>updateRequest(s,id,'uncertain','Stopped waiting. The provider may already have processed the request. Nothing will retry automatically.'));await refresh();
}
window.auroraResult=safe(async result=>{
  if(result.id!==sending)return;const id=sending;
  try{
    if(result.error)throw Error(result.error);
    const answer=parseReply(result.body);await transact(s=>updateRequest(s,id,'answered',answer));
  }catch(e){await transact(s=>updateRequest(s,id,'uncertain',e.message));}
  finally{sending=null;await refresh();}
});
window.auroraNotice=notice;
window.auroraKeyChanged=safe(refresh);
window.auroraShared=safe(async text=>{
  if(!text)return;
  const draft=[$('#message').value,text].filter(Boolean).join('\n\n');
  if(draft.length>6000)throw Error('Shared text is too long to add to this draft. Shorten your current message first.');
  $('#message').value=draft;await transact(s=>{s.draft=draft;});tab('chat');notice('Shared text is in your draft. It has not been sent.');
});
for(const b of document.querySelectorAll('[data-tab]'))b.onclick=()=>tab(b.dataset.tab);
$('#composer').onsubmit=safe(async e=>{e.preventDefault();await transact(s=>queueRequest(s,$('#message').value,$('#target').value));$('#message').value='';await refresh();});
$('#message').oninput=safe(async()=>{const text=$('#message').value;await transact(s=>{s.draft=text;});});
$('#search').oninput=renderNotes;$('#new-note').onclick=()=>openNote(null);
$('#close-editor').onclick=safe(async()=>{if(($('#content').value!==editor.content || $('#path').value!==editor.path)&&!confirm('Discard the unsaved note draft?'))return;$('#note-editor').hidden=true;editor=null;await transact(s=>{s.noteDraft=null;});});
for(const field of ['#path','#content'])$(field).oninput=safe(async()=>{const draft={...editor,draftPath:$('#path').value,draftContent:$('#content').value};await transact(s=>{s.noteDraft=draft;});$('#note-status').textContent='Draft kept on this device';});
$('#note-editor').onsubmit=safe(async e=>{e.preventDefault();const saved=await transact(s=>{const n=saveNote(s,$('#path').value,$('#content').value,editor.revision);s.noteDraft=null;return n;});editor=saved;$('#path').readOnly=true;$('#note-status').textContent='Saved on this device';await refresh();});
$('#cancel-review').onclick=()=>{$('#review').close();review=null;};
$('#send').onclick=safe(async()=>{
  if(sending||!review?.prepared)return;
  const {id,prepared}=review;
  // Freeze the previewed bytes. Do not reselect memory or add new history on send.
  await transact(s=>updateRequest(s,id,'sending'));sending=id;$('#review').close();review=null;await refresh();
  try{native.generate(id,JSON.stringify(prepared));}catch(e){await window.auroraResult({id,error:e.message});}
});
$('#model-form').onsubmit=safe(async e=>{e.preventDefault();const model=$('#model').value.trim();if(!/^gemini-[a-z0-9.-]{1,80}$/.test(model))throw Error('Enter a valid Gemini model ID.');await transact(s=>{s.model=model;});await refresh();notice('Model saved. No request was sent.');});
$('#configure-key').onclick=()=>native?native.configureKey():notice('API keys are configured only in the Android app.');
$('#remove-key').onclick=()=>{if(native&&confirm('Remove the saved Gemini key from this device?'))native.removeKey();};
function download(name,raw){if(native){native.exportFile(name,raw);return;}const url=URL.createObjectURL(new Blob([raw],{type:'application/json'}));const a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('#export').onclick=safe(async()=>download('aurora-mobile-backup.json',exportBundle(await transact())));
$('#export-markdown').onclick=safe(async()=>{if(!native)throw Error('Markdown ZIP export is available in the Android app. Backup export works in this preview.');native.exportMarkdown(exportBundle(await transact()));});
async function importRaw(name,raw){
  importing=name.toLowerCase().endsWith('.md')?readBundle(JSON.stringify({format:'aurora-mobile-v1',notes:[{path:`60 Inbox/${name}`,content:raw}],requests:[]})):readBundle(raw);
  $('#import-summary').textContent=`${importing.notes.length} notes and ${importing.requests.length} requests. Import does not send or execute anything.`;$('#import-review').showModal();
}
$('#import').onchange=safe(async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;if(file.size>LIMIT)throw Error('Choose a file smaller than 4 MB.');await importRaw(file.name,await file.text());});
window.auroraImport=safe(async data=>importRaw(data.name,data.raw));
if(native){$('#import').hidden=true;const b=button('Choose backup or Markdown',()=>native.importFile());$('#import').after(b);}
$('#stop-speech').onclick=()=>native?.stopSpeech();
$('#cancel-import').onclick=()=>{importing=null;$('#import-review').close();};
$('#confirm-import').onclick=safe(async()=>{if(!importing)return;const report=await transact(s=>importBundle(s,importing));importing=null;$('#import-review').close();await refresh();notice(`Imported ${report.added} notes and ${report.requests} requests; ${report.conflicts} different notes kept as separate copies.`);});
window.addEventListener('beforeunload',e=>{if(editor&&($('#content').value!==editor.content||$('#path').value!==editor.path)){e.preventDefault();e.returnValue='';}});
await safe(async()=>{await transact(recover);await refresh();$('#message').value=state.draft;if(state.noteDraft){const d=state.noteDraft;openNote(d,'',true);$('#path').value=d.draftPath;$('#path').readOnly=!!d.revision;$('#content').value=d.draftContent;tab('memory');$('#note-status').textContent='Recovered your note draft';}document.body.dataset.ready='true';if(native)await window.auroraShared(native.takeShared());})();
