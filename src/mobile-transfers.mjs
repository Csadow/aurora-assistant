import {mkdir,readFile,readdir} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomic,AppError,sha,slug} from './vault.mjs';
import {FORMAT,readBundle} from '../mobile/web/core.js';

// File transfer only. This module has no model, workflow, command, or network client.
export class MobileTransfers {
  constructor({vault,data,afterWrite}){this.vault=vault;this.root=join(data,'mobile-transfers');this.queue=Promise.resolve();this.afterWrite=afterWrite;}
  async init(){for(const name of ['exports','reviews'])await mkdir(join(this.root,name),{recursive:true,mode:0o700});}
  exclusive(fn){const work=this.queue.then(fn);this.queue=work.catch(()=>{});return work;}
  file(kind,id){if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))throw new AppError('Invalid transfer ID.');return join(this.root,kind,id+'.json');}
  async get(kind,id){try{return JSON.parse(await readFile(this.file(kind,id),'utf8'));}catch(e){if(e.code==='ENOENT')throw new AppError('Transfer not found.',404);throw e;}}
  async put(kind,value){await atomic(this.file(kind,value.id),JSON.stringify(value));return value;}
  async note(path){try{return await this.vault.read(path);}catch(e){if(e.status===404)return null;throw e;}}
  async export(paths){
    if(!Array.isArray(paths)||!paths.length||paths.length>100||new Set(paths).size!==paths.length)throw new AppError('Select between 1 and 100 distinct notes.');
    const id=randomUUID(),notes=[];
    for(const path of paths){const n=await this.vault.read(path);notes.push({path:n.path,content:n.content,desktop:{exportId:id,revision:n.revision}});}
    const bundle={format:FORMAT,exported:new Date().toISOString(),notes,requests:[]},raw=JSON.stringify(bundle,null,2);
    try{readBundle(raw);}catch(e){throw new AppError(e.message);}
    await this.put('exports',{id,created:bundle.exported,vault:this.vault.root,notes:notes.map(n=>({path:n.path,revision:n.desktop.revision}))});
    return {id,filename:`aurora-memory-${id.slice(0,8)}.json`,bundle};
  }
  async baseline(note){
    if(!note.desktop)return null;
    try{
      const record=await this.get('exports',note.desktop.exportId);
      if(record.vault!==this.vault.root)return null;
      return record.notes.find(n=>n.path===note.path&&n.revision===note.desktop.revision)?.revision||null;
    }catch(e){if(e.status===404)return null;throw e;}
  }
  async prepare(raw){
    let bundle;try{bundle=readBundle(raw);}catch(e){throw new AppError(e.message);}
    const rows=[];let reviewBytes=0;
    const add=row=>{reviewBytes+=Buffer.byteLength(JSON.stringify(row));if(reviewBytes>8*1024*1024)throw new AppError('The comparison is larger than 8 MB. Transfer fewer notes at once.',413);rows.push(row);};
    for(const n of bundle.notes){
      const current=await this.note(n.path),base=await this.baseline(n),incoming=sha(n.content);
      let kind,reason;
      if(current?.content===n.content){kind='identical';reason='Already matches the desktop.';}
      else if(base===incoming){kind='keep';reason=current?'Only the desktop changed. Keep its newer version.':'Deleted on desktop; the phone has not changed it.';}
      else if(base&&current?.revision===base){kind='update';reason='Changed on the phone; the exported desktop version is still current.';}
      else if(!current&&!base){kind='create';reason='New note on this desktop.';}
      else {kind='conflict';reason=base?'Both devices changed, or the desktop note was deleted. Keep both versions.':'No matching desktop export baseline. Keep both versions.';}
      const copyPath=`60 Inbox/Mobile ${slug(basename(n.path,'.md'))} ${sha(n.path+'\0'+n.content).slice(0,16)}.md`;
      const copy=kind==='conflict'?await this.note(copyPath):null;
      add({id:`note-${rows.length}`,type:'note',path:n.path,content:n.content,before:current?.content??null,revision:current?.revision??null,kind,reason,copyPath,copyRevision:copy?.revision??null,copyContent:copy?.content??null});
    }
    for(const r of bundle.requests.filter(r=>r.target==='laptop'&&['queued','uncertain'].includes(r.status))){
      const path=`60 Inbox/Mobile request ${sha(r.id+'\0'+r.text).slice(0,24)}.md`,current=await this.note(path);
      const content=`---\nstatus: draft\nkind: mobile-request\nmobile_request: ${JSON.stringify(r.id)}\n---\n\n# Request from phone\n\nThis is an unstarted request. Review its scope and prepare a workflow separately. Importing this note executes nothing.\n\n${r.text}\n`;
      add({id:`request-${rows.length}`,type:'request',path,content,before:current?.content??null,revision:current?.revision??null,kind:current?'keep':'create',reason:current?'This request was already captured; keep the desktop draft.':'Save an unstarted request in the 60 Inbox memory folder.'});
    }
    const plan={id:randomUUID(),created:new Date().toISOString(),vault:this.vault.root,rows,ignoredRequests:bundle.requests.length-rows.filter(r=>r.type==='request').length};
    plan.digest=sha(JSON.stringify(plan));await this.put('reviews',plan);return plan;
  }
  async list(){
    const names=(await readdir(join(this.root,'reviews'))).filter(n=>/^[0-9a-f-]{36}\.json$/.test(n));
    const plans=await Promise.all(names.map(n=>this.get('reviews',n.slice(0,-5))));
    return plans.filter(p=>p.vault===this.vault.root).sort((a,b)=>b.created.localeCompare(a.created)).slice(0,30).map(p=>({id:p.id,created:p.created,notes:p.rows.filter(r=>r.type==='note').length,requests:p.rows.filter(r=>r.type==='request').length,pending:p.rows.filter(r=>!r.result&&!['keep','identical'].includes(r.kind)).length}));
  }
  async review(id){const p=await this.get('reviews',id);if(p.vault!==this.vault.root)throw new AppError('This transfer belongs to another vault.',409);return p;}
  async decide({id,rowId,digest,choice}){
    return this.exclusive(async()=>{
      const plan=await this.review(id);if(plan.digest!==digest)throw new AppError('Reload the transfer before reviewing it.',409);
      const row=plan.rows.find(r=>r.id===rowId);if(!row)throw new AppError('Transfer item not found.',404);
      if(row.result){if(row.result.choice!==choice)throw new AppError('This item has already been reviewed.',409);return plan;}
      if(row.intent&&row.intent.choice!==choice)throw new AppError('A save was interrupted. Retry the same choice to check its outcome.',409);
      if(choice==='skip'&&!row.intent){row.result={choice,status:'skipped'};await this.put('reviews',plan);return plan;}
      if(!(choice==='save'&&['create','update'].includes(row.kind)||choice==='copy'&&row.kind==='conflict'))throw new AppError('This choice is not available for this item.');
      const path=choice==='copy'?row.copyPath:row.path;
      // A deterministic copy location supports repeated imports without multiplying notes.
      if(choice==='copy'&&row.copyContent!==null&&row.copyContent!==row.content)throw new AppError('The previous mobile copy was edited. Keep it and merge manually.',409);
      const revision=choice==='copy'?row.copyRevision:row.revision;
      const current=await this.note(path);
      const matches=current?.content===row.content;
      if(!matches && (current?.revision??null)!==revision)throw new AppError('The destination changed after this preview. Import the file again for a fresh review.',409);
      if(!row.intent){row.intent={choice,path,revision};await this.put('reviews',plan);}
      // The write-ahead intent remains durable if the process exits after writing the note.
      // A retry reconciles exact bytes before deciding whether a write is still needed.
      if(!matches)await this.vault.save(path,row.content,revision);
      await this.afterWrite?.(row);
      row.result={choice,status:matches?'already-present':'saved',path,revision:sha(row.content)};
      await this.put('reviews',plan);return plan;
    }).catch(e=>{if(e.status)throw e;throw new AppError('Transfer interrupted. A note may already have been saved. Reopen this review and retry the same choice to check its outcome.',500);});
  }
}
