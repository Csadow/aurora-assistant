import {sha} from './vault.mjs';
import {recoveryContext} from './workflow-recovery.mjs';

// One bounded, literal before/after view. This is a read-only review snapshot,
// never completion evidence or a claim that all observed changes are ours.
export function changeExcerpt(before,after){
  if(before===after)return 'No text changes.';
  const a=(before??'').split('\n'),b=(after??'').split('\n');let start=0,endA=a.length,endB=b.length;
  while(start<endA&&start<endB&&a[start]===b[start])start++;
  while(endA>start&&endB>start&&a[endA-1]===b[endB-1]){endA--;endB--;}
  const from=Math.max(0,start-2),context=a.slice(from,start).map(l=>'  '+l);
  const lines=[`@@ old line ${start+1}, new line ${start+1} @@`,...context,...a.slice(start,endA).map(l=>'- '+l),...b.slice(start,endB).map(l=>'+ '+l),...a.slice(endA,endA+2).map(l=>'  '+l)];
  return lines.join('\n').slice(0,16000)+(lines.join('\n').length>16000?'\n[Preview shortened; inspect full files before approving.]':'');
}
export async function workflowChanges(service,id){
  const w=await service.store.get('workflows',id),actions=await service.store.list('actions'),groups=new Map();
  for(const op of w.operations){
    const a=actions.find(a=>a.id===op.action&&a.workflow?.id===w.id&&a.workflow.operation===op.id);
    if(!a||a.kind!=='write'||a.status==='dismissed')continue;
    const path=a.payload.path;let g=groups.get(path);
    if(!g){g={path,before:a.payload.before,actions:[],pending:[],lastCompleted:null};groups.set(path,g);}
    g.actions.push({id:a.id,status:a.status,at:a.updated,reason:a.reason||a.payload.reason,requestedTool:op.requestedTool||op.name});
    if(a.status==='completed')g.lastCompleted={id:a.id,revision:sha(a.payload.content)};
    if(a.status==='pending')g.pending.push({id:a.id,expires:a.expires,revision:a.payload.revision,diff:changeExcerpt(a.payload.before,a.payload.content)});
  }
  const files=[];
  for(const g of groups.values()){
    let observation;
    try{
      await service.projectWorkspaces?.target(w.project,g.path);
      const r=await service.actions.system.read(g.path);
      const complete=!r.truncated&&r.revision===sha(r.content);
      observation={at:new Date().toISOString(),revision:r.revision,complete,changedSinceLastEdit:g.lastCompleted?g.lastCompleted.revision!==r.revision:null,diff:complete?changeExcerpt(g.before,r.content):null,notice:complete?undefined:'The current file could not be shown completely or contains redacted text. Inspect it in your editor.'};
    }catch(e){observation={at:new Date().toISOString(),complete:false,error:e.message};}
    files.push({path:g.path,baseline:g.before===null?'File absent before the first proposal':'Text before the first proposal',actions:g.actions,pending:g.pending.map(p=>({...p,stale:observation.complete?p.revision!==observation.revision:null})),observation});
  }
  return {id:w.id,revision:w.revision,at:new Date().toISOString(),files,diagnosticCheck:recoveryContext(w),generationFailures:w.generationFailures||[],toolFormatFailures:w.toolFormatFailures||[],notice:'Review snapshot only; it does not satisfy task checks. Current changes may include edits by commands or other applications. Each pending action still needs its own approval.'};
}
