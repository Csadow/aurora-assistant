import {viewList,freshReads} from './read-view.mjs';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, AppError, markdown, today } from './vault.mjs';

export class Store {
  constructor(root) { this.root=root; }
  async init() { for(const folder of ['reminder-cleanups','workload-reminder-decisions','estimate-reviews','session-summaries-day','session-summaries-week','daily-summaries','conversations','proposals','actions','runs','workflows','followups','task-workflows','handoffs','project-workspaces']) await mkdir(join(this.root,folder),{recursive:true,mode:0o700}); }
  file(kind,id) {
    if(!/^[0-9a-f-]{36}$/.test(id)) throw new AppError('Invalid record ID.');
    return join(this.root,kind,`${id}.json`);
  }
  async get(kind,id) {
    try { return JSON.parse(await readFile(this.file(kind,id),'utf8')); }
    catch(e) { if(e.code==='ENOENT') throw new AppError('Record not found.',404); throw e; }
  }
  async put(kind,record,options) { return freshReads(async()=>{await atomic(this.file(kind,record.id),JSON.stringify(record,null,2),options);return record;}); }
  async list(kind) { return viewList(this,kind,()=>this.readList(kind)); }
  async readList(kind) {
    const files=await readdir(join(this.root,kind));
    const records=[];
    for(const f of files.filter(f=>f.endsWith('.json'))) records.push(await this.get(kind,f.slice(0,-5)));
    return records.sort((a,b)=>(b.updated||b.created).localeCompare(a.updated||a.created));
  }
  async conversation() { return this.put('conversations',{id:randomUUID(),title:'New conversation',created:new Date().toISOString(),updated:new Date().toISOString(),messages:[]}); }
  async proposal(input) { return this.put('proposals',{...input,id:randomUUID(),status:'pending',created:new Date().toISOString()}); }
  async journal(vault,c) {
    const path=`90 Journal/${c.created.slice(0,10)} ${c.id}.md`;
    const body=`Conversation history. Assistant statements are suggestions, not verified facts.\n\n${c.messages.map(m=>`## ${m.role==='user'?'You':'Aurora'}\n\n${m.content}${m.interrupted?'\n\n_Interrupted response._':''}`).join('\n\n')}`;
    let revision=null;
    try { revision=(await vault.read(path)).revision; } catch(e) { if(e.status!==404)throw e; }
    await vault.save(path,markdown(c.title,body,{status:'journal',kind:'conversation',conversation:c.id}),revision);
  }
}
