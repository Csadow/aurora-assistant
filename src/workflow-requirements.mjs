import {linkedSources} from './workflow-source-links.mjs';
import {verificationFloor,beforeCheckpoint} from './workflow-checkpoint.mjs';
import {AppError,sha} from './vault.mjs';
import {prepareDesktopRequirements,desktopRequirementStatus} from './workflow-desktop-requirements.mjs';

export const hasRequirements=w=>!!(w.requirements?.files.length||w.requirements?.commands.length||w.requirements?.browser||w.requirements?.window);
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k));
const ok=o=>o.status==='completed'&&!o.result?.error;
const sameCommand=(a,b)=>a?.program===b.program&&a.cwd===b.cwd&&JSON.stringify(a.args)===JSON.stringify(b.args);

export function textMismatches(rule,text){
  const failures=[];
  if(Object.hasOwn(rule,'exactText')&&text!==rule.exactText){
    const expected=Buffer.from(rule.exactText),actual=Buffer.from(text);let at=0;while(at<Math.min(expected.length,actual.length)&&expected[at]===actual[at])at++;
    failures.push(`Exact text differs at UTF-8 byte ${at+1}: expected ${expected.length} bytes, received ${actual.length}.`);
  }
  if(rule.finalNewline==='required'&&!text.endsWith('\n'))failures.push('Missing required final newline (LF or CRLF). Encode a final LF as \\n inside the JSON content string before its closing quote.');
  if(rule.finalNewline==='forbidden'&&/[\r\n]$/.test(text))failures.push('A final newline is forbidden.');
  if(rule.lineEndings==='lf'&&text.includes('\r'))failures.push('LF line endings required; carriage return found.');
  if(rule.lineEndings==='crlf'&&/\r(?!\n)|(?<!\r)\n/.test(text))failures.push('CRLF line endings required; bare LF or CR found.');
  for(const snippet of rule.requiredText||[])if(!text.includes(snippet))failures.push(`Missing required text: ${JSON.stringify(snippet)}`);
  return failures;
}

// Only the authenticated workflow form sets these rules. The model receives them
// as fixed task conditions; neither a plan nor a skill can silently rewrite them.
export async function prepareRequirements(input,system){
  if(input===undefined)return {files:[],commands:[]};
  if(!keys(input,['files','commands','browser','window'])||!Array.isArray(input.files)||!Array.isArray(input.commands)||input.files.length>4||input.commands.length>2||JSON.stringify(input).length>8000)throw new AppError('Use at most four output files, two check commands, one browser page and one window, within 8,000 characters.');
  const desktop=prepareDesktopRequirements(input);
  const files=[],commands=[];
  for(const r of input.files){
    if(!keys(r,['path','exactText','finalNewline','lineEndings','requiredText','sourceReview','draftCritique'])||!['any','required','forbidden'].includes(r.finalNewline)||!['any','lf','crlf'].includes(r.lineEndings)||Object.hasOwn(r,'exactText')&&(typeof r.exactText!=='string'||r.exactText.length>4000))throw new AppError('Choose valid file requirements; exact text can be empty or up to 4,000 characters.');
    if(r.requiredText!==undefined&&(!Array.isArray(r.requiredText)||r.requiredText.length>12||r.requiredText.some(x=>typeof x!=='string'||!x.trim()||x.length>500||/[\r\n]/.test(x))||new Set(r.requiredText).size!==r.requiredText.length))throw new AppError('Use up to twelve distinct required text snippets, each on one line with at most 500 characters.');
    const rule={...r,path:await system.path(r.path,{missing:true})};
    if(r.sourceReview!==undefined&&typeof r.sourceReview!=='boolean')throw new AppError('Source review must be enabled or disabled.');
    if(r.draftCritique!==undefined&&(typeof r.draftCritique!=='boolean'||r.draftCritique&&!r.sourceReview))throw new AppError('An optional second local review requires source review and must be enabled or disabled.');
    if(r.sourceReview&&(Object.hasOwn(r,'exactText')||!linkedSources(rule).length||linkedSources(rule).length>8||linkedSources(rule).includes(rule.path)))throw new AppError('Source review needs 1–8 distinct local source links in Required text and generated output, without exact text or self-citations.');
    if(files.some(x=>x.path===rule.path))throw new AppError('List each output file only once.');
    if(Object.hasOwn(rule,'exactText')&&textMismatches(rule,rule.exactText).length)throw new AppError('Exact text contradicts its formatting requirements: '+textMismatches(rule,rule.exactText).join(' '));
    files.push(rule);
  }
  if(files.some(r=>r.sourceReview&&linkedSources(r).some(path=>files.some(f=>f.path===path))))throw new AppError('An output file cannot be a reviewed source for another output.');
  for(const r of input.commands){
    if(!keys(r,['program','args','cwd','outputIncludes'])||typeof r.outputIncludes!=='string'||!r.outputIncludes.trim()||r.outputIncludes.length>500||typeof r.cwd!=='string'||!r.cwd.trim())throw new AppError('Each check needs an executable, arguments, working directory and literal output marker (up to 500 characters).');
    const {program,args,cwd}=await system.prepareCommand(r.program,r.args,r.cwd),rule={program,args,cwd,outputIncludes:r.outputIncludes};
    if(commands.some(x=>sameCommand(x,rule)))throw new AppError('List each check command only once.');
    commands.push(rule);
  }
  const result={files,commands,...desktop};if(JSON.stringify(result).length>8000)throw new AppError('Resolved requirements exceed 8,000 characters. Shorten the inputs.');return result;
}

