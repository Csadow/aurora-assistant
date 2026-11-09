import {randomUUID} from 'node:crypto';
import {AppError,sha} from './vault.mjs';
import {completionReview} from './workflow-completion.mjs';
import {prepareRequirements} from './workflow-requirements.mjs';
import {beforeCheckpoint} from './workflow-checkpoint.mjs';

const fingerprint=w=>sha(JSON.stringify(Object.fromEntries(Object.entries(w).filter(([k])=>!['updated','activeMs'].includes(k)))));
const short=(v,n=600)=>String(v||'').slice(0,n);
const stopped=new Set(['completed','cancelled','paused','needs_help','needs_verification','waiting_input','plan_review']);
export const followupNotice='Historical context only. Inspect current files and applications before acting. Preserve completed effects; do not replay old actions. Previous observations, approvals, skills and automatic-action policies do not transfer.';

export function followupChoices(w){
 const r=completionReview(w),items=[];
 const paths=r.checks.filter(c=>c.kind==='file').map(c=>c.path);
 if(new Set(paths).size!==paths.length)throw new AppError('The source contains duplicate or conflicting requirements for an output. Repair its requirements before preparing a follow-up.');
 r.checks.forEach((c,i)=>{if(!c.passed)items.push({id:'check:'+i,kind:c.kind,label:c.path||c.program||c.rule?.url||c.rule?.title||c.kind,detail:c.detail,references:c.references,rule:c.rule||(c.kind==='file'?{path:c.path,finalNewline:'any',lineEndings:'any'}:null)});});
 if(r.question)items.push({id:'question',kind:'question',label:r.question,detail:'Answer this question in the new goal before preparing the plan.',references:[]});
 r.steps.forEach((s,i)=>{if(s.status!=='completed')items.push({id:'step:'+i,kind:'step',label:s.title,detail:s.summary||'Unfinished plan step; inspect current state before continuing.',references:s.references});});
 r.missingOutcomes.forEach((m,i)=>items.push({id:'outcome:'+i,kind:'observation',label:m.group+' result needs verification',detail:m.required,references:[]}));
 if(r.error)items.push({id:'error',kind:'error',label:'Investigate why this task stopped',detail:short(r.error,2000),references:[]});
 return {sourceId:w.id,sourceRevision:w.revision||1,fingerprint:fingerprint(w),goal:w.goal,scope:w.scope||'',items,notice:followupNotice};
}
function requirementsFor(items){
 const out={files:[],commands:[]};
 for(const i of items){if(!i.rule)continue;const rule=structuredClone(i.rule);
  if(['file','command'].includes(i.kind)){
   const list=out[i.kind==='file'?'files':'commands'],key=r=>i.kind==='file'?r.path:JSON.stringify([r.program,r.args,r.cwd]),prior=list.find(r=>key(r)===key(rule));
   if(prior&&JSON.stringify(prior)!==JSON.stringify(rule))throw new AppError('Selected items contain conflicting requirements for the same output. Choose one and review its conditions.');
   if(!prior)list.push(rule);
  }else if(['browser','window'].includes(i.kind)){if(out[i.kind]&&JSON.stringify(out[i.kind])!==JSON.stringify(rule))throw new AppError('Choose one final '+i.kind+' requirement.');out[i.kind]=rule;}
 }
 return out;
}
function historicalContext(w,items){
 const r=completionReview(w),completed=r.steps.filter(s=>s.status==='completed'),effects=w.operations.filter(o=>o.action&&!['superseded','waiting_approval'].includes(o.status));
 return {sourceId:w.id,sourceRevision:w.revision||1,observedThrough:w.updated,previousGoal:short(w.goal,2000),notice:followupNotice,
  selected:items.map(i=>({id:i.id,kind:i.kind,label:short(i.label,300),detail:short(i.detail,400),references:i.references.slice(0,4),omittedReferences:Math.max(0,i.references.length-4)})),
  completed:completed.slice(-12).map(s=>({title:short(s.title,200),assessment:short(s.summary,300),references:s.references.slice(0,4)})),
  effects:effects.slice(-16).map(o=>({id:o.id,name:o.name,status:o.status,path:short(o.expected?.path||o.result?.path||o.arguments?.path,700),url:short(o.result?.url,700),notice:'Recorded effect; check current state before any further change.'})),
  omittedCompleted:Math.max(0,completed.length-12),omittedEffects:Math.max(0,effects.length-16)};
}

// An initial inspection is required in the new journal; parent evidence cannot
// satisfy it. This is only an inspection gate, not proof of every target's state.
export function requireFollowupInspection(w,kind,payload){
 if(!w.followUp||kind==='cloud'||kind==='computer'&&['windows','browser_read','applications'].includes(payload.operation))return;
 const observed=w.operations.some(o=>!beforeCheckpoint(w,o)&&o.status==='completed'&&!o.result?.error&&(
  ['read_system_file','read_project_file','list_directory','find_files','search_system_files','inspect_desktop'].includes(o.name)||o.name==='computer_action'&&['windows','browser_read'].includes(o.arguments?.operation)));
 if(!observed)throw new AppError('Inspect the current files, page or desktop in this follow-up before proposing an action. Historical results cannot replace a fresh observation.',409);
}

