import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, AppError, sha } from './vault.mjs';
export const reminderKey=t=>t.remindAt?sha(`${t.id||t.path+'\n'+t.text}\n${t.remindAt}`):null;
export class Reminders {
  constructor({vault,data,settings,now=Date.now,leaseMs=60000}){Object.assign(this,{vault,settings,now,leaseMs});this.path=join(data,'reminder-delivery.json');this.queue=Promise.resolve();}
  exclusive(fn){const work=this.queue.then(fn);this.queue=work.catch(()=>{});return work;}
  async read(){try{const value=JSON.parse(await readFile(this.path,'utf8'));if(value.version!==1||!value.delivered||typeof value.delivered!=='object'||Array.isArray(value.delivered))throw new Error('Invalid delivery state');return value;}catch(e){if(e.code==='ENOENT')return {version:1,delivered:{},lease:null};throw new AppError('Reminder delivery history could not be read. Check the service log and restore it from a backup.',503);}}
  claim(){return this.exclusive(async()=>{
    if(!this.settings.value.remindersEnabled)return {delivery:null};const state=await this.read(),now=this.now();if(state.lease?.until>now)return {delivery:null};
    const tasks=await this.vault.tasks(),keys=new Set(tasks.map(reminderKey).filter(Boolean));state.delivered=Object.fromEntries(Object.entries(state.delivered).filter(([key])=>keys.has(key)));
    const due=[...new Map(tasks.filter(t=>!t.done&&t.remindAt&&Date.parse(t.remindAt)<=now&&!state.delivered[reminderKey(t)]).map(t=>[reminderKey(t),t])).values()].sort((a,b)=>a.remindAt.localeCompare(b.remindAt)).slice(0,500);
    if(!due.length){if(state.lease){state.lease=null;await atomic(this.path,JSON.stringify(state));}return {delivery:null};}
    const id=randomUUID();state.lease={id,keys:due.map(reminderKey),until:now+this.leaseMs};await atomic(this.path,JSON.stringify(state));
    return {delivery:{id,count:due.length,items:due.slice(0,5).map(t=>({text:t.text,path:t.path,line:t.line,remindAt:t.remindAt})),expiresAt:new Date(state.lease.until).toISOString()}};
  });}
  acknowledge(id){return this.exclusive(async()=>{const state=await this.read();if(!state.lease||state.lease.id!==id)throw new AppError('Reminder delivery expired. It will be checked again.',409);for(const key of state.lease.keys)state.delivered[key]=new Date(this.now()).toISOString();state.lease=null;await atomic(this.path,JSON.stringify(state));return {recorded:true};});}
}
