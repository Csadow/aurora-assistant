import {randomUUID} from 'node:crypto';
import {AppError} from './vault.mjs';

export const computerOperations=['applications','windows','open_app','open_path','open_url','web_search','browser_read','browser_click','browser_fill','browser_key','browser_back','browser_scroll','focus_window','close_window','click','type_text','key','scroll'];
export const automaticComputerOperations=new Set(['applications','windows','open_app','open_path','open_url','web_search','browser_read','browser_back','browser_scroll','focus_window','scroll']);

// Jobs are transient. A stopped or restarted request is never replayed.
export class Computer {
  constructor(settings,{timeout=45000}={}){this.settings=settings;this.timeout=timeout;this.jobs=new Map();this.lease=null;this.seen=0;}
  enabled(){if(!this.settings.value.systemEnabled||!this.settings.value.computerEnabled)throw new AppError('Computer control is paused in Settings.',403);}
  status(){return {enabled:this.settings.value.systemEnabled&&this.settings.value.computerEnabled,online:!!this.lease&&Date.now()-this.seen<5000,pending:this.jobs.size};}
  connect(){this.stop();this.lease=randomUUID();this.seen=Date.now();return {lease:this.lease};}
  authorize(lease){if(!lease||lease!==this.lease)throw new AppError('Desktop connection expired.',409);this.seen=Date.now();}
  poll(lease){this.authorize(lease);const next=[...this.jobs.values()].find(j=>!j.sent);if(next)next.sent=true;return {job:next?{id:next.id,method:next.method,input:next.input,expires:next.expires}:null,active:[...this.jobs.keys()],enabled:this.status().enabled};}
  complete(lease,id,result,error){this.authorize(lease);const job=this.jobs.get(id);if(!job)return {ignored:true};if(error)job.reject(new AppError(String(error).slice(0,600)));else job.resolve(result);return {received:true};}
  request(method,input={},signal){
    this.enabled();signal?.throwIfAborted();if(!this.status().online)throw new AppError('Open the Aurora desktop app to use computer controls.',503);
    if(this.jobs.size>=6)throw new AppError('The desktop is busy. Wait for the current action.',409);
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),finish=(fn,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.jobs.delete(id);fn(value);};
      const abort=()=>finish(reject,new AppError('Computer action stopped. Check the actual result before retrying.'));
      const timer=setTimeout(()=>finish(reject,new AppError('Desktop action timed out. It will not be retried automatically.')),this.timeout);
      this.jobs.set(id,{id,method,input,expires:Date.now()+this.timeout,resolve:value=>finish(resolve,value),reject:error=>finish(reject,error)});
      signal?.addEventListener('abort',abort,{once:true});
    });
  }
  async prepare(input,signal){
    this.enabled();if(!input||!computerOperations.includes(input.operation))throw new AppError('Unknown computer operation.');
    if(input.operation==='open_path'&&['text','content'].some(k=>Object.hasOwn(input,k)))throw new AppError('open_path only opens an existing file or folder; it cannot write text. Use propose_file_edit with path and complete content for a reviewed file creation or edit. After approval, read the file back before opening it.');
    if(input.operation==='browser_read'&&Object.hasOwn(input,'url'))throw new AppError('browser_read only reads the current page and does not accept a URL. Navigate first with computer_action operation=open_url and url; its result contains title, text and URL. Then use browser_read without url if you need another snapshot.');
    return this.request('prepare',input,signal);
  }
  async execute(payload,signal){this.enabled();return this.request('execute',payload,signal);}
  stop(){for(const job of [...this.jobs.values()])job.reject(new AppError('Computer control stopped. Pending input was cancelled.'));}
}
