import {randomUUID} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
import {AppError} from './vault.mjs';
import {inspectSourceLines} from './workflow-source-lines.mjs';

// Independent file reads may share a model turn. New local tasks may also
// include one cached source-line view; each call keeps its own journal record.
export function readGroupArguments(calls,remaining,w){
  const names=Array.isArray(calls)?calls.map(c=>c?.function?.name):[];
  const localMixed=w?.version>=24&&w.engine==='local';
  const mixed=localMixed&&names.filter(n=>n==='inspect_source_lines').length===1&&names.filter(n=>n==='read_system_file').length===names.length-1;
  if(!Array.isArray(calls)||calls.length<2||calls.length>4||!mixed&&names.some(n=>n!=='read_system_file'))throw new AppError(localMixed?'No calls ran. Request 2–4 distinct read_system_file calls, or ONE inspect_source_lines view with 1–3 reads of OTHER paths. Request each tool separately in the reply; never mix actions, checks, questions or completion.':'No calls ran. Request 2–4 independent read_system_file calls together, or ONE other tool. Never combine reads with edits, checks, questions or completion.');
  if(calls.length>remaining)throw new AppError('No calls ran. This read group exceeds the remaining operation budget.');
  const seen=new Set();let viewPath=null;
  const args=calls.map(c=>{
    let a=c.function.arguments;
    if(typeof a==='string'){try{a=JSON.parse(a);}catch{throw new AppError('No calls ran. Each grouped call needs valid JSON arguments.');}}
    if(c.function.name==='inspect_source_lines'){
      try{viewPath=resolve(inspectSourceLines(w,a).path);}catch(e){throw new AppError('No calls ran. Source-line view is invalid: '+e.message);}
      return a;
    }
    if(!a||Array.isArray(a)||typeof a!=='object'||Object.keys(a).some(k=>!['path','offset'].includes(k))||typeof a.path!=='string'||!isAbsolute(a.path)||a.path.length>4096||a.path.includes('\0')||a.offset!==undefined&&(!Number.isInteger(a.offset)||a.offset<0||a.offset>262144))throw new AppError('No calls ran. Each read needs an absolute path and optional integer offset (0–262144).');
    const key=resolve(a.path);if(seen.has(key))throw new AppError('No calls ran. Read each file only once per group; use nextOffset on a later turn for long files.');seen.add(key);
    return a;
  });
  if(viewPath&&seen.has(viewPath))throw new AppError('No calls ran. The source-line view and file read target the same path. Request the current file read first, then inspect its new E-number.');
  return args;
}

export async function runReadGroup(service,w,step,calls,signal){
  let args;
  try{args=readGroupArguments(calls,72-w.operations.length,w);}
  catch(e){
    const at=new Date().toISOString();
    w.operations.push({id:randomUUID(),step:step.id,revision:w.revision,name:'read_file_group',arguments:{calls},status:'failed',started:at,finished:at,result:{error:e.message}});
    await service.save(w);return;
  }
  const group=randomUUID();
  for(const [index,a] of args.entries()){
    signal.throwIfAborted();
    const name=calls[index].function.name;
    const op={id:randomUUID(),step:step.id,revision:w.revision,name,arguments:a,readGroup:{id:group,index,total:args.length},status:'started',started:new Date().toISOString()};
    w.operations.push(op);w.activity={phase:'tool',since:op.started,operation:op.id};await service.save(w);
    try{
      // Check each target immediately before reading, through the same scope,
      // system-access, redaction and size guards as an individual read.
      if(name==='read_system_file')await service.projectWorkspaces?.target(w.project,a.path);
      signal.throwIfAborted();
      op.result=name==='inspect_source_lines'?inspectSourceLines(w,a):await service.assistant.runTool({function:{name:'read_system_file',arguments:a}},w.id,signal);
      signal.throwIfAborted();op.status='completed';
    }catch(e){
      if(signal.aborted)throw e;
      op.status='failed';op.result={error:e.status?e.message:'Tool failed: '+e.message};
    }
    op.finished=new Date().toISOString();await service.save(w);
    // A missing/blocked path must be addressed before continuing a group. Saved
    // successes remain usable; unattempted files are never recorded as observed.
    if(op.status==='failed')break;
  }
}
