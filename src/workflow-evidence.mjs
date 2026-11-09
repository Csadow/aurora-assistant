import {mayChangeFiles} from './workflow-requirements.mjs';
import {beforeCheckpoint} from './workflow-checkpoint.mjs';
import {AppError} from './vault.mjs';

const successful=o=>o.status==='completed'&&!o.result?.error;
const browserEffects=new Set(['open_url','web_search','browser_click','browser_fill','browser_key','browser_back','browser_scroll']);
const windowEffects=new Set(['open_app','open_path','focus_window','close_window']);
const screenEffects=new Set(['click','type_text','key','scroll']);
export const outcomeKinds=['browser_title','browser_text','browser_url','file_text','window_title','window_absent','screen_text','command_exit','command_output'];
const family=kind=>kind.startsWith('browser_')?'browser':kind.startsWith('window_')?'window':kind.startsWith('command_')?'command':kind==='screen_text'?'screen':'file';
const effect=o=>o.name==='propose_command'?'command':o.name==='computer_action'?(browserEffects.has(o.arguments?.operation)?'browser':windowEffects.has(o.arguments?.operation)?'window':screenEffects.has(o.arguments?.operation)?'screen':null):null;

// Stable, exact handles for bounded local-model context. The journal keeps UUIDs.
// Appending, pausing and replanning never remove or reorder operations.
export function evidenceHandle(w,id){if(typeof id!=='string')return id;const index=w.operations.findIndex(o=>o.id===id);return index<0?id:'E'+(index+1);}
export function resolveEvidence(w,ref){if(typeof ref==='string'&&/^E[1-9]\d?$/.test(ref))return w.operations[Number(ref.slice(1))-1]?.id||ref;return ref;}
export function evidenceView(w,op){
  const refs=value=>Array.isArray(value)?value.map(id=>evidenceHandle(w,id)):evidenceHandle(w,value);
  return {...op,id:evidenceHandle(w,op.id),arguments:op.arguments&&Object.hasOwn(op.arguments,'evidence')?{...op.arguments,evidence:refs(op.arguments.evidence)}:op.arguments,result:op.result&&Object.hasOwn(op.result,'evidence')?{...op.result,evidence:refs(op.result.evidence)}:op.result};
}

export function verifyOutcome(w,{evidence,kind,expected}){
  evidence=resolveEvidence(w,evidence);
  if(kind==='window_absent'&&(typeof expected!=='string'||!expected.trim()))throw new AppError('To confirm that a window OPENED, use window_title with the document filename and evidence from computer_action operation=windows. window_absent is only for confirming a CLOSED window using its previously observed exact window ID.');
  if(typeof expected==='string'&&expected.length>1000)throw new AppError(`Expected text is ${expected.length} characters. Use ONE short literal excerpt of at most 1,000 characters, not the entire document. The length error does not invalidate the observation: keep its evidence handle and shorten expected; do not repeat the action or reread solely to fix this argument. File readback and saved output requirements already check complete output bytes separately.`);
  if(!outcomeKinds.includes(kind)||typeof expected!=='string'||!expected.trim()||expected.length>1000)throw new AppError('Choose an outcome kind and a specific expected value (1–1,000 characters).');
  const index=w.operations.findIndex(o=>o.id===evidence&&successful(o));
  if(index<0)throw new AppError('Use a successful observation evidence ID.');
  const op=w.operations[index],r=op.result||{},group=family(kind);let actual,passed=false;
  if((w.version>=18||['command','file'].includes(group))&&beforeCheckpoint(w,op))throw new AppError('This evidence predates the task interruption. Observe current state before verifying completion: read the browser/files, list windows or inspect the screen as needed. Run saved checks again through review. Do not repeat completed effects.');
  if(group==='browser'){
    if(op.name!=='computer_action'||!['open_url','web_search','browser_read'].includes(op.arguments?.operation)||typeof r.url!=='string'||typeof r.text!=='string')throw new AppError('Read the browser for a fresh page snapshot.');
    if(w.operations.slice(index+1).some(o=>successful(o)&&(effect(o)==='browser'||o.name==='computer_action'&&o.arguments?.operation==='browser_read')))throw new AppError('Browser evidence is stale. Read the current page again.');
    actual=kind==='browser_title'?r.title:kind==='browser_url'?r.url:r.text;
    passed=kind==='browser_url'?actual===expected:String(actual||'').includes(expected);
  }else if(group==='window'){
    if(op.name!=='computer_action'||op.arguments?.operation!=='windows'||!Array.isArray(r.windows))throw new AppError('List current windows before checking their state.');
    if(w.operations.slice(index+1).some(o=>successful(o)&&(effect(o)||o.name==='computer_action'&&o.arguments?.operation==='windows')))throw new AppError('Window evidence is stale. List windows again.');
    actual=r.windows.map(x=>`${x.id} ${x.app||''} ${x.title||''}`).join('\n');
    if(kind==='window_absent'&&!w.operations.slice(0,index).some(o=>successful(o)&&(o.result?.windows?.some(x=>x.id===expected)||o.arguments?.windowId===expected)))throw new AppError('Use a window ID observed or targeted earlier in this task.');
    passed=kind==='window_absent'?!r.windows.some(x=>x.id===expected):actual.includes(expected);
  }else if(group==='screen'){
    if(op.name!=='inspect_desktop')throw new AppError('Inspect the shared screen first.');
    if(w.operations.slice(index+1).some(o=>successful(o)&&(effect(o)||o.name==='inspect_desktop')))throw new AppError('Screen evidence is stale. Inspect again.');
    actual=r.content;passed=String(actual||'').includes(expected);
  }else if(group==='command'){
    if(op.name!=='propose_command'||r.code!==0||r.stopped||r.truncated)throw new AppError('Use a completed command with exit code zero and intact output. Failed, stopped or truncated commands cannot pass.');
    if(w.operations.slice(index+1).some(o=>successful(o)&&(o.name==='propose_command'||o.expected)))throw new AppError('Command evidence predates another command or file edit. Run the relevant check again through review.');
    if(kind==='command_exit'&&expected!=='0')throw new AppError('command_exit requires expected="0". Use command_output with the actual pass marker to verify a test result.');
    actual=kind==='command_exit'?String(r.code):r.content;passed=String(actual||'').includes(expected);
  }else{
    if(op.name!=='read_system_file')throw new AppError('Read the file before checking its text.');
    if(w.operations.slice(index+1).some(o=>mayChangeFiles(o)||successful(o)&&(o.expected?.path===r.path||o.name==='read_system_file'&&o.result?.path===r.path)))throw new AppError('File evidence is stale or predates an edit. Use the latest read.');
    actual=r.content;passed=String(actual||'').includes(expected);
  }
  if(!passed)throw new AppError(`Outcome check failed: ${kind} did not match ${JSON.stringify(expected)}. Expected must be one exact contiguous excerpt from the observed value, not a summary or separate lines joined with punctuation. Observed value: ${JSON.stringify(String(actual||'').slice(0,1800))}. If it supports the goal, retry verify_outcome with a literal excerpt and this evidence ID; do not repeat the action just to fix check syntax. Otherwise inspect and adapt or ask the user; do not claim completion.`);
  return {verified:true,evidence,kind,expected,observation:{path:r.path,url:r.url,revision:r.revision},warning:group==='screen'?'Matches the local vision description; visual recognition may be wrong.':kind==='command_exit'?'Confirms successful process exit, not every intended effect. Check output and relevant state.':undefined};
}

