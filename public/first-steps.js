import {guardPlanningDraft} from './planning-draft-guard.js';
import {stepHistoryHTML,outcomeDraftsHTML} from './step-outcomes.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
const prefix=vault=>'aurora-first-step:'+vault+':';
const contextValid=c=>c&&typeof c.date==='string'&&typeof c.timezone==='string'&&(c.task===null||c.task&&typeof c.task.text==='string'&&typeof c.task.path==='string')&&(c.project===null||c.project&&typeof c.project.path==='string'&&typeof c.project.title==='string'&&typeof c.project.excerpt==='string')&&Array.isArray(c.execution)&&c.execution.every(e=>e&&typeof e.id==='string'&&typeof e.detail==='string')&&Array.isArray(c.dependencyReasons)&&c.dependencyReasons.every(s=>typeof s==='string');
export const validFirstStepDraft=d=>d?.version===1&&uuid(d.taskId)&&typeof d.text==='string'&&['manual','aurora'].includes(d.mode)&&typeof d.baseRevision==='string'&&(!d.sourceOutcomeId||uuid(d.sourceOutcomeId))&&contextValid(d.context)&&(!d.pending||['save','execution'].includes(d.pending.kind)&&uuid(d.pending.input?.requestId)&&d.pending.input.taskId===d.taskId&&typeof d.pending.input.revision==='string'&&d.pending.input.acknowledge===true&&(d.pending.kind!=='save'||typeof d.pending.input.text==='string'&&['manual','aurora'].includes(d.pending.input.mode)));
const valid=validFirstStepDraft;
export function firstStepDraftState(storage,vault,taskId){
 try{const raw=storage.getItem(prefix(vault)+taskId);if(raw===null)return null;let d;try{d=JSON.parse(raw);}catch{}return !valid(d)||d.taskId!==taskId?{unreadable:true}:{pending:!!d.pending,text:d.text.slice(0,180)};}catch{return {unavailable:true};}
}
export function firstStepsBriefing(cards,error,vault,escape){
 const rows=new Map((cards||[]).map(c=>[c.taskId,c]));let localError=false;
 try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(!k.startsWith(prefix(vault)))continue;const id=k.slice(prefix(vault).length);if(!uuid(id))continue;let d;try{d=JSON.parse(localStorage.getItem(k));}catch{}rows.set(id,{...rows.get(id),taskId:id,taskText:rows.get(id)?.taskText||d?.context?.task?.text||'Saved task',draft:true,pending:!!d?.pending,unreadable:!valid(d)});}}catch{localError=true;}
 return '<section id="briefing-first-steps" class="focus-card"><h3>Your first steps</h3>'+(error?'<p class="planner-warning">'+escape(error)+'</p>':'')+(rows.size?[...rows.values()].map(c=>'<p><strong>'+escape(c.taskText)+'</strong> · '+(c.unreadable?'Draft needs attention':c.pending?'Reply needs checking':c.draft?'Unfinished edit':escape(c.date)+' · '+(c.mode==='manual'?'My own step':'With Aurora'))+(c.openOutcomes?' · '+c.openOutcomes+' unresolved outcome(s)':'')+' <button data-first-step="'+escape(c.taskId)+'">Open first step</button></p>').join(''):'<p>Choose a focus task, then write a small first step.</p>')+outcomeDraftsHTML(vault,escape)+(localError?'<p class="planner-warning">Local first-step drafts could not be read.</p>':'')+'<button data-outcome-plan>Plan from unfinished steps / reopen draft</button><button data-focus-manage>Open today’s focus</button></section>';
}
export function createFirstSteps({api,escape,body,open,run,openExecution}){
 let vaultPromise;
 const keyFor=async id=>prefix(await (vaultPromise??=api('/api/bootstrap').then(b=>b.vault).catch(e=>{vaultPromise=null;throw e;})))+id;
 const $=s=>body.querySelector(s),get=id=>api('/api/first-step?taskId='+encodeURIComponent(id));
 function write(key,d){try{localStorage.setItem(key,JSON.stringify(d));}catch{throw Error('The first-step draft could not be stored. Keep this text and retry before closing.');}}
 function clear(key,id){let d;try{d=JSON.parse(localStorage.getItem(key));}catch{}if(d?.pending?.input?.requestId===id)localStorage.removeItem(key);}
 const task=t=>t?escape(t.text)+' · '+escape(t.planDate||'Unscheduled')+' · '+t.duration+' min estimate · '+(t.done?'Marked complete':'Open'):'Task unavailable';
 const context=c=>'<p><strong>Task:</strong> '+task(c.task)+'</p><p>'+escape(c.date)+' · '+escape(c.timezone)+' · '+escape(c.choice?.action||'No focus chosen')+'</p>'+(c.project?'<p><strong>Project:</strong> '+escape(c.project.title)+(c.project.missing?' · Missing or archived':'')+'</p><p class="summary-prose">'+escape(c.project.excerpt)+'</p>':'<p>No linked project.</p>')+(c.execution||[]).map(e=>'<p>Attempt: '+escape(e.detail)+'</p>').join('')+(c.dependencyReasons||[]).map(s=>'<p class="planner-warning">'+escape(s)+'</p>').join('');
 const links=r=>(r.context.task?'<button data-briefing-note data-note="'+escape(r.context.task.path)+'">Open task note</button>':'')+(r.context.project&&!r.context.project.missing?'<button data-briefing-note data-note="'+escape(r.context.project.path)+'">Open project note</button>':'')+'<button data-focus-plan-task="'+escape(r.taskId)+'">Review today’s focus</button>';
 function pending(d,key){
  const p=d.pending;body.innerHTML='<h2>Recover first-step request</h2><p class="summary-prose">'+escape(d.text)+'</p><p>The '+(p.kind==='save'?'card save':'execution draft')+' reply was not confirmed. Retry this exact request or check its receipt before editing. Later saved changes are preserved.</p><button id="first-step-retry">Retry exact request</button><button id="first-step-check">Check receipt and compare current details</button>';open();
  const finish=async result=>{clear(key,p.input.requestId);if(p.kind==='execution'){await show(d.taskId);await openExecution(result.id||result.executionId);}else await show(d.taskId);};
  $('#first-step-retry').onclick=run(async()=>finish(await api('/api/first-step/'+p.kind,p.input)));
  $('#first-step-check').onclick=run(async()=>{const result=await api('/api/first-step/status',{kind:p.kind,input:p.input});if(result.recorded)return finish(result);delete d.pending;write(key,d);await show(d.taskId);});
 }
 async function send(d,key,kind,input){d.pending={kind,input};write(key,d);pending(d,key);const r=await api('/api/first-step/'+kind,input);clear(key,input.requestId);await show(d.taskId);if(kind==='execution')await openExecution(r.id);}
 function saved(r,key){
  const c=r.card;body.innerHTML='<h2>Your first step</h2><p>'+escape(c.context.task.text)+' · Saved '+escape(c.context.date)+' · '+(c.mode==='manual'?'I’ll do this myself':'Work with Aurora')+'</p><p id="first-step-saved-text" class="summary-prose">'+escape(c.text)+'</p>'+(r.changed?'<p class="planner-warning">Context changed since this card was saved. Compare the saved and current details before using it.</p><details><summary>Context when saved</summary>'+context(c.context)+'</details>':'')+'<details open><summary>Current context</summary>'+context(r.context)+'</details><p>'+escape(r.detail)+'</p>'+links(r)+'<button id="first-step-edit">Edit / review first step</button>'+(c.mode==='aurora'&&!r.context.execution.length?'<button id="first-step-execution" '+(r.changed||!r.canPrepare?'disabled':'')+'>Review execution draft</button>':'')+r.context.execution.map(e=>'<button data-first-step-attempt="'+escape(e.id)+'">Open existing execution draft or attempt</button>').join('')+'<p>'+ (c.mode==='manual'?'This is your own next step. Saving it does not start an agent or mark the planner task complete.':'An existing draft or attempt keeps its own wording. A new draft uses only your reviewed first-step text; its plan still needs review.')+'</p>'+'<button data-focus-session-start="'+escape(r.taskId)+'">Focus session for this step</button>'+stepHistoryHTML(r,escape);open();
  $('#first-step-edit').onclick=run(async()=>{const d={version:1,taskId:r.taskId,text:c.text,mode:c.mode,baseRevision:r.revision,context:r.context};write(key,d);edit(r,d,key);});
  for(const b of body.querySelectorAll('[data-first-step-attempt]'))b.onclick=run(()=>openExecution(b.dataset.firstStepAttempt));
  if($('#first-step-execution'))$('#first-step-execution').onclick=run(async()=>{
   body.innerHTML='<h2>Prepare an execution draft</h2><p class="summary-prose">'+escape(c.text)+'</p>'+context(r.context)+'<p>Aurora will create an editable execution draft for this step. Review its workspace and success conditions before asking her to prepare a plan.</p><button id="first-step-prepare">Create reviewed draft</button><button data-first-step="'+escape(r.taskId)+'">Back to card</button>';open();
   $('#first-step-prepare').onclick=run(()=>send({version:1,taskId:r.taskId,text:c.text,mode:c.mode,baseRevision:r.revision,context:r.context},key,'execution',{requestId:crypto.randomUUID(),taskId:r.taskId,revision:r.revision,acknowledge:true}));
  });
 }
 function edit(r,d,key){
  const stale=d.baseRevision!==r.revision;
  body.innerHTML='<h2>Write a manageable first step</h2>'+ (d.sourceOutcomeId?'<p>Follow-on from a recorded outcome. The earlier step and its reports stay in history.</p>':'')+'<p>'+escape(r.context.task?.text||d.context.task?.text||'Task unavailable')+'</p><label>What will you do first?<textarea id="first-step-text" rows="4" maxlength="3000" placeholder="For example: open my lecture notes and solve the first practice question."></textarea></label><label>Who will do it? <select id="first-step-mode"><option value="manual">I’ll do this myself</option><option value="aurora">Work with Aurora</option></select></label><p id="first-step-draft-state" role="status">Draft stays on this desktop until you save the card.</p>'+(stale?'<section id="first-step-stale" class="planner-warning"><h3>Details changed while this draft was saved</h3><details open><summary>When this draft was prepared</summary>'+context(d.context)+'</details><button id="first-step-use-current">Use current context, keep my wording</button></section>':'')+'<details open><summary>Current context</summary>'+context(r.context)+'</details><p>'+escape(r.detail)+'</p>'+(!r.canSave?'<p class="planner-warning">Choose this unique, unfinished task as today’s focus before saving a new card.</p>':'')+links(r)+(r.card?'<button data-step-outcome="'+escape(r.taskId)+'" data-step-sequence="'+r.card.sequence+'">Review saved step / outcome</button>':'')+'<button id="first-step-review" '+(stale||!r.canSave?'disabled':'')+'>Review first step</button><button id="first-step-refresh">Reload current details</button><button id="first-step-discard">Discard local edit</button>';open();
  $('#first-step-text').value=d.text;$('#first-step-mode').value=d.mode;
  const capture=()=>{d.text=$('#first-step-text').value;d.mode=$('#first-step-mode').value;write(key,d);};
  guardPlanningDraft(body,$('#first-step-text'),capture);
  const persist=()=>{try{capture();$('#first-step-draft-state').textContent='Draft kept on this desktop.';}catch(e){$('#first-step-draft-state').textContent=e.message;}};
  $('#first-step-text').oninput=persist;$('#first-step-mode').onchange=persist;
  $('#first-step-refresh').onclick=run(async()=>{capture();await show(r.taskId);});
  $('#first-step-discard').onclick=run(async()=>{if(!confirm('Discard this local edit? The last saved first-step card will be kept.'))return;localStorage.removeItem(key);await show(r.taskId);});
  if(stale)$('#first-step-use-current').onclick=run(async()=>{capture();d.baseRevision=r.revision;d.context=r.context;write(key,d);edit(r,d,key);});
  $('#first-step-review').onclick=run(async()=>{
   capture();if(!d.text.trim())throw Error('Write one concrete first step.');body.innerHTML='<h2>Review your first step</h2><p class="summary-prose">'+escape(d.text)+'</p><p>'+escape(d.mode==='manual'?'I’ll do this myself':'Work with Aurora')+'</p>'+context(r.context)+'<p>Save this card with the context above. Task dates, completion and current attempts stay unchanged.</p><button id="first-step-save">Save reviewed first step</button><button data-first-step="'+escape(r.taskId)+'">Back to editing</button>';open();
   $('#first-step-save').onclick=run(()=>send(d,key,'save',{requestId:crypto.randomUUID(),taskId:r.taskId,revision:d.baseRevision,text:d.text,mode:d.mode,...(d.sourceOutcomeId?{sourceOutcomeId:d.sourceOutcomeId}:{}),acknowledge:true}));
  });
 }
 async function show(taskId){
  const key=await keyFor(taskId),raw=localStorage.getItem(key);let d;
  if(raw!==null){try{d=JSON.parse(raw);}catch{}if(!valid(d)||d.taskId!==taskId){body.innerHTML='<h2>First-step draft needs attention</h2><p>The local edit could not be read. It has been kept.</p><pre class="summary-prose">'+escape(raw)+'</pre><button id="first-step-reset">Discard unreadable local draft</button>';open();$('#first-step-reset').onclick=run(async()=>{if(!confirm('Discard this unreadable local draft? Saved cards remain unchanged.'))return;localStorage.removeItem(key);await show(taskId);});return;}if(d.pending)return pending(d,key);}
  const r=await get(taskId);if(!d&&r.card)return saved(r,key);d??={version:1,taskId,text:'',mode:'manual',baseRevision:r.revision,context:r.context};edit(r,d,key);
 }
 async function followOn(taskId,outcomeId){
  const key=await keyFor(taskId);if(localStorage.getItem(key)!==null){body.innerHTML='<h2>A first-step edit is already open</h2><p>Your existing edit has been kept. Finish or explicitly discard it before preparing this follow-on step.</p><button data-first-step="'+escape(taskId)+'">Open existing edit</button>';open();return;}
  const r=await get(taskId),outcome=r.outcomes.find(o=>o.id===outcomeId);if(!outcome?.canFollowOn)throw Error('This outcome already has a follow-on step or has been superseded. Reopen the current card.');
  const d={version:1,taskId,text:'',mode:'manual',baseRevision:r.revision,context:r.context,sourceOutcomeId:outcomeId};write(key,d);edit(r,d,key);
 }
 body.addEventListener('click',e=>{const b=e.target.closest('[data-step-follow-on]');if(b)run(()=>followOn(b.dataset.stepTask,b.dataset.stepFollowOn))();});
 body.addEventListener('click',e=>{const b=e.target.closest('[data-first-step]');if(b)run(()=>show(b.dataset.firstStep))();});
 return {show};
}
