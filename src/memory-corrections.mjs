import {AppError,markdown,sha} from './vault.mjs';
export const correctionEligible=n=>!['journal','draft','archived'].includes(n.status)&&/^(10 Profile|20 Projects|30 Knowledge|60 Inbox)\//.test(n.path);
export class MemoryCorrections {
  constructor({vault,store}){Object.assign(this,{vault,store});this.queue=Promise.resolve();}
  public(p){const {intent,...rest}=p;return rest;}
  async list(){return (await this.store.list('proposals')).filter(p=>p.kind==='memory_correction').map(p=>this.public(p));}
  async propose(a,conversation=null){
    for(const key of ['path','revision','before','after','reason'])if(typeof a[key]!=='string')throw new AppError(`Missing correction ${key}.`);
    if(!a.before.trim()||a.before.length>8000||a.after.length>8000||!a.reason.trim()||a.reason.length>1200||a.before===a.after)throw new AppError('Provide an exact quote, a different replacement, and a short reason.');
    const n=await this.vault.read(a.path);if(!correctionEligible(n))throw new AppError('Correct a current profile, project, knowledge or inbox note.');
    if(n.revision!==a.revision)throw new AppError('This memory changed. Read it again before drafting a correction.',409);
    const offset=n.body.indexOf(a.before);if(offset<0||n.body.indexOf(a.before,offset+1)>=0)throw new AppError('The original quote must match exactly once in the note body. Include more surrounding text.');
    const start=n.content.length-n.body.length+offset,content=n.content.slice(0,start)+a.after+n.content.slice(start+a.before.length);
    // Task metadata has its own reviewed editor and dependency validation.
    const taskLines=s=>s.split('\n').filter(l=>/^\s*[-*+]\s+\[[ xX]\]/.test(l));
    if(JSON.stringify(taskLines(n.content))!==JSON.stringify(taskLines(content)))throw new AppError('Use the task review controls to change task lines.');
    return this.public(await this.store.proposal({kind:'memory_correction',conversation,title:`Correct ${n.title}`,path:n.path,revision:n.revision,before:a.before,after:a.after,reason:a.reason.trim(),source:conversation?`Conversation ${conversation}`:'Explicit memory review',intent:{content,revision:sha(content)},historyPath:null}));
  }
  decide(id,action){const work=this.queue.then(()=>this.apply(id,action));this.queue=work.catch(()=>{});return work;}
  async apply(id,action){
    if(!['accept','dismiss'].includes(action))throw new AppError('Invalid correction action.');
    let p=await this.store.get('proposals',id);if(p.kind!=='memory_correction')throw new AppError('This is not a memory correction.');
    if(p.status!=='pending'){if(p.status===(action==='accept'?'accepted':'dismissed'))return this.public(p);throw new AppError('This correction was already handled.',409);}
    if(action==='dismiss'){
      if(p.applying)throw new AppError('A save was started. Retry acceptance to finish its history receipt before dismissing.',409);
      p.status='dismissed';return this.public(await this.store.put('proposals',p));
    }
    if(!p.appliedAt){
      const n=await this.vault.read(p.path);
      if(!(p.applying&&n.revision===p.intent.revision)){
        if(n.revision!==p.revision)throw new AppError('This memory changed after the preview. Dismiss this draft and prepare a new correction.',409);
        p.applying=true;await this.store.put('proposals',p);
        try{await this.vault.save(p.path,p.intent.content,p.revision);}catch(e){
          const current=await this.vault.read(p.path).catch(()=>null);
          if(current?.revision!==p.intent.revision){p.applying=false;await this.store.put('proposals',p);}throw e;
        }
      }
      p.appliedAt=new Date().toISOString();await this.store.put('proposals',p);
    }
    const path=`90 Journal/Memory corrections/${p.id}.md`;
    const content=markdown(p.title,`Historical correction receipt. The original text below is superseded, not current memory.\n\nNote: [[${p.path.slice(0,-3)}]]\n\nApplied: ${p.appliedAt}\n\nSource: ${p.source}\n\nReason: ${p.reason}\n\nOriginal revision: ${p.revision}\n\nCorrected revision: ${p.intent.revision}\n\n## Replaced text\n\n${p.before}\n\n## Accepted replacement\n\n${p.after||'(Deleted)'}`,{status:'journal',kind:'memory-correction',source:p.id}).replace(/^updated:.*$/m,`updated: ${JSON.stringify(p.appliedAt.slice(0,10))}`);
    try{
    let existing;try{existing=await this.vault.read(path);}catch(e){if(e.status!==404)throw e;}
    if(!existing)await this.vault.save(path,content,null);
    else if(existing.kind!=='memory-correction'||existing.content!==content)throw new AppError('The correction was applied, but its history note changed. Inspect the receipt before retrying.',409);
    p.historyPath=path;p.status='accepted';return this.public(await this.store.put('proposals',p));
    }catch(e){throw new AppError('The memory correction was applied, but its history receipt is unfinished. Retry acceptance to finish it. '+e.message,503);}
  }
}
