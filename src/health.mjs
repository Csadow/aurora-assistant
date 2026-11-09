import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export async function health({cfg,vault,character,ollama,memory,settings,actions,backups,reminders,computer}){
  const checks=[];
  const add=(name,status,detail)=>checks.push({name,status,detail});
  for(const [name,path] of [['Memory folder',cfg.vault],['Application data',cfg.data]]){
    try{await access(path,constants.R_OK|constants.W_OK);add(name,'ok',path);}
    catch{add(name,'error','Cannot read and write '+path+'. Check folder permissions.');}
  }
  let notes=[];try{notes=await vault.list();add('Markdown memory','ok',`${notes.length} notes available`);}catch{add('Markdown memory','error','Some notes could not be read. Check folder permissions and the service log.');}
  const status=await ollama.status(),selected=ollama.model||cfg.model;
  add('Local model',status.online&&status.models.some(m=>m.name===selected)?'ok':'error',status.online?(status.models.some(m=>m.name===selected)?selected+' installed':selected+' is missing'):status.error||'Ollama is offline.');
  add('Memory search',!cfg.embedding||status.models.some(m=>m.name===cfg.embedding)?'ok':'warning',`${memory.mode||'lexical'}${memory.error?' · '+memory.error:''}${cfg.embedding&&!status.models.some(m=>m.name===cfg.embedding)?' · Embedding model unavailable; keyword search still works.':''}`);
  try{const profile=await character.read();add('Character',profile.missing?'warning':'ok',profile.missing?'Using the default personality. Save a character below to create its Markdown note.':'Using your saved Markdown character.');}catch{add('Character','error','Character note could not be read. Check the file in your memory folder.');}
  if(reminders){try{await reminders.read();add('Reminders',settings.value.remindersEnabled?'ok':'info',settings.value.remindersEnabled?'Enabled. Keep the native app in the tray for notifications.':'Paused. Saved task schedules are kept.');}catch(e){add('Reminders','error',e.message);}}
  if(computer){const state=computer.status();add('Computer control',!state.enabled?'info':state.online?'ok':'warning',!state.enabled?'Paused in Settings.':state.online?'Desktop connected. Routine app/browser actions are automatic; input requires review.':'Open the Aurora desktop app to connect app, browser and input tools.');}
  const c=settings.public().cloud;
  add('Cloud help',c.enabled?'ok':'info',c.enabled?`${c.provider} · ${c.model} · key saved; connection not tested`:'Disabled. No cloud requests are sent.');
  add('Actions',actions.running.size?'info':'ok',`${actions.running.size} running · risky actions require review`);
  let archives=[];try{archives=await backups.list();add('Backups',archives.length?(archives[0].private?'ok':'warning'):'warning',backups.running?'A backup is running.':archives.length?`Latest: ${archives[0].created}${archives[0].private?'':' · permissions allow access by other users; restrict this archive.'}`:'No backups yet. Create one below.');}catch{add('Backups','error','Cannot read the backup folder. Check its permissions.');}
  return {checkedAt:new Date().toISOString(),checks,backups:{running:backups.running,destination:cfg.backups,latest:archives[0]||null,count:archives.length},notes:notes.length};
}
