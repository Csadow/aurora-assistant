import {requirementStatus} from './workflow-requirements.mjs';
import {unverifiedWrites} from './workflow-health.mjs';
import {verifyOutcome,missingOutcomes} from './workflow-evidence.mjs';
import {sha} from './vault.mjs';

const success=o=>o?.status==='completed'&&!o.result?.error;
const short=(s,max=600)=>String(s??'').slice(0,max);
const reference=(w,id,role)=>{
  const index=w.operations.findIndex(o=>o.id===id);if(index<0)return null;
  const o=w.operations[index];return {id:o.id,label:'E'+(index+1),role,at:o.finished||o.started||null};
};
const refs=(w,entries)=>entries.map(([id,role])=>reference(w,id,role)).filter(Boolean);
function observed(check,op){
  if(!op)return null;const r=op.result||{};
  if(check.kind==='file')return {path:r.path,revision:r.revision,bytes:typeof r.content==='string'?Buffer.byteLength(r.content):null};
  if(check.kind==='command')return {code:r.code,stopped:!!r.stopped,truncated:!!r.truncated};
  if(check.kind==='browser')return {url:r.url,title:r.title};
  const match=r.windows?.find(v=>v.title===check.title&&(!check.app||v.app===check.app));
  return match?{id:match.id,title:match.title,app:match.app}:null;
}

// Pure journal projection: never reads current files/screens, calls a model or
// executes a check. The completion snapshot is saved with the terminal state.
function build(w,mode){
  const writes=new Map();for(const o of w.operations)if(success(o)&&o.expected)writes.set(o.expected.path,o);
  const requirements=w.requirements||{files:[],commands:[]};
  const checks=requirementStatus(w).map(c=>{
    const op=w.operations.find(o=>o.id===c.evidence),write=c.kind==='file'?writes.get(c.path):null;
    const rule=c.kind==='file'?requirements.files.find(f=>f.path===c.path):c.kind==='command'?{program:c.program,args:c.args,cwd:c.cwd,outputIncludes:c.outputIncludes}:requirements[c.kind];
    return {...c,origin:'requirement',rule:structuredClone(rule),observed:observed(c,op),references:refs(w,[[c.evidence,'Observation'],[write?.id,'Recorded write']])};
  });
  const unverified=new Set(unverifiedWrites(w).map(x=>x.path));
  for(const [path,write] of writes){
    if(checks.some(c=>c.kind==='file'&&c.path===path))continue;
    const read=w.operations.findLast(o=>success(o)&&o.name==='read_system_file'&&o.result?.path===path),r=read?.result;
    const passed=!unverified.has(path)&&r&&!r.truncated&&typeof r.content==='string'&&r.revision===sha(r.content);
    const c={kind:'file',origin:'write',path,passed:!!passed,detail:passed?'Fresh complete readback matches the recorded write hash.':'Recorded write still needs fresh complete readback.'};
    checks.push({...c,rule:null,observed:passed?observed(c,read):null,references:refs(w,[[passed?read.id:null,'Readback'],[write.id,'Recorded write']])});
  }
  const outcomes=w.operations.filter(o=>success(o)&&o.name==='verify_outcome'&&o.result?.verified).map(o=>{
    let passed=false,detail;try{const r=verifyOutcome(w,o.result);passed=true;detail=r.warning||'This recorded literal check still passes against the journal.';}catch(e){detail=short(e.message);}
    return {kind:o.result.kind,expected:o.result.expected,passed,detail,references:refs(w,[[o.id,'Check'],[o.result.evidence,'Observation']])};
  });
  const failures=w.operations.filter(o=>['failed','interrupted'].includes(o.status)||o.result?.error).map(o=>({name:o.requestedTool||o.name,status:o.status,detail:short(o.result?.error||(Number.isInteger(o.result?.code)?'Process exit code '+o.result.code:o.status==='interrupted'?'The operation was interrupted; its effect may need verification.':'The operation did not complete successfully.')),references:refs(w,[[o.id,'Earlier attempt']])}));
  const pending=w.operations.filter(o=>['started','waiting_approval'].includes(o.status)).map(o=>({name:o.requestedTool||o.name,status:o.status,references:refs(w,[[o.id,'Pending operation']])}));
  const assessments=[...writes.values()].filter(o=>o.sourceReview?.claims?.length).map(o=>({path:o.expected.path,claims:o.sourceReview.claims.map(c=>({kind:c.kind,text:c.text,limits:c.limits})),references:refs(w,[[o.id,'Saved draft assessment']])}));
  return structuredClone({version:1,mode,workflow:w.id,revision:w.revision||1,status:w.status,at:mode==='recorded'?w.completed:mode==='legacy'?w.completed||w.updated:w.updated,
    checks,outcomes,failures,pending,assessments,missingOutcomes:w.version>=2?missingOutcomes(w):[],
    userObservations:w.operations.filter(o=>success(o)&&o.name==='user_verification').map(o=>({text:short(o.result?.content,2000),references:refs(w,[[o.id,'User observation']])})),
    steps:w.steps.map(s=>({title:s.title,status:s.status,summary:s.summary||'',references:refs(w,(s.evidence||[]).map(id=>[id,'Cited by Aurora']))})),
    error:w.status==='completed'?null:w.error||null,question:w.status==='completed'?null:w.question||null,
    notice:mode==='recorded'?'Saved with task completion. These are the observations recorded then; current files and applications may have changed.':mode==='legacy'?'Reconstructed from an older task journal. No completion snapshot was saved at the time; this is not a new verification.':'Results so far from the saved journal. This task is not completed. Earlier observations may need to be refreshed.',
    limits:'Checks establish only their stated conditions. They do not prove factual quality, full goal satisfaction or document contents from a window label. Aurora’s conclusions and source assessments still need judgment.'});
}
export function captureCompletion(w){
  if(w.status!=='completed'||!w.steps.length||w.current!==w.steps.length||w.steps.some(s=>s.status!=='completed'))throw new Error('A completion snapshot needs a completed plan.');
  return build(w,'recorded');
}
export function completionReview(w){
  if(w.status==='completed'&&w.completionReceipt?.version===1&&w.completionReceipt.workflow===w.id&&w.completionReceipt.revision===(w.revision||1))return structuredClone(w.completionReceipt);
  return build(w,w.status==='completed'?'legacy':'progress');
}
