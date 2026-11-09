import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomic,AppError} from './vault.mjs';

const empty=()=>({text:'',project:'',duration:'30',due:'',planDate:'',startTime:''});
const limits={text:600,project:1000,duration:8,due:10,planDate:10,startTime:5};
function fields(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==6||Object.entries(limits).some(([k,n])=>typeof value[k]!=='string'||value[k].length>n))throw new AppError('The task draft is invalid. Keep your text and reload the saved draft.');
  return Object.fromEntries(Object.keys(limits).map(k=>[k,value[k]]));
}
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value);
export class TaskCapture {
  constructor({store,reviews}){this.store=store;this.reviews=reviews;this.file=join(store.root,'task-capture.json');this.queue=Promise.resolve();}
  exclusive(fn){const work=this.queue.then(fn);this.queue=work.catch(()=>{});return work;}
  async read(){
    let d;try{d=JSON.parse(await readFile(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return {version:1,revision:'initial',fields:empty(),proposalId:null};throw new AppError('The saved task draft could not be read. Its file has been preserved.',409);}
    if(!d||typeof d!=='object'||Array.isArray(d)||d.version!==1||!uuid(d.revision)||d.proposalId!==null&&!uuid(d.proposalId))throw new AppError('The saved task draft is invalid. Its file has been preserved.',409);
    fields(d.fields);return d;
  }
  async write(d){await atomic(this.file,JSON.stringify(d,null,2));return d;}
  async proposal(d){if(!d.proposalId)return null;try{return await this.store.get('proposals',d.proposalId);}catch(e){if(e.status===404)return null;throw e;}}
  async public(d){const p=await this.proposal(d);return {...d,saveStarted:!!p?.intent&&p.status==='pending',proposal:p?this.reviews.public(p):null};}
  get(){return this.exclusive(async()=>this.public(await this.read()));}
  check(d,input){if(input.revision!==d.revision)throw new AppError('The shared draft changed in another window. Your local text is kept; load the shared draft to review it.',409);}
  act(input){return this.exclusive(async()=>{
    let d=await this.read();this.check(d,input);
    if(input.action==='save'){
      const value=fields(input.fields);if(d.proposalId)throw new AppError('Finish or edit the existing preview before changing this draft.',409);
      if(JSON.stringify(value)===JSON.stringify(d.fields))return this.public(d);
      d=await this.write({...d,revision:randomUUID(),fields:value});
    }else if(input.action==='preview'){
      // Reserve the review before creating it. A lost response or restart reuses it.
      if(!d.proposalId)d=await this.write({...d,revision:d.revision==='initial'?randomUUID():d.revision,proposalId:randomUUID()});
      if(!await this.proposal(d))await this.reviews.propose({...d.fields,project:d.fields.project||null,duration:Number(d.fields.duration)},null,{proposalId:d.proposalId,origin:'desktop_capture'});
    }else if(input.action==='accept'){
      if(!d.proposalId||!await this.proposal(d))throw new AppError('Preview the task before adding it.',409);
      await this.reviews.decide(d.proposalId,'accept',{allowConflicts:input.allowConflicts,origin:'desktop_capture'});
    }else if(input.action==='edit'||input.action==='clear'){
      const p=await this.proposal(d);
      // Dismiss also reconciles an interrupted task write. Never reopen that as a new task.
      if(p?.status==='pending'){
        const result=await this.reviews.decide(p.id,'dismiss',{origin:'desktop_capture'});
        if(result.status==='accepted')return this.public(d);
      }
      if(p?.status==='accepted'){await this.reviews.decide(p.id,'accept',{origin:'desktop_capture'});if(input.action==='edit')return this.public(d);}
      d=await this.write({...d,revision:randomUUID(),proposalId:null,fields:input.action==='clear'?empty():d.fields});
    }else throw new AppError('Choose a task capture action.');
    return this.public(d);
  });}
}
