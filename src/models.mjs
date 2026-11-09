import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {atomic,AppError} from './vault.mjs';
import {Ollama} from './ollama.mjs';
export class LocalModels{
  constructor({data,ollama}){this.file=join(data,'models.json');this.ollama=ollama;this.value={model:ollama.model||'qwen3.5:4b',thinking:false};this.saving=false;}
  async init(){try{const v=JSON.parse(await readFile(this.file,'utf8'));if(typeof v.model==='string'&&/^[a-zA-Z0-9._:/-]{1,150}$/.test(v.model)&&!v.model.includes('cloud'))this.value={model:v.model,thinking:v.thinking===true};}catch(e){if(e.code!=='ENOENT')throw e;}this.apply();}
  apply(){this.ollama.model=this.value.model;this.ollama.generationOptions={think:this.value.thinking,num_predict:this.value.thinking?6144:2400,num_ctx:/:(27b|35b)/.test(this.value.model)?16384:12288};}
  async status(){
    const status=await this.ollama.status();
    const models=await Promise.all(status.models.map(async m=>{
      if(m.capabilities||!this.ollama.request)return m;
      try{const info=await(await this.ollama.request('/api/show',{model:m.name})).json();return info.remote_model||info.remote_host?null:{...m,capabilities:info.capabilities||[]};}catch{return null;}
    }));
    return {...status,...this.value,generation:{...this.ollama.generationOptions},models:models.filter(m=>m&&(!m.capabilities||m.capabilities.includes('completion')))};
  }
  async save(input,isBusy=()=>false){
    if(this.saving||isBusy())throw new AppError('Stop or finish the active response before changing models.',409);this.saving=true;
    try{if(typeof input.model!=='string'||typeof input.thinking!=='boolean')throw new AppError('Choose a model and reasoning preference.');
      const status=await this.ollama.status();if(!status.models.some(m=>m.name===input.model))throw new AppError('Choose an installed local model.');
      if(this.ollama.url)await new Ollama(this.ollama.url,input.model,this.ollama.fetch).check();
      if(isBusy())throw new AppError('A response started. Finish it before changing models.',409);
      const next={model:input.model,thinking:input.thinking};await atomic(this.file,JSON.stringify(next,null,2));this.value=next;this.apply();return this.status();
    }finally{this.saving=false;}
  }
}
