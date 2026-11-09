import {exampleLedger,compactExampleLedger} from './workflow-example-ledger.mjs';
import {AppError,sha} from './vault.mjs';
import {spanEdit,spanTool} from './workflow-span.mjs';
import {evidenceHandle,resolveEvidence} from './workflow-evidence.mjs';
import {observationNeedsFreshRead} from './workflow-tools.mjs';
import {sourceLines} from './workflow-tools.mjs';
import {expressionExamples,expressionInputs} from './repair-expression.mjs';
import {bindRepairExpression} from './repair-expression-binding.mjs';
import {copyNoBenefitReview} from './workflow-copy-no-benefit.mjs';

export const repairExpressionTool={type:'function',function:{name:'check_repair_expression',description:'Before staging a numerical repair, compare its exact old/new expression against 1–6 explicit examples from the goal/tests and edge cases. No generated code runs. Supports finite numbers, boolean conditions, + - * / %, comparisons, && || !, ternary, parentheses, Math.min/max/round/floor/ceil/abs/trunc. Inputs use flat literal names such as value.width. Expression replacement must reproduce the complete saved correction. Examples are model-supplied partial coverage, never completion evidence or approval. Unsupported expressions need normal reviewed tests.',parameters:{type:'object',properties:{repair:{type:'string'},before:{type:'string',maxLength:512,description:'Expression only, e.g. Math.max(a,b). Omit const, return, assignment and neighboring statements, even if the saved repair contains a whole line.'},after:{type:'string',maxLength:512,description:'Replacement expression only, e.g. Math.min(a,b). Its substitution must account for all saved changes on the line.'},cases:{type:'array',minItems:1,maxItems:6,items:{type:'object',properties:{inputs:{type:'object',maxProperties:16,description:'Flat literal variable names mapped to finite numbers or booleans. No arrays or nested objects.',additionalProperties:{type:['number','boolean']}},expected:{type:['number','boolean'],description:'One scalar result of this expression, never the whole function output.'}},required:['inputs','expected'],additionalProperties:false}}},required:['repair','before','after','cases'],additionalProperties:false}}};

export const repairPlanTool={type:'function',function:{name:'record_repair_plan',description:'After inspecting the relevant files and tests, record ALL currently identified small repairs together. Each item is a hypothesis grounded in an observed line, not proof. Saves a list only; does not write or approve anything. Replaces the previous list for this task revision; completed actions remain in the journal. Use propose_repair to stage each saved correction individually.',parameters:{type:'object',properties:{repairs:{type:'array',minItems:1,maxItems:8,items:spanTool.function.parameters}},required:['repairs'],additionalProperties:false}}};
export const proposeRepairTool={type:'function',function:{name:'propose_repair',description:'Stage one saved repair by its R-number for exact approval. Aurora binds it to the latest fresh complete read of that same file and copies the saved correction unchanged. Read that file first if needsFreshRead is true. Never repeats a completed or pending proposal.',parameters:{type:'object',properties:{repair:{type:'string'}},required:['repair'],additionalProperties:false}}};
const plan=w=>w.operations.findLast(o=>o.name==='record_repair_plan'&&o.status==='completed'&&o.revision===w.revision);

// Bind only the explicitly selected required file. Never infer a different
// target from a matching fragment or fall back past a failed/partial reread.
function bindRepairFile(w,item){
  if(!item||typeof item!=='object'||Array.isArray(item))throw Object.assign(new AppError('Supply a repair object.'),{repairIssue:{field:'item',code:'object_required'}});
  const {file,...rest}=item;
  if(typeof file!=='string'||!w.requirements.files.some(f=>f.path===file)){
    const allowed=w.requirements.files.map(f=>f.path);
    const detail=w.version>=31&&w.engine==='local'?` Allowed output ${allowed.length===1?'file':'files'}: ${allowed.slice(0,8).join(', ')}${allowed.length>8?', and more in outputRequirements.files':''}. Re-evaluate the defect in an allowed source file; do not copy test-helper code into it.`:'';
    throw Object.assign(new AppError('file must be an exact required output path from the tool choices; tests are supporting context, not repair targets.'+detail),{repairIssue:{field:'file',code:'output_file',...detail?{allowedOutputFiles:allowed.slice(0,8),allowedOutputCount:allowed.length}:{}}});
  }
  if(Object.hasOwn(rest,'evidence'))throw Object.assign(new AppError('Choose file only. Its current source evidence is bound automatically; omit evidence.'),{repairIssue:{field:'evidence',code:'binding_override'}});
  const read=w.operations.findLast(o=>o.name==='read_system_file'&&(o.result?.path||o.arguments?.path)===file);
  if(!read)throw Object.assign(new AppError('Read this output file completely before recording its repair: '+file),{repairIssue:{field:'file',code:'unread_source'}});
  return {file,args:{...rest,evidence:evidenceHandle(w,read.id)}};
}

