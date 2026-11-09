import {AppError,sha} from './vault.mjs';
import {resolveEvidence} from './workflow-evidence.mjs';
import {lineEdit,sourceLines,observationNeedsFreshRead} from './workflow-tools.mjs';

export const spanTool={type:'function',function:{name:'propose_span_edit',description:'Replace ONE exact fragment within ONE observed source line, retaining everything outside that fragment, including other expressions on the same line. Prefer this for a small expression/operator fix. Use the complete current read’s E-number, 1-based line, exact before fragment, corrected after fragment, and reason grounded in the observed defect. The fragment must occur exactly once on that line. No regex or global replacement. This only stages an exact edit for approval; it does not establish correctness.',parameters:{type:'object',properties:{evidence:{type:'string'},line:{type:'integer',minimum:1},before:{type:'string',minLength:1,maxLength:2000},after:{type:'string',maxLength:2000},reason:{type:'string'}},required:['evidence','line','before','after','reason'],additionalProperties:false}}};

export function spanEdit(w,args){
  const fail=(field,code,message,extra={},status=400)=>{throw Object.assign(new AppError(message,status),{repairIssue:{field,code,message,...extra}});};
  if(!args||typeof args!=='object'||Array.isArray(args))fail('item','object_required','Supply one repair object with the named fields.');
  const extras=Object.keys(args).filter(k=>!['evidence','line','before','after','reason'].includes(k));
  if(extras.length)fail('item','unknown_fields','Unexpected fields: '+extras.join(', ')+'. Use only the named repair fields.');
  if(!Number.isInteger(args.line)||args.line<1)fail('line','positive_integer','line must be a positive 1-based integer, not a string or a range.');
  for(const field of ['before','after']){
    const value=args[field];
    if(typeof value!=='string'||field==='before'&&!value)fail(field,'text_required',field+' must be '+(field==='before'?'nonempty ':'')+'literal source text.');
    if(value.length>2000)fail(field,'text_limit',field+' exceeds 2,000 characters. Select a smaller exact fragment.');
    if(/[\r\n]/.test(value))fail(field,'multiple_lines',field+' contains a line break. A fragment repair changes ONE observed line. Keep the intended correction on that line; use the file tools only if the goal requires a multi-line change.');
    if(value.includes('\0')||Buffer.from(value).toString('utf8')!==value)fail(field,'invalid_text',field+' contains a NUL or invalid Unicode; copy valid literal source text.');
  }
  if(typeof args.reason!=='string'||!args.reason.trim())fail('reason','reason_required','reason must explain the observed defect in nonempty text.');
  if(args.before===args.after)fail('after','unchanged','before and after are identical. No correction was supplied; keep before as observed and provide a different intended after value.');
  const index=w.operations.findIndex(o=>o.id===resolveEvidence(w,args.evidence)),read=w.operations[index],r=read?.result;
  if(read?.name!=='read_system_file'||read.status!=='completed'||read.result?.error||read.arguments?.offset||r?.truncated||typeof r?.content!=='string'||r.revision!==sha(r.content))fail('evidence','incomplete_source','Choose a complete, unredacted file observation from this task before editing a fragment.');
  if(observationNeedsFreshRead(w,index,r.path))fail('evidence','stale_source','Read the current file after the latest action or continuation checkpoint before proposing a fragment edit.',{},409);
  const lines=sourceLines(r.content),line=lines[args.line-1];
  if(!line)fail('line','missing_line',`Line ${args.line} is absent; this observation has ${lines.length} lines. Use the actual numbered source line.`);
  const observation={line:args.line,text:line.text.slice(0,320),truncated:line.text.length>320};
  const start=line.text.indexOf(args.before);
  if(start<0){
    const matches=lines.flatMap((l,i)=>l.text.includes(args.before)?[i+1]:[]);
    fail('before','fragment_absent','The before fragment is not present exactly on that line. '+(args.after&&line.text.includes(args.after)?'The after fragment is present: check whether before/after were reversed. Nothing was swapped.':'Copy the literal observed source, without display line numbers.'),{observation,...matches.length?{matchingLines:matches.slice(0,4),matchesTruncated:matches.length>4}:{}},409);
  }
  if(line.text.indexOf(args.before,start+1)>=0)fail('before','ambiguous_fragment','The before fragment appears more than once on that line. Include enough of the intended expression to make it unique.',{observation},409);
  const indent=line.text.match(/^[ \t]*/)[0];
  if(start<indent.length)fail('before','indentation','The before fragment includes leading indentation. Remove those spaces or tabs from both before and after, then retry the same repair tool with the complete list. Aurora preserves the original indentation. Use file patching only if the indentation itself must change.',{observation});
  const replacement=line.text.slice(0,start)+args.after+line.text.slice(start+args.before.length);
  return lineEdit(w,{evidence:args.evidence,line:args.line,text:replacement.slice(indent.length),reason:args.reason});
}
