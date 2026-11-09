import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomic, sha, chunks, retrieve } from './vault.mjs';

export const cosine=(a,b)=>{
  if(!a?.length||a.length!==b?.length)return 0;
  let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
  return aa&&bb?dot/Math.sqrt(aa*bb):0;
};
export class Memory {
  constructor({vault,ollama,data,model}){Object.assign(this,{vault,ollama,model});this.path=join(data,'memory-index.json');this.cache=null;this.mode='keyword';this.error=null;this.queue=Promise.resolve();}
  async embed(input,signal){
    const response=await this.ollama.request('/api/embed',{model:this.model,input,truncate:true,keep_alive:'5m',options:{num_gpu:0,num_ctx:2048}},signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000));
    const value=await response.json();if(!Array.isArray(value.embeddings)||value.embeddings.length!==input.length||value.embeddings.some(v=>!Array.isArray(v)||!v.length||v.some(x=>!Number.isFinite(x))))throw new Error('Invalid embedding response.');
    return value.embeddings;
  }
  recall(query,limit=7,budget=14000,signal){
    const work=this.queue.then(()=>this.search(query,limit,budget,signal));this.queue=work.catch(()=>{});return work;
  }
  async search(query,limit,budget,signal){
    signal?.throwIfAborted();
    const notes=await this.vault.list();
    const fallback=()=>retrieve(notes,query,limit,budget);
    if(!this.model||!this.ollama.request)return fallback();
    try{
      const status=await this.ollama.status();
      if(!status.models.some(m=>m.name===this.model)){this.mode='keyword';this.error='Embedding model unavailable; using keyword recall.';return fallback();}
      if(!this.cache){try{const saved=JSON.parse(await readFile(this.path,'utf8'));this.cache=saved.model===this.model?saved.vectors:{};}catch{this.cache={};}}
      const documents=notes.filter(n=>n.kind!=='memory-correction'&&!['journal','draft','archived'].includes(n.status)&&!n.path.startsWith('99 Archive/')&&!n.path.startsWith('70 Skills/')).flatMap(n=>chunks(n.body).map(text=>({path:n.path,text,title:n.title,key:sha(`${this.model}\n${n.title}\n${text}`)})));
      const fresh=documents.filter(d=>!this.cache[d.key]);
      for(let i=0;i<fresh.length;i+=16){
        signal?.throwIfAborted();const batch=fresh.slice(i,i+16);
        const vectors=await this.embed(batch.map(d=>`title: ${d.title} | text: ${d.text}`),signal);
        batch.forEach((d,j)=>this.cache[d.key]=vectors[j]);
      }
      const keys=new Set(documents.map(d=>d.key));const pruned=Object.fromEntries(Object.entries(this.cache).filter(([k])=>keys.has(k)));
      if(fresh.length||Object.keys(pruned).length!==Object.keys(this.cache).length){this.cache=pruned;await atomic(this.path,JSON.stringify({model:this.model,vectors:this.cache}));}
      const [vector]=await this.embed([`task: search result | query: ${query.slice(0,2000)}`],signal);const semantic=new Map();
      for(const doc of documents){const score=cosine(vector,this.cache[doc.key]);if(score>(semantic.get(doc.path)?.score??-1))semantic.set(doc.path,{score,text:doc.text});}
      this.mode='hybrid';this.error=null;
      return retrieve(notes,query,limit,budget,semantic);
    }catch(e){signal?.throwIfAborted();this.mode='keyword';this.error=`Semantic recall unavailable: ${e.message}. Using keyword recall.`;return fallback();}
  }
}
