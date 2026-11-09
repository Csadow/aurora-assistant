import {randomUUID,createHash} from 'node:crypto';
import {AppError} from './vault.mjs';
import {taskLine,tasksIn,validDate,schedule} from './task-meta.mjs';
import {localDay} from '../mobile/web/planner-core.js';
export const RECURRING_PATH='40 Tasks/Recurring tasks.md';
const block=/```aurora-recurring\r?\n([\s\S]*?)\r?\n```/g;
const shift=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
export const occurrenceId=(id,date)=>{const h=createHash('sha256').update(id+':'+date).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
function validateRule(r){
 if(!r||typeof r.id!=='string'||!/^[\w-]{1,80}$/.test(r.id)||!validDate(r.from)||r.until!=null&&(!validDate(r.until)||r.until<r.from)||!Array.isArray(r.days)||!r.days.length||r.days.some(d=>!Number.isInteger(d)||d<0||d>6)||typeof r.paused!=='boolean')throw new AppError('Choose a title, start date, weekdays and optional end date for the repeating task.');
 const meta=schedule({duration:r.duration,priority:r.priority});taskLine(r.text,meta,r.id);
 for(const field of ['generated','skipped'])if(!Array.isArray(r[field])||r[field].length>30000||r[field].some(d=>!validDate(d))||new Set(r[field]).size!==r[field].length)throw new AppError('Invalid recurrence occurrence record. Repair the Markdown note.');
 return {id:r.id,text:r.text.trim(),duration:meta.duration,priority:meta.priority,from:r.from,until:r.until??null,days:[...new Set(r.days)],paused:r.paused,generated:[...r.generated],skipped:[...r.skipped]};
}
function parse(note){
 if(!note)return {rules:[],content:'# Recurring tasks\n\nThese are ordinary tasks. Change an occurrence in the planner without changing its series.\nRules and issued dates are stored below; keep the structured block when editing this note.\n\n```aurora-recurring\n{"version":1,"rules":[]}\n```\n\n## Occurrences\n',revision:null};
 const found=[...note.content.matchAll(block)];if(found.length!==1)throw new AppError('Recurring tasks need exactly one aurora-recurring block.');
 let data;try{data=JSON.parse(found[0][1]);}catch{throw new AppError('Invalid recurrence JSON. Repair the Markdown note.');}
 if(data.version!==1||!Array.isArray(data.rules)||data.rules.length>100)throw new AppError('Use at most 100 recurring task rules.');
 const rules=data.rules.map(validateRule);if(new Set(rules.map(r=>r.id)).size!==rules.length)throw new AppError('Recurring task IDs must be unique.');return {rules,content:note.content,revision:note.revision};
}
export function recurringSummary(notes){
 try{const note=notes.find(n=>n.path===RECURRING_PATH),s=parse(note);return {active:s.rules.filter(r=>!r.paused).length,paused:s.rules.filter(r=>r.paused).length,error:null};}
 catch(e){return {active:0,paused:0,error:e.message};}
}
export class RecurringTasks{
 constructor({vault,now=()=>new Date()}){Object.assign(this,{vault,now});this.queue=Promise.resolve();this.error=null;}
 exclusive(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
 async read(){try{return parse(await this.vault.read(RECURRING_PATH));}catch(e){if(e.status===404)return parse(null);throw e;}}
 async report(){let s,invalid=false;try{s=await this.read();}catch(e){s={rules:[],revision:null};invalid=true;this.error=e.message;}return {rules:s.rules,revision:s.revision,invalid,path:RECURRING_PATH,today:localDay(this.now()),through:shift(localDay(this.now()),13),error:this.error};}
 materialize(s){
  const today=localDay(this.now()),existing=new Set(tasksIn([{path:RECURRING_PATH,content:s.content}]).map(t=>t.id));let count=0;
  for(const r of s.rules){if(r.paused)continue;
   for(let n=0;n<14;n++){const date=shift(today,n);if(!validDate(date)||date<r.from||r.until&&date>r.until||!r.days.includes(new Date(date+'T12:00:00Z').getUTCDay())||r.generated.includes(date)||r.skipped.includes(date))continue;
    const id=occurrenceId(r.id,date);
    if(!existing.has(id))s.content+='\n- [ ] '+taskLine(r.text,{planDate:date,duration:r.duration,priority:r.priority},id)+'\n';
    r.generated.push(date);count++;
   }
  }return count;
 }
 async save(s,kind){
  s.rules=s.rules.map(validateRule);
  const content=s.content.replace(block,()=> '```aurora-recurring\n'+JSON.stringify({version:1,rules:s.rules},null,2)+'\n```');
  await this.vault.save(RECURRING_PATH,content,s.revision,{taskSource:{kind}});this.error=null;return this.report();
 }
 change(input){return this.exclusive(async()=>{
  const s=await this.read();if(input.revision!==s.revision)throw new AppError('Recurring tasks changed. Refresh before saving.',409);
  const rule=s.rules.find(r=>r.id===input.id);
  if(input.operation==='add'){
   if(s.rules.length>=100)throw new AppError('Use at most 100 recurring task rules.');
   s.rules.push(validateRule({...input.rule,id:randomUUID(),paused:false,generated:[],skipped:[]}));
  }else{
   if(!rule)throw new AppError('Recurring task not found.',404);
   if(input.operation==='pause')rule.paused=true;
   else if(input.operation==='resume')rule.paused=false;
   else if(input.operation==='end'){
    if(!validDate(input.until)||input.until<rule.from)throw new AppError('Choose an end date on or after the start date.');rule.until=input.until;
   }else if(input.operation==='skip'){
    const date=input.date;
    if(!validDate(date)||date<localDay(this.now())||date<rule.from||rule.until&&date>rule.until||!rule.days.includes(new Date(date+'T12:00:00Z').getUTCDay()))throw new AppError('Choose today or a future occurrence date in this series.');
    const id=occurrenceId(rule.id,date),matches=(await this.vault.tasks()).filter(t=>t.id===id);
    if(matches.length>1||matches.some(t=>t.path!==RECURRING_PATH))throw new AppError('This occurrence was copied or moved to another note. Manage it there before skipping.',409);
    if(matches.some(t=>t.done))throw new AppError('This occurrence is already complete. Its history will stay intact.');
    const t=matches[0];if(t){const lines=s.content.split('\n');lines.splice(t.line,1);s.content=lines.join('\n');}
    if(!rule.skipped.includes(date))rule.skipped.push(date);
   }else throw new AppError('Unknown recurring task action.');
  }
  this.materialize(s);return this.save(s,'recurring_'+input.operation);
 });}
 tick(){return this.exclusive(async()=>{try{const s=await this.read();if(this.materialize(s))await this.save(s,'recurring_generate');this.error=null;}catch(e){this.error=e.message;}});}
 start(){this.timer=setInterval(()=>this.tick(),60000);this.timer.unref();return this.tick();}
 stop(){clearInterval(this.timer);}
}