export function missingOutcomes(w){
  const latest=new Map();
  for(const [index,o] of w.operations.entries()){
    const uncertain=w.version>=18&&o.name==='computer_action'&&o.action&&['failed','interrupted'].includes(o.status)&&['failed','stopped','interrupted'].includes(o.result?.status);
    if((successful(o)||uncertain)&&effect(o)&&(effect(o)!=='command'||w.version>=3))latest.set(effect(o),{index,o});
  }
  return [...latest].filter(([group,{index}])=>!w.operations.some(o=>{
    if(!successful(o)||o.name!=='verify_outcome'||family(o.result?.kind||'')!==group||w.operations.findIndex(x=>x.id===o.result?.evidence)<index)return false;
    // Revalidate at completion: a later observation may contradict an earlier pass.
    try{return verifyOutcome(w,o.result).verified;}catch{return false;}
  })).map(([group,{index,o}])=>{
    const observation=w.operations.findLast((candidate,i)=>{
      if(i<index||(w.version>=18||group==='command')&&beforeCheckpoint(w,candidate)||!successful(candidate))return false;
      const r=candidate.result||{},operation=candidate.arguments?.operation;
      if(group==='command')return candidate.name==='propose_command'&&r.code===0&&!r.stopped&&!r.truncated&&!w.operations.slice(i+1).some(x=>successful(x)&&(x.name==='propose_command'||x.expected));
      if(group==='browser')return candidate.name==='computer_action'&&['open_url','web_search','browser_read'].includes(operation)&&typeof r.url==='string'&&typeof r.text==='string'&&!w.operations.slice(i+1).some(x=>successful(x)&&(effect(x)==='browser'||x.name==='computer_action'&&x.arguments?.operation==='browser_read'));
      const matches=group==='window'?candidate.name==='computer_action'&&operation==='windows'&&Array.isArray(r.windows):candidate.name==='inspect_desktop';
      return matches&&!w.operations.slice(i+1).some(x=>successful(x)&&(effect(x)||group==='window'&&x.name==='computer_action'&&x.arguments?.operation==='windows'||group==='screen'&&x.name==='inspect_desktop'));
    });
    return {group,action:o.id,operation:o.arguments?.operation||o.name,required:group==='command'?'Check the completed command with verify_outcome kind=command_output and the actual test pass marker; command_exit expected="0" only checks process exit. After later edits, run a fresh check through review.':group==='browser'?'Observe with computer_action operation=browser_read; check with verify_outcome kind=browser_title, browser_text or browser_url':group==='window'?'Observe with computer_action operation=windows; check presence with window_title or closure with window_absent':'Observe with inspect_desktop; check with verify_outcome kind=screen_text',availableObservation:observation?{evidence:observation.id,title:observation.result.title,url:observation.result.url,code:observation.result.code,windows:observation.result.windows?.slice(0,8).map(w=>({id:w.id,app:w.app,title:w.title}))}:undefined};
  });
}

// A successful duplicate verification is not new progress. Preserve the whole
// journal, but do not let it continually reset the repeated-read safety limit.
export function redundantVerification(w,op){
  if(op.name!=='verify_outcome'||op.status!=='completed'||!op.result?.verified)return false;
  const index=w.operations.indexOf(op),r=op.result;
  return w.operations.slice(0,index).some(old=>old.name==='verify_outcome'&&old.status==='completed'&&old.result?.verified&&
    old.result.evidence===r.evidence&&old.result.kind===r.kind&&old.result.expected===r.expected);
}
