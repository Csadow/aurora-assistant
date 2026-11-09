import {citationDraft,citationSources} from './workflow-citations.mjs';
import {verificationFloor,beforeCheckpoint} from './workflow-checkpoint.mjs';
import {sourceQuoteDraft} from './workflow-source-quotes.mjs';
import {filePatch} from './file-patch.mjs';
import {formattedFile,textMismatches} from './workflow-requirements.mjs';
import {AppError,sha} from './vault.mjs';
import {evidenceHandle,resolveEvidence,evidenceView} from './workflow-evidence.mjs';

export const lineTool={type:'function',function:{name:'propose_line_edit',description:'Replace ONE existing line from a complete file observation. Use this when the whole line must change; prefer propose_span_edit for a small fragment within it. Supply its evidence handle, 1-based line number, and the replacement line body WITHOUT leading spaces/tabs or a newline. The original indentation, line endings and all other lines stay unchanged. To change indentation, use propose_file_patch. The exact edit still needs approval.',parameters:{type:'object',properties:{evidence:{type:'string'},line:{type:'integer',minimum:1},text:{type:'string',maxLength:4000},reason:{type:'string'}},required:['evidence','line','text','reason'],additionalProperties:false}}};
export function sourceLines(content){
  const lines=[];let start=0;
  for(const match of content.matchAll(/\r\n|\r|\n/g)){lines.push({start,end:match.index,text:content.slice(start,match.index),ending:match[0]});start=match.index+match[0].length;}
  if(start<content.length)lines.push({start,end:content.length,text:content.slice(start),ending:''});
  return lines;
}
export function lineEdit(w,args){
  if(!args||Object.keys(args).some(k=>!['evidence','line','text','reason'].includes(k))||!Number.isInteger(args.line)||typeof args.text!=='string'||args.text.length>4000||(/[\r\n\0]/.test(args.text)||/^[ \t]/.test(args.text)))throw new AppError('Use evidence, a 1-based integer line, text containing one replacement line body without leading spaces/tabs or a newline, and reason. Original indentation is retained; use propose_file_patch to change it.');
  const read=w.operations.find(o=>o.id===resolveEvidence(w,args.evidence)),r=read?.result;
  if(read?.name!=='read_system_file'||read.status!=='completed'||r?.truncated||typeof r?.content!=='string'||r.revision!==sha(r.content))throw new AppError('Choose a complete, unredacted file observation from this task before editing a line.');
  const lines=sourceLines(r.content),line=lines[args.line-1];
  if(!line)throw new AppError('That line is not present in this observation. Use a numbered line from the file read.');
  const replacement=line.text.match(/^[ \t]*/)[0]+args.text;
  if(line.text===replacement)throw new AppError('The observed line already matches. No edit was proposed. Verify current state or choose the line that actually needs a change.');
  // Grow exact original context until duplicate lines are unambiguous. The
  // existing literal-patch validator and filesystem revision check still apply.
  let lo=args.line-1,hi=lo,before,after;
  while(true){
    const start=lines[lo].start,end=lines[hi].end+lines[hi].ending.length;before=r.content.slice(start,end);after=r.content.slice(start,line.start)+replacement+r.content.slice(line.end,end);
    if(before&&r.content.indexOf(before)===start&&r.content.indexOf(before,start+1)<0)break;
    if(lo===0&&hi===lines.length-1)throw new AppError('This line cannot be selected uniquely. Use a complete file edit.');
    if(lo>0)lo--;if(hi<lines.length-1)hi++;
  }
  return {path:r.path,revision:r.revision,edits:[{before,after}],reason:args.reason};
}
export function savedCheck(w,args){
  if(!args||Object.keys(args).some(k=>!['check','reason'].includes(k))||typeof args.check!=='string'||!/^C[1-2]$/.test(args.check))throw new AppError('Use only check (C1 or C2) and reason. Saved executable, arguments and folder cannot be overridden.');
  const rule=w.requirements?.commands[Number(args.check.slice(1))-1];if(!rule)throw new AppError('Choose a check listed in this task’s current output requirements.');
  const {program,args:arguments_,cwd}=rule;return {program,args:arguments_,cwd,reason:args.reason};
}
export function argumentFeedback(definition){
  if(!definition)return undefined;
  const p=definition.function.parameters;
  return {tool:definition.function.name,fields:Object.fromEntries(Object.entries(p.properties).map(([k,v])=>[k,{type:v.type,...v.enum?{allowed:v.enum}:{},...Object.fromEntries(['minimum','maximum','minLength','maxLength','minItems','maxItems'].filter(key=>v[key]!==undefined).map(key=>[key,v[key]]))}])),required:p.required,notice:'Use these exact field names. Arrays are JSON arrays, not strings. Rejected proposals performed no action.'};
}
export function modelObservation(w,o){
  if(w.version>=18&&beforeCheckpoint(w,o))return {...evidenceView(w,o).result,historical:true,notice:"Recorded before interruption; not current verification. Observe current state without repeating completed effects."};
  if(o.name!=='read_system_file'||typeof o.result?.content!=='string'||o.result.truncated||o.arguments?.offset)return evidenceView(w,o).result;
  const {content,...metadata}=o.result;
  return {...metadata,evidence:evidenceHandle(w,o.id),numberedLines:sourceLines(content).map((l,i)=>`${i+1}: ${l.text}`).join('\n'),notice:'Line numbers are display labels, not source text. Use the current repair/edit tools for a small exact correction; preserve neighboring expressions and original indentation.'};
}

