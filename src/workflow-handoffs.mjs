import {randomUUID} from 'node:crypto';
import {AppError,markdown,sha,slug} from './vault.mjs';
import {unverifiedWrites} from './workflow-health.mjs';
import {missingOutcomes,evidenceHandle} from './workflow-evidence.mjs';

const fingerprint=w=>sha(JSON.stringify(w));
const sourceFingerprint=w=>fingerprint({id:w.id,revision:w.revision,goal:w.goal,scope:w.scope,status:w.status,steps:w.steps,current:w.current,operations:w.operations,requirements:w.requirements,directives:w.directives});
export class WorkflowHandoffs {
  constructor(workflows){this.workflows=workflows;this.store=workflows.store;this.vault=workflows.assistant.vault;}
  async source(id){
    const w=await this.store.get('workflows',id);
    if(this.workflows.running.has(id)||!['completed','cancelled','paused','needs_help'].includes(w.status)||(await this.store.list('actions')).some(a=>a.workflow?.id===id&&['pending','running'].includes(a.status)))throw new AppError('Stop the source task and finish or dismiss its pending actions before preparing a handoff.',409);
    if(unverifiedWrites(w).length||missingOutcomes(w).length||w.operations.some(o=>['started','waiting_approval','interrupted'].includes(o.status)))throw new AppError('Verify the source task’s effects before making a handoff. Its unresolved actions cannot transfer to another task.',409);
    if(!w.operations.some(o=>o.status==='completed'&&!['finish_step','ask_user','request_help'].includes(o.name)))throw new AppError('Collect observations before preparing a project handoff.');
    return w;
  }
  async draft(sourceId){
    const w=await this.source(sourceId),existing=(await this.store.list('handoffs')).find(h=>h.sourceId===sourceId&&['draft','saving'].includes(h.status));
    if(existing&&existing.sourceRevision===sourceFingerprint(w))return {...existing,draftRevision:fingerprint(existing)};
    const observed=w.operations.filter(o=>o.status==='completed'&&!o.result?.error&&['read_system_file','verify_outcome','user_verification'].includes(o.name)).slice(-12).map(o=>`- ${evidenceHandle(w,o.id)} (${o.id}): ${JSON.stringify(o.name==='read_system_file'?{path:o.result.path,revision:o.result.revision,truncated:o.result.truncated,observed:o.finished}:o.result).slice(0,650)}`).join('\n');
    const body=[`## Previous goal\n${w.goal}`,`## Results to review\n${w.steps.filter(s=>s.status==='completed').map(s=>'- '+s.title+': '+(s.summary||'')).join('\n')||'No completed steps.'}`,
      `## Observed evidence\n${observed||'See the original task for full observations.'}`,
      `## Remaining work\n${w.steps.filter(s=>s.status!=='completed').map(s=>'- '+s.title+' — '+s.check).join('\n')||'The previous task finished. Describe the next goal when starting a new task.'}`,
      `## Notes for the next session\nReview and edit this handoff. Step summaries are Aurora’s assessments. Previous observations may be stale: inspect current files and apps before acting. No approvals, budgets, output requirements or completion evidence transfer.`,
      `Source task: ${w.id}\nSource state: ${w.status}\nObserved through: ${w.updated}`].join('\n\n').slice(0,12000);
    const h={id:randomUUID(),sourceId,sourceRevision:sourceFingerprint(w),created:new Date().toISOString(),status:'draft',title:slug(w.goal.slice(0,70))+' handoff',body,project:w.project?.notePath||''};
    await this.store.put('handoffs',h);return {...h,draftRevision:fingerprint(h)};
  }
  async save({sourceId,handoffId,draftRevision,title,body,project=''}){
    if(this.workflows.controls.has(sourceId))throw new AppError('This task is being updated. Try again.',409);
    this.workflows.controls.add(sourceId);
    try{
      const h=await this.store.get('handoffs',handoffId);
      if(h.sourceId!==sourceId)throw new AppError('This handoff belongs to another task.',409);
      if(typeof title!=='string'||!title.trim()||title.length>100||typeof body!=='string'||!body.trim()||body.length>12000||typeof project!=='string')throw new AppError('Review a title (up to 100 characters) and handoff text (up to 12,000 characters).');
      const inputHash=sha(JSON.stringify({title,body,project}));
      if(['saving','saved'].includes(h.status)){
        if(inputHash!==h.inputHash)throw new AppError('This handoff save already started with different text. Open the saved note or prepare a new handoff.',409);
        if(h.status==='saved')return this.read(h.id);
      }else{
        if(draftRevision!==fingerprint(h))throw new AppError('The handoff draft changed. Reload it before saving.',409);
        const w=await this.source(sourceId);if(h.sourceRevision!==sourceFingerprint(w))throw new AppError('The source task changed. Prepare a new handoff from its current evidence.',409);
        let related='';if(project){const n=await this.vault.read(project);if(['draft','journal','archived'].includes(n.status))throw new AppError('Link a confirmed project or reference note.');related=`\n\nRelated project: [[${n.path.slice(0,-3)}]]`;}
        h.title=title;h.body=body;h.project=project;h.path=`20 Projects/Handoffs/${slug(title)} ${h.id.slice(0,8)}.md`;
        h.content=markdown(title,body+related+`\n\nSource task: ${sourceId}`,{status:'reference',kind:'handoff',source:`workflow:${sourceId}`,handoff:h.id});
        h.inputHash=inputHash;h.status='saving';await this.store.put('handoffs',h);
      }
      // Persist the reviewed payload first. A retry after restart can finish a
      // note save, but can neither overwrite an external edit nor start a task.
      let note;try{note=await this.vault.read(h.path);}catch(e){if(e.status!==404)throw e;}
      if(note&&note.revision!==sha(h.content))throw new AppError('The handoff note changed outside this save. It has not been overwritten.',409);
      if(!note)note=await this.vault.save(h.path,h.content,null);
      h.status='saved';h.noteRevision=note.revision;h.updated=new Date().toISOString();await this.store.put('handoffs',h);return this.read(h.id);
    }finally{this.workflows.controls.delete(sourceId);}
  }
  async read(id){
    const h=await this.store.get('handoffs',id);if(h.status!=='saved')throw new AppError('Save and review this handoff before using it.',409);
    const n=await this.vault.read(h.path);
    if(n.kind!=='handoff'||['draft','journal','archived'].includes(n.status)||n.content.length>16000)throw new AppError('Use an active handoff note of at most 16,000 characters.');
    return {id:h.id,sourceId:h.sourceId,sourceRevision:h.sourceRevision,path:h.path,title:n.title,revision:n.revision,content:n.content,created:h.created};
  }
  async list(){
    const result=[];for(const h of (await this.store.list('handoffs')).filter(h=>h.status==='saved').slice(0,60))try{const n=await this.read(h.id);result.push({id:n.id,sourceId:n.sourceId,path:n.path,title:n.title,revision:n.revision});}catch{}
    return result;
  }
  async bind(id,revision){
    if(!id){if(revision!==undefined)throw new AppError('Choose the handoff again.');return null;}
    const h=await this.read(id);if(h.revision!==revision)throw new AppError('The handoff note changed. Reload and review it before preparing the plan.',409);
    const w=await this.source(h.sourceId);if(sourceFingerprint(w)!==h.sourceRevision)throw new AppError('The source task changed after this handoff. Prepare a new handoff from its current evidence.',409);
    return {...h,warning:'Reviewed historical context, not current evidence or permission. Inspect current state and use only this new task’s goal and approvals for actions.'};
  }
}