// Some local replies include the unchanged preceding line in both fragments.
// Reduce only a two-line, source-matched wrapper around the exact target line;
// spanEdit still validates the resulting one-line change and its freshness.
function singleLineRepair(w,item){
  if(w.version<30||w.engine!=='local'||!Number.isInteger(item?.line)||item.line<2||typeof item.before!=='string'||typeof item.after!=='string'||item.before.length>2000||item.after.length>2000)return {item};
  const before=item.before.split('\n'),after=item.after.split('\n');
  if(before.length!==2||after.length!==2||before[0]!==after[0]||before.some(s=>s.includes('\r'))||after.some(s=>s.includes('\r')))return {item};
  const read=w.operations.find(o=>o.id===resolveEvidence(w,item.evidence)),lines=typeof read?.result?.content==='string'?sourceLines(read.result.content):[];
  const previous=lines[item.line-2]?.text,current=lines[item.line-1]?.text;
  if(previous===undefined||current===undefined||before[0].trimStart()!==previous.trimStart()||before[1].trimStart()!==current.trimStart())return {item};
  const indent=before[1].match(/^[ \t]*/)[0];
  if(after[1].match(/^[ \t]*/)[0]!==indent)return {item};
  return {item:{...item,before:before[1].slice(indent.length),after:after[1].slice(indent.length)},normalization:{kind:'unchanged_previous_line_removed',line:item.line,sourceEvidence:item.evidence,notice:'Only an identical preceding context line and shared leading indentation were removed. The changed target line still requires exact source validation, a reviewed edit and saved tests.'}};
}