export function historyArguments(w,op){
  const args=op.requestedArguments??op.arguments;
  if(w.version>=17&&op.name==='record_repair_plan'&&op.status==='failed'&&op.result?.repairFeedback&&Array.isArray(args?.repairs))return {rejectedItems:args.repairs.slice(0,8).map((r,i)=>({item:i+1,file:typeof r?.file==='string'?r.file:undefined,line:r?.line,beforeCharacters:typeof r?.before==='string'?r.before.length:null,afterCharacters:typeof r?.after==='string'?r.after.length:null})),notice:'Display receipt of a rejected list, not replayable tool arguments. Complete attempted fragments/reasons remain in the journal. Use the observed lines and field-specific repairFeedback to correct only the requested behavior.'};
  if(op.requestedTool==='propose_sourced_file')return {path:op.arguments?.path,reason:op.arguments?.reason,claimCount:Array.isArray(op.claimInputs)?op.claimInputs.length:0,notice:'The original claim list is saved in the journal. Refer to current sourceClaimReview and repairableDraft; do not repeat old source handles or malformed arguments.'};
  return args&&typeof args==='object'&&!Array.isArray(args)?(op.requestedArguments??evidenceView(w,op).arguments):{};
}

export function observationNeedsFreshRead(w,index,path){
  return index<verificationFloor(w)||w.operations.slice(index+1).some(o=>o.action&&o.status!=='superseded'&&(o.name==='propose_command'||o.name==='propose_file_edit'&&(o.expected?.path||o.arguments?.path)===path||o.name==='computer_action'&&['click','type_text','key'].includes(o.arguments?.operation)));
}

// Keep one real read/tool exchange for model continuity. Older source belongs in
// the bounded file view; stale or failed latest reads cannot revive old content.
export function recentProjectRead(w){
  const seen=new Set();
  for(let i=w.operations.length-1;i>=0&&seen.size<6;i--){
    const o=w.operations[i];if(o.name!=='read_system_file')continue;
    const path=o.result?.path||o.arguments?.path;if(typeof path!=='string'||seen.has(path))continue;seen.add(path);
    if(o.status==='completed'&&!o.result?.error&&typeof o.result?.content==='string'&&!observationNeedsFreshRead(w,i,path))return o;
  }
  return null;
}

