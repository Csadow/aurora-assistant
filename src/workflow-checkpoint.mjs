import {randomUUID,createHash} from 'node:crypto';
// A continuation boundary invalidates observations, never successful effects.
// Old tasks keep their original completion contract. No action is replayed here.
const declaredDesktop=w=>!!(w.requirements?.browser||w.requirements?.window);
export const verificationFloor=w=>w.version>=6||declaredDesktop(w)?w.projectCheckpoint?.operationCount||0:0;
export function beforeCheckpoint(w,op){
  const floor=verificationFloor(w);
  if(!floor||w.operations.indexOf(op)>=floor)return false;
  // A proposal can predate the pause but execute only after reviewed resume.
  // This receipt is copied from the action journal, never model arguments.
  return !((op?.name==='propose_command'||(w.version>=18||declaredDesktop(w))&&op?.name==='computer_action')&&w.projectCheckpoint.id&&op.executionCheckpoint===w.projectCheckpoint.id);
}

export function checkpointProject(w,reason){
  const desktop=(w.version>=18||declaredDesktop(w))&&w.operations.some(o=>['computer_action','inspect_desktop'].includes(o.name));
  if(w.version<6&&!declaredDesktop(w)||!desktop&&(!w.project||!w.requirements?.commands?.length)||!w.operations.length||['completed','cancelled'].includes(w.status))return;
  const operationCount=w.operations.length;
  const progress=createHash('sha256').update(JSON.stringify(w.operations.map(o=>[o.id,o.status,o.action]))).digest('hex');
  if(w.projectCheckpoint?.operationCount===operationCount&&w.projectCheckpoint.progress===progress)return;
  w.projectCheckpoint={id:randomUUID(),reason,at:new Date().toISOString(),operationCount,progress,
    completedEdits:w.operations.filter(o=>o.status==='completed'&&o.expected).map(o=>({path:o.expected.path,revision:o.expected.revision})),
    completedActions:w.operations.filter(o=>o.action&&o.status==='completed').length,
    pendingActions:w.operations.filter(o=>o.action&&o.status==='waiting_approval').length,
    ...(desktop?{kind:'desktop',lastObserved:checkpointObservations(w),uncertainActions:w.operations.slice(w.operations.findLastIndex(o=>o.name==='user_verification'&&o.status==='completed')+1).filter(o=>o.action&&o.name==='computer_action'&&['failed','interrupted'].includes(o.status)).length}:{})};
}

function checkpointObservations(w){
  const result=[];
  for(const kind of ['browser','windows','screen']){
    const o=w.operations.findLast(o=>o.status==='completed'&&!o.result?.error&&(kind==='screen'?o.name==='inspect_desktop':o.name==='computer_action'&&(kind==='browser'?['open_url','web_search','browser_read'].includes(o.arguments?.operation)&&typeof o.result?.url==='string':o.arguments?.operation==='windows'&&Array.isArray(o.result?.windows))));
    if(!o)continue;
    const r=o.result;result.push({kind,evidence:o.id,at:o.finished||o.started,...kind==='browser'?{url:r.url.slice(0,800),title:String(r.title||'').slice(0,200)}:kind==='windows'?{windows:r.windows.slice(0,8).map(x=>({id:x.id,app:String(x.app||'').slice(0,100),title:String(x.title||'').slice(0,200)}))}:{summary:String(r.content||'').slice(0,240)}});
  }
  return result;
}

export function projectCheckpointContext(w){
  if(!verificationFloor(w))return null;
  return {...w.projectCheckpoint,
    notice:w.projectCheckpoint.kind==='desktop'?'Historical interruption snapshot, not current state. Completed actions are saved; do not repeat clicks, typing, writes or launches. Pending actions keep their exact review. After resuming, read the current browser, list current windows and read saved output files as needed, then verify the requested outcomes. Earlier observations cannot verify completion. An uncertain action still needs the user to check what happened before resuming; reconnection alone never retries it.':'Completed actions are saved; do not repeat their effects. Pending actions keep their exact review. Files may have changed while paused. Inspect current files, finish only remaining edits, then run the saved checks through approval and read all required outputs after the last check. Earlier tests and reads remain history, not current verification.'};
}