export class WorkflowFollowups {
 constructor(workflows){this.workflows=workflows;this.store=workflows.store;this.locks=new Set();}
 async source(id){
  const w=await this.store.get('workflows',id);
  if(!stopped.has(w.status)||this.workflows.running.has(id)||this.workflows.reconciling.has(id)||w.operations.some(o=>['started','waiting_approval'].includes(o.status))||(await this.store.list('actions')).some(a=>a.workflow?.id===id&&['pending','running'].includes(a.status)))throw new AppError('Stop the source task and finish or dismiss pending actions before preparing a follow-up.',409);
  return w;
 }
 async choices(id){return followupChoices(await this.source(id));}
 async list(sourceId){return (await this.store.list('followups')).filter(d=>d.sourceId===sourceId&&d.status!=='discarded').map(d=>({id:d.id,status:d.status,goal:d.goal,childId:d.childId,updated:d.updated,revision:d.revision}));}
 async read(id){return this.store.get('followups',id);}
 async preview({sourceId,sourceFingerprint,selected}){
  const w=await this.source(sourceId),choice=followupChoices(w);
  if(choice.fingerprint!==sourceFingerprint)throw new AppError('The source results changed. Reload the choices and select the remaining work again.',409);
  if(!Array.isArray(selected)||!selected.length||selected.length>12||new Set(selected).size!==selected.length)throw new AppError('Select one to twelve unfinished items.');
  const items=selected.map(id=>choice.items.find(i=>i.id===id));if(items.some(i=>!i))throw new AppError('A selected result is no longer available. Reload the source results.',409);
  const requirements=await prepareRequirements(requirementsFor(items),this.workflows.actions.system),context=historicalContext(w,items);
  if(JSON.stringify(context).length>12000)throw new AppError('Selected history is too large. Choose fewer items for this follow-up.');
  const d={id:randomUUID(),childId:randomUUID(),sourceId,sourceFingerprint,revision:1,status:'draft',created:new Date().toISOString(),updated:new Date().toISOString(),context,requirements,
   goal:('Continue only this selected work:\n'+items.map(i=>'- '+short(i.label,350)).join('\n')+'\n\nInspect current state first. Preserve completed effects and verify the selected outcomes.').slice(0,6000),scope:choice.scope};
  // No model call, file-content read, desktop action or new workflow on preview.
  if(fingerprint(await this.source(sourceId))!==sourceFingerprint)throw new AppError('The source results changed while preparing this draft.',409);
  await this.store.put('followups',d);return d;
 }
 async locked(id,fn){if(this.locks.has(id))throw new AppError('This follow-up is being saved. Wait, then retry.',409);this.locks.add(id);try{return await fn();}finally{this.locks.delete(id);}}
 async child(d){try{return await this.store.get('workflows',d.childId);}catch(e){if(e.status!==404)throw e;return null;}}
 async input(data){
  const {goal,scope,requirements}=data;
  if(typeof goal!=='string'||!goal.trim()||goal.length>6000||typeof scope!=='string'||scope.length>2000)throw new AppError('Review a goal of up to 6,000 characters and context of up to 2,000 characters.');
  return {goal:goal.trim(),scope,requirements:await prepareRequirements(requirements,this.workflows.actions.system)};
 }
 save(data){return this.locked(data.id,async()=>{
  const d=await this.read(data.id);if(d.status==='discarded'||d.revision!==data.revision||await this.child(d))throw new AppError('This draft changed or already created a task. Reopen it before continuing.',409);
  const input=await this.input(data);Object.assign(d,input,{status:'draft',revision:d.revision+1,updated:new Date().toISOString()});delete d.inputHash;delete d.input;delete d.request;
  await this.store.put('followups',d);return d;
 });}
 discard({id,revision}){return this.locked(id,async()=>{const d=await this.read(id);if(d.revision!==revision||await this.child(d))throw new AppError('This draft changed or already created a task.',409);d.status='discarded';d.revision++;await this.store.put('followups',d);return {discarded:true};});}
 start(data){return this.locked(data.id,async()=>{
  const d=await this.read(data.id),hash=sha(JSON.stringify({goal:data.goal,scope:data.scope,requirements:data.requirements}));
  if(d.status==='discarded')throw new AppError('This follow-up was discarded.',409);
  const existing=await this.child(d);
  if(existing){if(d.inputHash!==hash||existing.followUp?.draftId!==d.id)throw new AppError('This draft already created a task with different inputs. Open that task.',409);if(d.status!=='created'){d.status='created';await this.store.put('followups',d);}return existing;}
  if(d.inputHash&&d.inputHash!==hash||d.revision!==data.revision)throw new AppError('The follow-up draft changed. Reopen it before preparing a plan.',409);
  if(data.acknowledge!==true)throw new AppError('Review the historical context and acknowledge that current state must be inspected.');
  const input=await this.input(data),wf=this.workflows;
  if(wf.controls.has(d.sourceId))throw new AppError('The source task is being updated. Try again.',409);
  wf.controls.add(d.sourceId);
  try{
   const check=async()=>{if(fingerprint(await this.source(d.sourceId))!==d.sourceFingerprint)throw new AppError('The source task changed. Prepare a new draft from its current results; your saved draft is retained.',409);};
   await check();Object.assign(d,input,{input,request:{goal:data.goal,scope:data.scope,requirements:data.requirements},inputHash:hash,status:'creating',updated:new Date().toISOString()});await this.store.put('followups',d);
   const child=await wf.start(input,{reservedId:d.childId,followUp:{...d.context,draftId:d.id,sourceFingerprint:d.sourceFingerprint},beforeSave:check});
   d.status='created';await this.store.put('followups',d);return child;
  }finally{wf.controls.delete(d.sourceId);}
 });}
}