// Keep bounded source observations available after action/error chatter displaces
// them from recentEvidence. These are recorded excerpts, never fresh permission.
export function fileObservations(w,budget=3600,{numbered=false,maxExcerpt=600,omitRead}={}){
  const seen=new Set(),observations=[];let remaining=budget-2;
  for(let i=w.operations.length-1;i>=0&&seen.size<6;i--){
    const op=w.operations[i];if(op.name!=='read_system_file')continue;
    const path=op.result?.path||op.arguments?.path;if(typeof path!=='string'||seen.has(path))continue;seen.add(path);
    const stale=observationNeedsFreshRead(w,i,path);
    const available=op.status==='completed'&&!op.result?.error&&typeof op.result?.content==='string';
    const labelled=numbered&&available&&!op.arguments?.offset;
    const content=available?(labelled?sourceLines(op.result.content).map((l,n)=>`${n+1}: ${l.text}`).join('\n'):op.result.content):'';
    const inHistory=op.id===omitRead;
    const item={evidence:evidenceHandle(w,op.id),...(w.version>=16&&available&&labelled&&!op.result.truncated?{totalLines:sourceLines(op.result.content).length}:{}),path,revision:op.result?.revision,needsFreshRead:stale||!available,...available&&!stale?{...inHistory?{inRecentToolResult:true,truncated:!!op.result.truncated||JSON.stringify({evidenceId:evidenceHandle(w,op.id),status:op.status,result:modelObservation(w,op)}).length>4500}:{excerpt:content.slice(0,maxExcerpt),truncated:!!op.result.truncated||content.length>maxExcerpt},...numbered?{numbered:labelled,offset:op.arguments?.offset||0,nextOffset:op.result.nextOffset}:{}}:{}};
    while(JSON.stringify(item).length+1>remaining&&item.excerpt?.length){item.excerpt=item.excerpt.slice(0,-32);item.truncated=true;}
    const size=JSON.stringify(item).length+1;if(size>remaining)continue;remaining-=size;observations.unshift(item);
  }
  return observations;
}

export function repairableDraft(w){
  const op=w.operations.findLast(o=>o.name==='propose_file_edit'&&o.status==='failed'&&!o.action&&o.revision===w.revision&&o.result?.requirementFailures&&typeof o.arguments?.content==='string');
  if(!op)return null;const rule=w.requirements?.files.find(r=>r.path===op.arguments.path);
  if(!rule||Object.hasOwn(rule,'exactText')||w.operations.slice(w.operations.indexOf(op)+1).some(o=>o.name==='propose_file_edit'&&o.arguments?.path===op.arguments.path&&(o.action||o.status==='failed'&&o.result?.requirementFailures&&typeof o.arguments?.content==='string')))return null;
  return op;
}
export const draftRepairNames=new Set(['propose_sourced_file','compare_source_values','propose_draft_repair','propose_required_quotes','propose_citation_repair','propose_formatted_file','propose_file_edit','propose_draft_patch','read_system_file','read_note','search_memory','search_project','read_project_file','ask_user','request_help','verify_outcome']);
export function draftRepairTool(w){
  const op=repairableDraft(w);if(!op)return [];
  return [{type:'function',function:{name:'propose_draft_patch',description:'Repair the latest REJECTED output draft with small exact replacements, preserving its other text and corrected citations. Read repairableDraft in context. This edits a draft, not a file; it creates a NEW exact action review only if all requirements pass. Saved formatting rules apply; edits=[] repairs only formatting. Use this instead of regenerating a long document for a small mismatch.',parameters:{type:'object',properties:{draft:{type:'string',enum:[evidenceHandle(w,op.id)]},edits:{type:'array',minItems:0,maxItems:8,items:{type:'object',properties:{before:{type:'string',description:'Exact unique passage in the rejected draft'},after:{type:'string',description:'Corrected passage, including exact punctuation'}},required:['before','after'],additionalProperties:false}},reason:{type:'string'}},required:['draft','edits','reason'],additionalProperties:false}}}];
}

export function patchDraft(w,args){
  const op=repairableDraft(w);
  if(!args||Object.keys(args).some(k=>!['draft','edits','reason'].includes(k))||typeof args.reason!=='string'||!op||resolveEvidence(w,args.draft)!==op.id)throw new AppError('Choose the latest repairable draft from this task revision. Accepted, pending, older and exact-text drafts cannot be repaired with this tool.');
  if(!Array.isArray(args.edits))throw new AppError('Supply edits as an array; use [] to apply saved formatting only.');
  const patched=args.edits.length?filePatch(op.arguments.content,args.edits):{content:op.arguments.content};
  return formattedFile(w,{path:op.arguments.path,content:patched.content,reason:args.reason});
}