export function proposalRequirements(w,kind,payload){
  if(!hasRequirements(w)||!['write','command'].includes(kind))return null;
  const checks=[],failures=[];
  if(kind==='write'&&w.requirements.files.length){
    const rule=w.requirements.files.find(r=>r.path===payload.path);
    if(!rule)failures.push('This file is not in the allowed output files. Use a listed path or ask the user to edit Output requirements.');
    else{failures.push(...textMismatches(rule,payload.content));checks.push('Allowed output file',...(rule.requiredText?.length?[`${rule.requiredText.length} required text snippets present`]:[]),...(Object.hasOwn(rule,'exactText')?['Exact text matches']:[]),...(rule.finalNewline!=='any'?['Final newline: '+rule.finalNewline]:[]),...(rule.lineEndings!=='any'?['Line endings: '+rule.lineEndings.toUpperCase()]:[]));}
  }
  if(kind==='command'&&w.requirements.commands.length){
    if(!w.requirements.commands.some(r=>sameCommand(r,payload)))failures.push('This command does not exactly match a required check. Copy its executable, argument items and working directory from outputRequirements.commands, or ask the user to edit Output requirements.');
    else checks.push('Exact check executable, arguments and working directory match. Output will be checked after execution.');
  }
  if(failures.length)throw Object.assign(new AppError('Output requirement rejected this proposal before approval: '+failures.join(' ')+' No action was executed. Correct the proposal; do not remove or relax the user’s requirements.'),{requirementFailures:failures});
  return checks.length?{revision:w.revision,checks,notice:'Only these explicit requirements were checked. Review the actual action and its intended effects.'}:null;
}

// A command can change files even when it fails. Do not reuse an earlier read
// after any executed write, command, or desktop input. Rejected proposals have
// no action and cannot invalidate an otherwise fresh observation.
export const mayChangeFiles=o=>o.action&&o.status!=='superseded'&&(o.name==='propose_file_edit'||o.name==='propose_command'||o.name==='computer_action'&&['click','type_text','key'].includes(o.arguments?.operation));
export function requirementStatus(w){
  if(!hasRequirements(w))return [];
  const statuses=[],ops=w.operations,floor=verificationFloor(w);
  const lastEffect=ops.findLastIndex(mayChangeFiles),lastEdit=ops.findLastIndex(o=>o.action&&o.name==='propose_file_edit'&&o.status!=='superseded');
  for(const rule of w.requirements.files){
    const index=ops.findLastIndex(o=>ok(o)&&o.name==='read_system_file'&&o.result?.path===rule.path),read=ops[index]?.result;let failures=[];
    if(index<floor)failures=[floor?'Read this output file again after the project interruption.':'Read this output file after the latest action or check command.'];
    else if(index<=lastEffect)failures=['Read this output file after the latest action or check command.'];
    else if(read.truncated||typeof read.content!=='string'||read.revision!==sha(read.content))failures=['Read the complete unredacted text before verifying this output.'];
    else failures=textMismatches(rule,read.content);
    statuses.push({kind:'file',path:rule.path,passed:!failures.length,detail:failures.join(' ')||'Fresh file observation matches the stated requirements.',evidence:!failures.length?ops[index].id:undefined});
  }
  for(const rule of w.requirements.commands){
    const index=ops.findLastIndex(o=>o.name==='propose_command'&&sameCommand(o.command,rule)),op=ops[index],r=op?.result;let detail='Run this exact reviewed check after the latest file edit.';
    const stale=beforeCheckpoint(w,op),passed=!stale&&index>lastEdit&&ok(op||{})&&r?.code===0&&!r.stopped&&!r.truncated&&typeof r.content==='string'&&r.content.includes(rule.outputIncludes);
    if(stale)detail='Run this saved check again through approval after the project interruption. Earlier results remain in history.';
    else if(index>lastEdit&&op)detail=passed?'Successful check with the required literal output marker.':'The latest matching check needs successful exit, intact output and the required marker.';
    statuses.push({kind:'command',program:rule.program,args:rule.args,cwd:rule.cwd,outputIncludes:rule.outputIncludes,passed,detail,evidence:passed?op.id:undefined});
  }
  return [...statuses,...desktopRequirementStatus(w)];
}

// Opt-in workflow tool: only saved formatting rules may transform generated text.
// The ordinary file-edit tool and exact-text requirements stay byte-for-byte.
export function formattedFile(w,args){
  if(!keys(args,['path','content','reason'])||typeof args.path!=='string'||typeof args.content!=='string'||typeof args.reason!=='string'||Buffer.byteLength(args.content)>64000)throw new AppError('Supply path, complete content and reason for the formatted file draft.');
  const rule=w.requirements?.files.find(r=>r.path===args.path);
  if(!rule||Object.hasOwn(rule,'exactText'))throw new AppError('Choose an output file with saved formatting rules and no exact-text requirement.');
  let content=args.content;
  if(rule.lineEndings==='lf')content=content.replace(/\r\n|\r/g,'\n');
  if(rule.lineEndings==='crlf')content=content.replace(/\r\n|\r|\n/g,'\r\n');
  if(rule.finalNewline==='required'&&!content.endsWith('\n'))content+=rule.lineEndings==='crlf'?'\r\n':'\n';
  if(rule.finalNewline==='forbidden')content=content.replace(/[\r\n]+$/,'');
  return {...args,content};
}
