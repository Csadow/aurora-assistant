import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomic, AppError, sha } from './vault.mjs';

export const providers={openai:{endpoint:'https://api.openai.com/v1',model:''},anthropic:{endpoint:'https://api.anthropic.com/v1',model:''},gemini:{endpoint:'https://generativelanguage.googleapis.com/v1beta',model:''},compatible:{endpoint:'https://api.openai.com/v1',model:''}};
export const defaults = {systemEnabled:true,computerEnabled:true,routineEnabled:true,remindersEnabled:true,cloud:{enabled:false,provider:'gemini',...providers.gemini,apiKey:'',dailyLimit:5,dailyOutputLimit:32768,maxTokens:4096,tokenField:'max_completion_tokens',accounts:{}}};
export class Settings {
  constructor(root){this.file=join(root,'integrations.json');this.value=structuredClone(defaults);this.queue=Promise.resolve();}
  async init(){try{const saved=JSON.parse(await readFile(this.file,'utf8'));this.value={...defaults,...saved,cloud:{...defaults.cloud,...saved.cloud,accounts:saved.cloud?.accounts||{}}};}catch(e){if(e.code!=='ENOENT')throw e;}}
  public(){const {apiKey,accounts,...cloud}=this.value.cloud;const profiles=Object.fromEntries(Object.entries(accounts||{}).map(([name,{apiKey,...v}])=>[name,{...v,hasKey:!!apiKey}]));profiles[cloud.provider]={endpoint:cloud.endpoint,model:cloud.model,hasKey:!!apiKey};return {computerEnabled:this.value.computerEnabled,remindersEnabled:this.value.remindersEnabled,systemEnabled:this.value.systemEnabled,routineEnabled:this.value.routineEnabled,cloud:{...cloud,hasKey:!!apiKey,profiles},cloudRevision:this.cloudRevision()};}
  cloudRevision(){const {accounts,...value}=this.value.cloud;return sha(JSON.stringify(value));}
  save(data){const input=structuredClone(data);const work=this.queue.then(()=>this.apply(input));this.queue=work.catch(()=>{});return work;}
  async apply(data){
    const next=structuredClone(this.value);
    if(typeof data.remindersEnabled==='boolean')next.remindersEnabled=data.remindersEnabled;
    if(typeof data.computerEnabled==='boolean')next.computerEnabled=data.computerEnabled;
    if(typeof data.systemEnabled==='boolean')next.systemEnabled=data.systemEnabled;
    if(typeof data.routineEnabled==='boolean')next.routineEnabled=data.routineEnabled;
    if(data.cloud){
      const c=data.cloud;
      if(c.provider!==undefined){if(!providers[c.provider])throw new AppError('Unknown cloud provider.');if(c.provider!==next.cloud.provider){next.cloud.accounts[next.cloud.provider]={endpoint:next.cloud.endpoint,model:next.cloud.model,apiKey:next.cloud.apiKey,tokenField:next.cloud.tokenField};Object.assign(next.cloud,{...providers[c.provider],apiKey:'',tokenField:'max_completion_tokens'},next.cloud.accounts[c.provider]||{},{provider:c.provider,enabled:false});}}
      if(typeof c.enabled==='boolean')next.cloud.enabled=c.enabled;
      if(c.endpoint!==undefined){let u;try{u=new URL(c.endpoint);}catch{throw new AppError('Enter an HTTPS API base URL.');}if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new AppError('The cloud endpoint must be HTTPS, without credentials or query parameters.');next.cloud.endpoint=u.href.replace(/\/$/,'');}
      if(next.cloud.provider!=='compatible'&&next.cloud.endpoint!==providers[next.cloud.provider].endpoint)throw new AppError('Use the provider’s official endpoint, or select Custom compatible API.');
      if(c.model!==undefined){if(typeof c.model!=='string'||c.model.length>150||/[\x00-\x1f]/.test(c.model))throw new AppError('Enter a valid model ID.');next.cloud.model=c.model.trim();}
      for(const [key,min,max] of [['dailyLimit',1,100],['maxTokens',256,32768],['dailyOutputLimit',256,1000000]])if(c[key]!==undefined){const n=Number(c[key]);if(!Number.isInteger(n)||n<min||n>max)throw new AppError(`${key} must be between ${min} and ${max}.`);next.cloud[key]=n;}
      if(c.tokenField!==undefined){if(!['max_completion_tokens','max_tokens'].includes(c.tokenField))throw new AppError('Invalid token limit format.');next.cloud.tokenField=c.tokenField;}
      if(c.clearKey===true)next.cloud.apiKey='';
      else if(c.apiKey){if(typeof c.apiKey!=='string'||c.apiKey.length>1000||/\s/.test(c.apiKey))throw new AppError('Invalid API key.');next.cloud.apiKey=c.apiKey;}
      if(next.cloud.enabled&&(!next.cloud.apiKey||!next.cloud.model))throw new AppError('Add a model ID and API key before enabling cloud help.');
    }
    await atomic(this.file,JSON.stringify(next,null,2));this.value=next;return this.public();
  }
}