// Reject a narrow local-model typo: removing one destructured callback name
// while still using that same name in the expression body. Stop at this call's
// closing parenthesis so a later expression cannot make a valid edit look
// invalid. This is not a general JavaScript scope analysis.
function callbackExpression(text,match){
  const call=match.index+match[0].indexOf('('),body=match.index+match[0].length;
  let depth=0,quote=null,escaped=false,visible='';
  for(let i=call;i<text.length;i++){
    const char=text[i];
    if(quote){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char===quote)quote=null;continue;}
    if(char==='"'||char==="'"||char==='`'){quote=char;continue;}
    if(i>=body&&char==='/')return null; // Regex, division and comments need a real parser.
    if(char==='(')depth++;
    if(char===')'&&--depth===0)return visible;
    if(i>=body)visible+=char;
  }
  return null;
}
function removedCallbackBinding(before,after){
  const pattern=/(?:\.|^)(filter|map|find|some|every|flatMap)\s*\(\s*\(\s*\[\s*([A-Za-z_$][\w$]*|)\s*,\s*([A-Za-z_$][\w$]*|)\s*\]\s*\)\s*=>/g;
  const old=[...before.matchAll(pattern)],next=[...after.matchAll(pattern)];
  if(old.length!==1||next.length!==1||old[0][1]!==next[0][1])return null;
  const names=[old[0][2],old[0][3]].filter(Boolean),remaining=[next[0][2],next[0][3]].filter(Boolean);
  const removed=names.filter(name=>!remaining.includes(name));
  if(removed.length!==1||!names.some(name=>remaining.includes(name)))return null;
  const oldBody=callbackExpression(before,old[0]),newBody=callbackExpression(after,next[0]);
  if(oldBody===null||newBody===null||newBody.trimStart().startsWith('{'))return null;
  const name=removed[0].replaceAll('$','\\$');
  const used=body=>new RegExp('(^|[^\\w$.])'+name+'(?=$|[^\\w$:])').test(body);
  return used(oldBody)&&used(newBody)?removed[0]:null;
}

export function repairFeedback(w){
  const latest=w.operations.findLast(o=>o.name==='record_repair_plan'&&o.revision===w.revision&&['completed','failed'].includes(o.status));
  if(latest?.status!=='failed'||!latest.result?.repairFeedback)return null;
  const feedback=structuredClone(latest.result.repairFeedback);
  for(const issue of feedback.issues){
    if(!issue.observation)continue;
    const index=w.operations.findLastIndex(o=>o.name==='read_system_file'&&(o.result?.path||o.arguments?.path)===issue.path),read=w.operations[index],r=read?.result;
    issue.currentSource=read?.status==='completed'&&!r?.error&&!read.arguments?.offset&&!r?.truncated&&typeof r?.content==='string'&&r.revision===sha(r.content)&&r.revision===issue.sourceRevision&&!observationNeedsFreshRead(w,index,issue.path);
  }
  return {evidence:evidenceHandle(w,latest.id),...feedback};
}

export function recordRepairPlan(w,args){
  let items=args?.repairs,inputEncoding;
  // Some local tool responses encode this one array as JSON text. Decode only
  // a bounded literal array; every existing source and scope guard still runs.
  if(w.version>=19&&w.engine!=='chatgpt'&&typeof items==='string'&&items.length<=16000){
    try{items=JSON.parse(items);inputEncoding='json_string';}catch{}
  }
  if(args&&Object.keys(args).length===1&&Array.isArray(items)&&items.length===0){
    const remaining=repairPlanContext(w)?.repairs.filter(r=>!['edit_applied','awaiting_action'].includes(r.state))||[];
    if(remaining.length===1&&copyNoBenefitReview(w,remaining[0]))return {repairs:[],notice:'The sole remaining candidate was withdrawn after its reviewed copy changed no passing saved test outcome. Earlier completed edits and copy results remain in the journal. Run the original saved check through exact approval; this withdrawal is not completion proof.'};
  }
  if(!args||Object.keys(args).some(k=>k!=='repairs')||!Array.isArray(items)||!items.length||items.length>8)throw new AppError('Supply repairs: an array of 1–8 observed fragment corrections.');
  const issues=[],matchedItems=[];
  const repairs=items.map((original,i)=>{
    let item=original,file;
    try{
    let normalization;
    if(w.version>=8){const bound=bindRepairFile(w,item);file=bound.file;item=bound.args;({item,normalization}=singleLineRepair(w,item));}
    if(typeof item?.evidence!=='string'||!/^E[1-9]\d?$/.test(item.evidence))throw new AppError(`Repair ${i+1}: evidence must be ONE exact E-number of the SOURCE FILE TO EDIT, for example E2. Put explanations in reason, never in evidence. Tests are supporting context, not the source to edit.`);
    if(typeof item?.reason!=='string'||item.reason.length>600)throw Object.assign(new AppError('Keep each repair reason within 600 characters.'),{repairIssue:{field:'reason',code:'reason_limit'}});
    let patch,lineCorrection;
    try{patch=spanEdit(w,item);}catch(e){
      // Local models sometimes count a displayed source line one place off.
      // Resolve only a unique exact fragment on an adjacent observed line.
      // spanEdit still validates the corrected line and all edit constraints.
      if(w.version<20||w.engine==='chatgpt'||e.repairIssue?.code!=='fragment_absent'||e.repairIssue.message?.includes('The after fragment is present')||e.repairIssue.matchesTruncated||e.repairIssue.matchingLines?.length!==1||Math.abs(e.repairIssue.matchingLines[0]-item.line)!==1)throw e;
      const requestedLine=item.line;item={...item,line:e.repairIssue.matchingLines[0]};
      patch=spanEdit(w,item);lineCorrection={requestedLine,matchedLine:item.line};
    }
    if(w.version>=32&&w.engine==='local'){
      const removed=removedCallbackBinding(item.before,item.after);
      if(removed)throw Object.assign(new AppError(`The changed callback removes ${removed} from its parameters but still uses ${removed} in the expression. Keep that binding or correct the use before saving this repair; no code ran.`),{repairIssue:{field:'after',code:'callback_binding_removed',removedName:removed}});
    }
    if(!w.requirements.files.some(f=>f.path===patch.path))throw new AppError('Record repairs only for required output files.');
    matchedItems.push(i+1);
    const read=w.operations.find(o=>o.id===resolveEvidence(w,item.evidence));
    return {id:`R${w.operations.length}.${i+1}`,path:patch.path,revision:patch.revision,...item,...normalization?{inputNormalization:normalization}:{},...lineCorrection?{lineCorrection}:{},...w.version>=8?{binding:'required_file'}:{},...w.version>=9?{expressionBinding:bindRepairExpression({content:read.result.content,line:item.line,before:item.before,after:item.after})}:{}};
    }catch(e){
      const read=w.operations.find(o=>o.id===resolveEvidence(w,item?.evidence)),path=file||read?.result?.path;
      if(w.version<8)throw Object.assign(new AppError(`Repair ${i+1}${item?.evidence?', '+item.evidence:''}${path?' ('+path+')':''}: ${e.message}`,e.status),e.repairIssue?{repairIssue:e.repairIssue}:{});
      const index=w.operations.indexOf(read),r=read?.result;
      const fresh=read?.status==='completed'&&!r?.error&&!read.arguments?.offset&&!r?.truncated&&typeof r?.content==='string'&&r.revision===sha(r.content)&&!observationNeedsFreshRead(w,index,r.path);
      const line=fresh&&Number.isInteger(item?.line)&&item.line>0?sourceLines(r.content)[item.line-1]:null;
      const observation=line?{line:item.line,text:line.text.slice(0,320),truncated:line.text.length>320}:undefined;
      issues.push({item:i+1,...path?{path}:{},...item?.evidence?{evidence:item.evidence}:{},field:'item',code:'invalid_repair',...observation?{observation,sourceRevision:r.revision}:{},...e.repairIssue,message:e.message});
      return null;
    }
  });
  if(issues.length)throw Object.assign(new AppError('Repair list was not saved. '+issues.map(i=>`Item ${i.item}: ${i.field}${i.code==='indentation'?' (omit leading spaces or tabs from before and after)':''}`).join('; ')+'. See repairFeedback for the specific errors. Correct the listed fields and resubmit the complete list; no repair was partially accepted.'),{repairFeedback:{matchedItems,issues,notice:'Source-matched items are structurally valid hypotheses, not verified diagnoses. No new list or action was saved; the previous list and all completed effects remain. Correct the failed fields without changing unrelated items.'}});
  if(new Set(repairs.map(r=>r.path+'\0'+r.line+'\0'+r.before)).size!==repairs.length)throw new AppError('Do not record the same source fragment twice.');
  return {repairs,...inputEncoding?{inputEncoding}:{},notice:'Proposed diagnoses only. Each repair still needs exact action approval, fresh checks and final readback. This list does not establish coverage of the whole goal.'};
}

export function repairPlanContext(w,{briefChecks=false}={}){
  const saved=plan(w);if(!saved)return null;
  return {evidence:evidenceHandle(w,saved.id),notice:saved.result.notice,repairs:saved.result.repairs.map(r=>{
    const attempts=w.operations.filter(o=>o.repair===r.id&&o.revision===w.revision),completed=attempts.find(o=>o.status==='completed'&&o.expected),pending=attempts.find(o=>['waiting_approval','started','interrupted'].includes(o.status));
    const readIndex=w.operations.findLastIndex(o=>o.name==='read_system_file'&&(o.result?.path||o.arguments?.path)===r.path),read=w.operations[readIndex];
    const fresh=read?.status==='completed'&&!read.result?.error&&!read.arguments?.offset&&!read.result?.truncated&&typeof read.result?.content==='string'&&read.result.revision===sha(read.result.content)&&!observationNeedsFreshRead(w,readIndex,r.path);
    const checks=w.operations.filter(o=>o.name==='check_repair_expression'&&o.status==='completed'&&o.revision===w.revision&&o.result?.repair===r.id),last=checks.at(-1);
    const expressionCheck=last?{evidence:evidenceHandle(w,last.id),...last.result,currentSource:!!fresh&&read.result.revision===last.result.sourceRevision,hasFailedExamples:checks.some(o=>!o.result.examplesMatch)}:null;
    const ledger=exampleLedger(w,r);
    if(expressionCheck&&ledger)expressionCheck.hasFailedExamples=ledger.failed>0;
    const latest=w.operations.findLast(o=>o.name==='check_repair_expression'&&o.revision===w.revision&&o.arguments?.repair===r.id&&['failed','completed'].includes(o.status));
    const expressionFeedback=latest?.status==='failed'&&latest.result?.expressionFeedback?{evidence:evidenceHandle(w,latest.id),...structuredClone(latest.result.expressionFeedback),currentSource:!!fresh&&read.result.revision===latest.result.expressionFeedback.sourceRevision}:null;
    if(briefChecks&&expressionCheck){delete expressionCheck.cases;delete expressionCheck.notice;delete expressionCheck.before;delete expressionCheck.after;}
    return {...r,...r.expressionBinding?{expressionBinding:{...structuredClone(r.expressionBinding),currentSource:!!fresh&&read.result.revision===r.revision}}:{},state:completed?'edit_applied':pending?'awaiting_action':attempts.length?'proposal_failed':'remaining',action:completed?.action||pending?.action,currentRead:fresh?evidenceHandle(w,read.id):null,needsFreshRead:!fresh,changedSinceEdit:completed&&fresh?completed.expected.revision!==read.result.revision:null,expressionCheck,expressionFeedback,...ledger?{exampleLedger:briefChecks?compactExampleLedger(ledger):ledger}:{}};
  })};
}

function currentRepair(w,args){
  if(!args||Object.keys(args).some(k=>k!=='repair')||typeof args.repair!=='string')throw new AppError('Supply only the repair R-number. Its source read is bound automatically.');
  const item=repairPlanContext(w)?.repairs.find(r=>r.id===args.repair);
  if(!item){
    if(w.version>=10){
      const remaining=repairPlanContext(w)?.repairs.filter(r=>!['edit_applied','awaiting_action'].includes(r.state)).map(r=>r.id)||[];
      throw new AppError('Unknown repair ID. '+(remaining.length?'Available remaining IDs: '+remaining.join(', ')+'.':'No unapplied repair is saved.')+(w.version>=17?' Existing IDs still contain their ORIGINAL saved correction. Explaining a new fix does not change them. To revise a diagnosis, call record_repair_plan with the new exact correction FIRST; then use its returned ID. propose_repair cannot revise a repair.':'')+' Do not invent an ID or repeat completed edits. Diagnose any uncovered work from current source and checks, then record its remaining corrections.');
    }
    throw new AppError('Choose a repair from the current saved repair list.');
  }
  if(['edit_applied','awaiting_action'].includes(item.state))throw new AppError('This repair already has a completed or pending action. Inspect remaining work; do not replay it.',409);
  if(!item.currentRead)throw new AppError('Read the current file before staging this repair: '+item.path,409);
  return {item,patch:spanEdit(w,{evidence:item.currentRead,line:item.line,before:item.before,after:item.after,reason:item.reason})};
}

export function proposeRepair(w,args){
  const {item,patch}=currentRepair(w,args);
  if(copyNoBenefitReview(w,item))throw new AppError('The latest reviewed copy changed no passing saved test outcome after an earlier edit. Reconsider this candidate with record_repair_plan; withdraw a sole unsupported remaining correction with repairs:[], or inspect a truly untested requirement through files tools. The copy alone does not support another repair edit.',409);
  if(item.exampleLedger?.failed||item.expressionCheck?.hasFailedExamples)throw new AppError(w.version>=11?'This saved repair failed an expression example. Retained examples cannot be dropped by replacing a list. Correct the diagnosis, or request_help for the user to review a mistaken example in Planned repairs. No file was changed.':'This saved repair failed an expression example. Inspect the results and record a corrected repair list before staging it. Passing a different example cannot erase the failure.',409);
  return patch;
}

export function checkRepairExpression(w,args){
  let item,patch,read,line;
  try{
    const automatic=w.version>=9,fields=automatic?['repair','cases']:['repair','before','after','cases'];
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!fields.includes(k)))throw Object.assign(new AppError(automatic?'Supply only repair and explicit cases. Expressions are bound to the saved change; before/after overrides are not accepted.':'Supply repair, exact before/after expressions and explicit cases.'),{expressionIssue:{field:'arguments',code:'argument_shape'}});
    if(!automatic)for(const field of ['before','after'])if(typeof args[field]!=='string')throw Object.assign(new AppError(field+' must be a literal expression string.'),{expressionIssue:{field,code:'expression_text'}});
    ({item,patch}=currentRepair(w,{repair:args.repair}));
    read=w.operations.find(o=>o.id===resolveEvidence(w,item.currentRead));
    line=sourceLines(read.result.content)[item.line-1].text;
    let before=args.before,after=args.after,column;
    if(automatic){
      const bound=bindRepairExpression({content:read.result.content,line:item.line,before:item.before,after:item.after}),saved=item.expressionBinding;
      if(bound.status!=='bound')throw Object.assign(new AppError(bound.message),{expressionIssue:{field:'repair',code:bound.code}});
      if(saved?.status!=='bound'||saved.before!==bound.before||saved.after!==bound.after||saved.column!==bound.column)throw Object.assign(new AppError('The surrounding expression changed since this repair was saved. Inspect the current source and record a new repair; example inputs were not remapped.'),{expressionIssue:{field:'repair',code:'binding_changed'}});
      ({before,after,column}=bound);
    }
    const start=automatic?column-1:line.indexOf(before),fragment=line.indexOf(item.before);
    const changed=line.slice(0,fragment)+item.after+line.slice(fragment+item.before.length);
    // Checking only part of a repair cannot hide a second changed expression.
    if(!before||start<0||!automatic&&line.indexOf(before,start+1)>=0||/[\w$.]/.test(line[start-1]||'')||/[\w$.]/.test(line[start+before.length]||''))throw Object.assign(new AppError("before must be one unique complete expression on the saved repair's observed line. Copy that expression, not a calculation from another line or file."),{expressionIssue:{field:'before',code:'source_expression'}});
    if(line.slice(0,start)+after+line.slice(start+before.length)!==changed)throw Object.assign(new AppError('The exact expression replacement must reproduce the WHOLE saved correction on its observed line. Do not omit other changed expressions or match part of a name/number.'),{expressionIssue:{field:'after',code:'incomplete_replacement'}});
    const cases=expressionExamples(before,after,args.cases);
    return {repair:item.id,path:item.path,line:item.line,sourceRevision:patch.revision,sourceEvidence:item.currentRead,before,after,...automatic?{binding:'saved_expression'}:{},...expressionInputs(before,after),cases,caseCount:cases.length,matched:cases.filter(c=>c.matches).length,examplesMatch:cases.every(c=>c.matches),notice:'Model-supplied examples only: expected values and inputs need review against the user goal and tests. Introduced inputs are names absent from the old expression, not a scope analysis; inspect their initialization in the source. This checks arithmetic for the exact replacement, not units, whole-program behavior or complete correctness. No file was changed. Exact approval, saved tests and fresh readback still apply.'};
  }catch(e){
    if(!(e instanceof AppError))throw e;
    const issue=e.expressionIssue||{field:e.repairIssue?.field||'repair',code:e.repairIssue?.code||'unavailable_repair'};
    e.expressionFeedback={repair:typeof args?.repair==='string'?args.repair.slice(0,80):null,...item?{path:item.path,...patch?{sourceRevision:patch.revision,sourceEvidence:item.currentRead}:{},...line!==undefined?{observation:{line:item.line,text:line.slice(0,320),truncated:line.length>320},savedCorrection:{before:item.before.slice(0,320),after:item.after.slice(0,320),truncated:item.before.length>320||item.after.length>320}}:{}}:{},...issue,message:e.message,notice:'Argument correction only. No example verdict, file change or approval was recorded. Keep the saved diagnosis and unrelated examples unless the source or goal requires revising them. Nothing is flattened, coerced or inferred automatically.'};
    throw e;
  }
}