export function citationRepair(w){
  const draft=repairableDraft(w);if(!draft)return null;
  const result=citationDraft(w,draft.arguments);return result.changes.length?{draft,...result}:null;
}
export function citationRepairTool(w){
  const repair=citationRepair(w);if(!repair)return [];
  return [{type:'function',function:{name:'propose_citation_repair',description:'Stage the available citationRepairs for this rejected draft. Converts only existing local references to Markdown links using explicitly required destinations and files already read. Preserves surrounding prose. Nothing is saved until exact review; it does not establish factual accuracy.',parameters:{type:'object',properties:{draft:{type:'string',enum:[evidenceHandle(w,repair.draft.id)]},reason:{type:'string'}},required:['draft','reason'],additionalProperties:false}}}];
}
export function repairCitations(w,args){
  const repair=citationRepair(w);
  if(!args||Object.keys(args).some(k=>!['draft','reason'].includes(k))||typeof args.reason!=='string'||!args.reason.trim()||!repair||resolveEvidence(w,args.draft)!==repair.draft.id)throw new AppError('Choose the current rejected draft with available citation repairs. No content, path or source overrides are accepted.');
  return {...repair,arguments:formattedFile(w,{...repair.arguments,reason:args.reason})};
}

export function requiredQuoteRepair(w){
  const draft=repairableDraft(w);if(!draft)return null;
  const rule=w.requirements.files.find(r=>r.path===draft.arguments.path);
  const result=sourceQuoteDraft(draft.arguments,rule.requiredText,citationSources(w,draft.arguments.path));
  return result.quotes.length?{draft,...result}:null;
}
export function requiredQuoteTool(w){
  const repair=requiredQuoteRepair(w);if(!repair)return [];
  return [{type:'function',function:{name:'propose_required_quotes',description:'Append the requiredSourceExcerpts listed in context to this rejected draft. Copies only missing required literals exactly from their uniquely matching observed local source, with source links. Keeps the draft body. No content or path arguments. This is a new draft for exact review, not a fact check; all saved requirements still apply.',parameters:{type:'object',properties:{draft:{type:'string',enum:[evidenceHandle(w,repair.draft.id)]},reason:{type:'string'}},required:['draft','reason'],additionalProperties:false}}}];
}
export function repairRequiredQuotes(w,args){
  const repair=requiredQuoteRepair(w);
  if(!args||Object.keys(args).some(k=>!['draft','reason'].includes(k))||typeof args.reason!=='string'||!args.reason.trim()||!repair||resolveEvidence(w,args.draft)!==repair.draft.id)throw new AppError('Choose the current rejected draft with available required source excerpts. No content, path or source overrides are accepted.');
  return {...repair,arguments:formattedFile(w,{...repair.arguments,reason:args.reason})};
}

export function combinedDraftRepair(w){
  const draft=repairableDraft(w);if(!draft)return null;
  if(w.requirements.files.find(r=>r.path===draft.arguments.path)?.sourceReview&&!draft.sourceReview)return null;
  const rule=w.requirements.files.find(r=>r.path===draft.arguments.path),citations=citationDraft(w,draft.arguments);
  const excerpts=sourceQuoteDraft(citations.arguments,rule.requiredText,citationSources(w,draft.arguments.path));
  const args=formattedFile(w,excerpts.arguments);
  if(args.content===draft.arguments.content)return null;
  return {draft,arguments:args,changes:citations.changes,quotes:excerpts.quotes,remainingFailures:textMismatches(rule,args.content)};
}
export function combinedRepairTool(w){
  const repair=combinedDraftRepair(w);if(!repair)return [];
  return [{type:'function',function:{name:'propose_draft_repair',description:'Apply the listed availableRepair to the current rejected draft in one proposal: fix eligible local links, append missing required source quotations, and apply saved whitespace rules. Retains the existing body. Supply ONLY draft and reason; no content/path needed. Every requirement must still pass and the exact write needs approval. This does not correct factual conclusions.',parameters:{type:'object',properties:{draft:{type:'string',enum:[evidenceHandle(w,repair.draft.id)]},reason:{type:'string'}},required:['draft','reason'],additionalProperties:false}}}];
}
export function repairDraft(w,args){
  const repair=combinedDraftRepair(w);
  if(!args||Object.keys(args).some(k=>!['draft','reason'].includes(k))||typeof args.reason!=='string'||!args.reason.trim()||!repair||resolveEvidence(w,args.draft)!==repair.draft.id)throw new AppError('Choose the latest rejected draft with an available repair. No content, path or source overrides are accepted.');
  return {...repair,arguments:{...repair.arguments,reason:args.reason}};
}
