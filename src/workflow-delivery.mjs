import {AppError,sha} from './vault.mjs';
import {mayChangeFiles} from './workflow-requirements.mjs';
import {evidenceHandle,missingOutcomes} from './workflow-evidence.mjs';
import {critiqueRequired} from './workflow-critique.mjs';

// Narrow completion checkpoint for a single sourced-note deliverable. It says
// what was saved/read, not that the goal is semantically proven. Revisions and
// intervening effects invalidate it; no old source observations are refreshed.
export function sourcedDelivery(w){
 const files=w.requirements?.files||[];
 if(w.requirements?.browser||w.requirements?.window||w.version<5||files.length!==1||!files[0].sourceReview||w.requirements.commands?.length||w.steps?.length!==1||missingOutcomes(w).length)return null;
 const path=files[0].path,at=w.operations.findLastIndex(o=>o.name==='propose_file_edit'&&o.arguments?.path===path&&o.action),op=w.operations[at];
 if(!op||op.status!=='completed'||op.revision!==w.revision||!op.sourceReview||critiqueRequired(w,path)&&op.draftCritique?.verdict!=='ready'||op.expected?.revision!==sha(op.arguments.content))return null;
 const later=w.operations.slice(at+1);
 if(later.some(o=>mayChangeFiles(o)||o.name==='reopen_sourced_output'&&o.status==='completed'&&o.revision===w.revision))return null;
 const read=later.findLast(o=>o.name==='read_system_file'&&(o.result?.path||o.arguments?.path)===path&&o.status!=='started'&&!o.result?.checkpointNoEffect);
 if(read&&(read.status!=='completed'||read.revision!==w.revision||read.result?.error||read.result?.truncated||read.result?.offset||read.arguments?.offset||read.result?.revision!==op.expected.revision||sha(read.result?.content||'')!==op.expected.revision))return null;
 return {path,phase:read?'ready':'readback',saved:evidenceHandle(w,op.id),...(read?{evidence:evidenceHandle(w,read.id)}:{}),notice:read?'The approved draft was saved and read back unchanged. Finish with this evidence if it answers the goal. If you found a concrete material defect, call reopen_sourced_output with the readback evidence and correction needed. Do not rewrite merely to summarize or refresh source reads.':'The reviewed draft was saved. Read ONLY this output next, then finish if it satisfies the goal. Source reads are not needed to renew the review of an already completed write.'};
}
export function deliveryTools(w,tools){
 const d=sourcedDelivery(w);if(!d)return tools;
 const keep=d.phase==='ready'&&w.version>=36?['finish_step','ask_user','request_help']:['read_system_file','finish_step','ask_user','request_help'];
 const filtered=tools.filter(t=>keep.includes(t.function.name)).map(t=>t.function.name==='read_system_file'?{...t,function:{...t.function,parameters:{...t.function.parameters,properties:{...t.function.parameters.properties,path:{type:'string',enum:[d.path]}}}}}:t);
 if(d.phase==='ready')filtered.push({type:'function',function:{name:'reopen_sourced_output',description:'Reopen a saved and read-back note only to correct a concrete material defect. Supply its exact readback evidence and explain what is wrong and how it must change. Never reopen merely to summarize, restyle or refresh source evidence. This records a reason; it grants no write approval. Read sources again before a new reviewed draft.',parameters:{type:'object',properties:{evidence:{type:'string',enum:[d.evidence]},issue:{type:'string',minLength:20,maxLength:1000}},required:['evidence','issue'],additionalProperties:false}}});
 return filtered;
}
export function guardDelivery(w,name,args){
 const d=sourcedDelivery(w);if(!d)return;
 if(name==='reopen_sourced_output'){
  if(d.phase!=='ready'||args.evidence!==d.evidence||typeof args.issue!=='string'||args.issue.trim().length<20||args.issue.length>1000||Object.keys(args).some(k=>!['evidence','issue'].includes(k)))throw new AppError('Reopening needs the current complete readback evidence and a concrete correction (20–1,000 characters).');
  return;
 }
 if(name==='read_system_file'&&d.phase==='ready'&&w.version>=36)throw Object.assign(new AppError('The approved output was read back unchanged. Finish with savedOutput.evidence, or use reopen_sourced_output with that evidence and a concrete defect. Repeating the same read creates no new evidence.'),{checkpointNoEffect:true});
 if(!['read_system_file','finish_step','ask_user','request_help'].includes(name)||name==='read_system_file'&&args.path!==d.path)throw new AppError('The reviewed output is already saved. Complete file readback checks its exact bytes; a separate verify_outcome text check is unnecessary here. Read it back and finish, or reopen_sourced_output with its readback evidence and a concrete defect before making another draft.');
}
