import {copyDiagnosis,copyDiagnosisForModel} from './copy-diagnosis.mjs';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,rm,lstat,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute,dirname} from 'node:path';
import {AppError,sha} from './vault.mjs';
import {runCommand} from './system.mjs';
import {repairPlanContext,proposeRepair} from './workflow-repair-plan.mjs';
import {observationNeedsFreshRead,sourceLines} from './workflow-tools.mjs';
import {proposalRequirements} from './workflow-requirements.mjs';
import {copyDependencies} from './copy-dependencies.mjs';

export const testCopyTool={type:'function',function:{name:'propose_test_copy',description:'Request exact approval to test ONE saved repair in temporary baseline/candidate copies before applying it. Read the saved Node test files, local imports and package.json first; only fully observed current files under the saved check folder are included. Uses repair R-number and check C-number, no code/command override. Does not apply edits, satisfy original project checks, erase failed examples or prove semantic scope. Missing dependencies remain failures.',parameters:{type:'object',properties:{repair:{type:'string'},check:{type:'string',enum:['C1','C2']}},required:['repair','check'],additionalProperties:false}}};
const inside=(root,path)=>{const r=relative(root,path);return r!==''&&!isAbsolute(r)&&r!=='..'&&!r.startsWith('../');};
export function supportsCopyCheck(c){
  return c?.program==='/usr/bin/node'&&c.args?.length>=2&&c.args.length<=9&&c.args[0]==='--test'&&
    c.args.slice(1).every(a=>typeof a==='string'&&/^(?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|js)$/.test(a)&&!a.split('/').includes('..')&&!a.startsWith('-'));
}
const binding=r=>({id:r.id,path:r.path,line:r.line,before:r.before,after:r.after});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const experimentFingerprint=({snapshot,candidate,check})=>sha(JSON.stringify({snapshot,target:candidate.path,candidate:sha(candidate.content),check}));
const notice='Temporary-copy results cover the saved assertions only. Scope and missing dependencies need review. Original project checks, separate edit approval and final readback are still required.';

export function bindCopyRequirement(name,project,requirements){
  if(name===undefined||name==='')return null;
  if(typeof name!=='string')throw new AppError('Select a saved check for testing before edits.');
  const saved=project?.checks.find(c=>c.name===name);
  if(!saved||!supportsCopyCheck(saved))throw new AppError('Test before editing needs a selected saved Node check with explicit JavaScript test paths.');
  const {name:label,...check}=saved,policy={name:label,check};
  validateCopyRequirement(policy,requirements);return policy;
}
export function validateCopyRequirement(policy,requirements){
  if(!policy)return;
  if(!requirements.commands.some(c=>same(c,policy.check))||!requirements.files.length||requirements.files.some(f=>f.sourceReview||!inside(policy.check.cwd,f.path)||policy.check.args.slice(1).some(p=>join(policy.check.cwd,p)===f.path)))throw new AppError('Keep the test-before-edit check and explicit output files inside its folder; test entry files and source-reviewed documents cannot be outputs. Start a new task to choose another copy policy.');
}
export function guardCopyControl(w,kind,payload){
  if(w.copyBeforeEdit&&kind==='computer'&&!['applications','windows','browser_read'].includes(payload.operation))throw new AppError('This test-before-edit task uses reviewed file edits and saved commands. Desktop control could bypass its tested candidate; use a separate task for app control.',409);
}
function repairContent(source,repair){
  const line=sourceLines(source)[repair.line-1],index=line?.text.indexOf(repair.before);
  if(index===undefined||index<0||line.text.indexOf(repair.before,index+1)>=0)return null;
  const offset=line.start+index;
  return source.slice(0,offset)+repair.after+source.slice(offset+repair.before.length);
}
// Journal guidance only; the action guard independently rereads the real files.
// Match actual contents, not a repair ID or a particular fragment spelling.
export function testedCopyForRepair(w,repair){
  const read=w.operations.findLast(o=>o.name==='read_system_file'&&o.result?.path===repair.path)?.result;
  if(!read||read.truncated||typeof read.content!=='string'||read.revision!==sha(read.content))return null;
  const content=repairContent(read.content,repair);if(content===null)return null;
  return w.operations.findLast((o,index)=>{
    const r=o.result,c=r?.candidate;
    if(o.name!=='propose_test_copy'||o.status!=='completed'||o.revision!==w.revision||!c||c.path!==repair.path||c.beforeRevision!==read.revision||c.revision!==sha(content)||!same(r.check,w.copyBeforeEdit?.check))return false;
    if(!r.sources?.length)return false;
    for(const s of r.sources){
      const latest=w.operations.findLast(x=>x.name==='read_system_file'&&(x.result?.path||x.arguments?.path)===s.path);
      if(latest?.status!=='completed'||latest.result?.revision!==s.revision)return false;
      if(w.operations.slice(index+1).some(x=>x.action&&x.status!=='superseded'&&(x.name==='propose_command'||x.name==='propose_file_edit'&&x.expected?.path===s.path)))return false;
    }
    return true;
  });
}
export function copyRequirementContext(w){
  if(!w.copyBeforeEdit)return undefined;
  return {required:true,check:'C'+(w.requirements.commands.findIndex(c=>same(c,w.copyBeforeEdit.check))+1),
    testedRepairs:(repairPlanContext(w)?.repairs||[]).flatMap(repair=>{const o=testedCopyForRepair(w,repair);return o?[{repair:repair.id,evidence:'E'+(w.operations.indexOf(o)+1),runs:o.result.runs.map(r=>({variant:r.variant,outcome:r.outcome}))}]:[];}),
    notice:'Before every edit: test this candidate, inspect results, then propose_repair. testedRepairs survive renamed repair lists. Assertion failures may remain until another planned repair is applied; review them, do not retest unchanged copies. Missing source needs help. Final original checks/readbacks remain required.'};
}

// A sole remaining repair cannot satisfy a selected saved check when its
// candidate still has named assertion failures. Other planned corrections can
// legitimately need separate edits, so retain their existing copy-first path.
export function unfinishedSoleRepair(w,repair,result){
  const diagnosis=result?.diagnosis;
  if(w.version<33||w.engine!=='local'||diagnosis?.status!=='compared'||!diagnosis.candidate?.counts?.fail)return null;
  const remaining=repairPlanContext(w)?.repairs.filter(r=>!['edit_applied','awaiting_action'].includes(r.state))||[];
  if(remaining.length!==1||remaining[0].id!==repair.id)return null;
  const tests=diagnosis.changes.filter(t=>t.candidate==='failed').map(t=>t.name);
  return tests.length?{count:tests.length,tests:tests.slice(0,6),testsExcerpted:tests.length>6}:null;
}

// This guard is used for EVERY write format at preparation and again immediately
// before execution. A completed action for another candidate/revision cannot pass.
export async function requireTestedCopy(service,w,payload){
  if(!w.copyBeforeEdit)return null;
  validateCopyRequirement(w.copyBeforeEdit,w.requirements);
  for(const op of [...w.operations].reverse()){
    if(op.name!=='propose_test_copy'||op.status!=='completed'||!op.action||op.revision!==w.revision)continue;
    const a=await service.store.get('actions',op.action),p=a.payload,r=a.result;
    if(a.kind!=='test_copy'||a.status!=='completed'||a.workflow?.id!==w.id||a.workflow?.operation!==op.id||a.workflow?.revision!==w.revision||!same(p.check,w.copyBeforeEdit.check)||p.candidate.path!==payload.path||p.candidate.content!==payload.content||p.candidate.before!==payload.before)continue;
    const repair=repairPlanContext(w)?.repairs.find(x=>x.path===payload.path&&repairContent(payload.before,x)===payload.content);
    if(!repair||repair.exampleLedger?.failed||repair.expressionCheck?.hasFailedExamples)throw new AppError('The tested repair must remain in the current plan without unresolved failed examples. Review the diagnosis before applying it.',409);
    const unfinished=unfinishedSoleRepair(w,repair,r);
    if(unfinished)throw new AppError(`The sole remaining repair still fails ${unfinished.count} saved ${unfinished.count===1?'test':'tests'} in its candidate copy. Review the named failure and exact source change, then save a revised repair plan before requesting an edit. No original file was changed.`,409);
    if(r?.fingerprint!==p.fingerprint||r.originalSourcesCurrent!==true||!r.cleanedUp||r.error||r.stopped||r.runs?.length!==2||r.runs.some((run,i)=>run.variant!==['baseline','candidate'][i]||run.stopped||run.truncated||!['passed','assertion_failure'].includes(run.outcome)))throw new AppError('The matching copy did not produce two usable test results. Review its setup/dependency failure before proposing an edit.',409);
    await service.projectWorkspaces.target(w.project,p.root);
    await validateTestCopy(service.actions.system,p);
    return {action:a.id,fingerprint:p.fingerprint,check:w.copyBeforeEdit.name,result:r};
  }
  throw new AppError('Test before editing is required. Use propose_test_copy for this exact candidate and the selected saved check first. Read missing dependencies, review the completed results, then request separate edit approval.',409);
}

export function copyOutcome(run,passed){
  if(run.stopped||run.truncated)return 'incomplete';
  if(passed)return 'passed';
  if(/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(run.content))return 'missing_dependency';
  if(/SyntaxError|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM/.test(run.content))return 'setup_failure';
  if(run.code!==0&&/ERR_ASSERTION|AssertionError/.test(run.content))return 'assertion_failure';
  return 'unclassified_failure';
}

// A preparation error is no longer an active read request once every named path
// has a later complete current observation. This is not a copy/test receipt:
// preparation and approval still independently validate the actual filesystem.
export function copyReadinessOutstanding(w,o){
  if(w.version<14||o?.revision!==w.revision||o.name!=='propose_test_copy'||o.action||o.status!=='failed'||!o.result?.copyReadiness)return [];
  const d=o.result.copyReadiness,paths=[...(d.neededReads||[]),...(d.missing||[])],after=w.operations.indexOf(o);
  return paths.filter(path=>{
    const index=w.operations.findLastIndex(r=>r.name==='read_system_file'&&(r.result?.path||r.arguments?.path)===path),r=w.operations[index];
    return !(index>after&&r.status==='completed'&&!r.result?.error&&!r.arguments?.offset&&!r.result?.offset&&!r.result?.truncated&&typeof r.result?.content==='string'&&r.result.revision===sha(r.result.content)&&!observationNeedsFreshRead(w,index,path));
  });
}
export function copyReadinessResolved(w,o){
  if(w.version<14||o.revision!==w.revision||o.name!=='propose_test_copy'||o.action||o.status!=='failed'||!o.result?.copyReadiness)return false;
  const d=o.result.copyReadiness;
  return (d.neededReads?.length||0)+(d.missing?.length||0)>0&&copyReadinessOutstanding(w,o).length===0;
}

function sandbox(payload,variant){
  const cwd=join(payload.directory,variant),scratch=join(payload.directory,variant+'-scratch');
  return {program:'/usr/bin/bwrap',cwd,args:[
    '--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL',
    '--ro-bind','/usr','/usr','--symlink','usr/lib','/lib','--symlink','usr/lib','/lib64',
    '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--ro-bind',cwd,'/project','--bind',scratch,'/scratch',
    '--chdir','/project','--clearenv','--setenv','TMPDIR','/scratch','--setenv','LANG','C','--setenv','TZ','UTC',
    '--',payload.check.program,...payload.check.args],sandboxCwd:'/project',scratch,timeout:10000};
}
async function current(system,file){
  if(await system.path(file)!==file||await realpath(file)!==file)throw new AppError('Copy source path changed or contains a symlink: '+file,409);
  const info=await lstat(file);if(!info.isFile()||info.nlink!==1)throw new AppError('Copy only regular files with a single hard link.',409);
  const r=await system.read(file,{limit:262144});
  if(r.truncated||r.offset||typeof r.content!=='string'||r.revision!==sha(r.content))throw new AppError('A copy needs complete unredacted source: '+file,409);
  return r;
}

export async function prepareTestCopy(service,w,args){
  const needsRead=(path,message)=>Object.assign(new AppError(message,409),w.version>=14?{copyReadiness:{neededReads:[path],missing:[],limitations:[],edges:[],notice:'Read the named current source before preparing the copy again; no test or action ran.'}}:{});
  if(w.version<12||!w.project||!args||Object.keys(args).some(k=>!['repair','check'].includes(k))||!/^C[12]$/.test(args.check))throw new AppError(w.version>=28&&w.engine==='local'&&w.project?'No copy was prepared. First save an observed correction with record_repair_plan. Then call propose_test_copy with ONLY its returned repair R-number and saved check C-number; omit before, after, filePath, line and reason. A copy result cannot be requested from unsaved patch text.':'Use repair and check in a new project task.');
  if(w.operations.filter(o=>o.name==='propose_test_copy'&&o.action).length>=4)throw new AppError('This task has used its four copy-test requests. Review the results before starting a focused follow-up.');
  const system=service.actions.system,check=w.requirements.commands[Number(args.check.slice(1))-1];
  if(!supportsCopyCheck(check)||!w.project.checks.some(c=>same({program:c.program,args:c.args,cwd:c.cwd,outputIncludes:c.outputIncludes},check)))throw new AppError('Copy testing currently supports a selected saved Node check: node --test followed by explicit relative JavaScript test paths.');
  const patch=proposeRepair(w,{repair:args.repair}),repair=repairPlanContext(w).repairs.find(r=>r.id===args.repair);
  if(!inside(check.cwd,patch.path)||check.args.slice(1).some(p=>join(check.cwd,p)===patch.path))throw new AppError('The repair must be inside the saved check folder and cannot change its test entry files.');
  await service.projectWorkspaces.target(w.project,check.cwd);
  const candidate=await system.preparePatch(patch.path,patch.revision,patch.edits);
  proposalRequirements(w,'write',candidate);
  const latest=new Map();w.operations.forEach((o,i)=>{const p=o.result?.path||o.arguments?.path;if(o.name==='read_system_file'&&typeof p==='string')latest.set(p,{o,i});});
  const files=[];let bytes=0;
  const manifestPaths=paths=>{
    const manifests=new Set([join(check.cwd,'package.json')]);
    for(const path of paths)for(let dir=dirname(path);inside(check.cwd,dir);dir=dirname(dir))manifests.add(join(dir,'package.json'));
    return manifests;
  };
  for(const [path,{o,i}] of [...latest].sort(([a],[b])=>a.localeCompare(b))){
    if(!path||!inside(check.cwd,path))continue;
    const r=o.result;
    // A failed probe is not a source in the snapshot. Required entries and
    // literal dependencies are checked below, including failed observations.
    if(o.status==='failed'||r?.error)continue;
    if(o.status!=='completed'||r?.error||o.arguments?.offset||r?.truncated||typeof r?.content!=='string'||r.revision!==sha(r.content)||observationNeedsFreshRead(w,i,path))throw needsRead(path,'Read this copy source completely again: '+path);
    await service.projectWorkspaces.target(w.project,path);const actual=await current(system,path);
    if(actual.revision!==r.revision)throw needsRead(path,'Copy source changed. Read it again: '+path);
    bytes+=Buffer.byteLength(actual.content);if(files.length>=32||bytes>262144||relative(check.cwd,path).split('/').length>16)throw new AppError('A test copy is limited to 32 observed files, 256 KiB and 16 path segments. Start a smaller project task.');
    files.push({path,relative:relative(check.cwd,path),revision:actual.revision,content:actual.content});
  }
  for(const path of [candidate.path,...check.args.slice(1).map(p=>join(check.cwd,p))])if(!files.some(f=>f.path===path))throw needsRead(path,'Read this required copy file first: '+path);
  let dependencies;
  if(w.version>=13){
    dependencies=await copyDependencies(files,check.cwd,candidate,async path=>{
      await service.projectWorkspaces.target(w.project,path,{missing:true});
      try{const s=await lstat(path);if(!s.isFile()||s.nlink!==1||await realpath(path)!==path)throw new AppError('Dependency must be a regular file without links: '+path,409);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}
    },w.version>=22&&w.engine!=='chatgpt'?{discover:async path=>{
      await service.projectWorkspaces.target(w.project,path);
      return (await current(system,path)).content;
    }}:{});
    if(w.version>=22&&w.engine!=='chatgpt'){
      const needed=new Set(dependencies.neededReads);
      for(const manifest of manifestPaths([...files.map(f=>f.path),...needed])){
        const exists=await lstat(manifest).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
        if(exists&&!files.some(f=>f.path===manifest))needed.add(manifest);
      }
      dependencies.neededReads=[...needed].sort();
    }
    if(dependencies.neededReads.length||dependencies.missing.length){
      const brief=w.version>=22&&w.engine!=='chatgpt';
      throw Object.assign(new AppError('Copy dependencies need inspection. '+(dependencies.neededReads.length?(brief?'Read the existing files listed in copyReadiness.neededReads. ':'Read these existing files: '+dependencies.neededReads.join(', ')+'. '):'')+(dependencies.missing.length?(brief?'Inspect the paths in copyReadiness.missing or request_help; do not invent a helper. ':'Missing files: '+dependencies.missing.join(', ')+'. Inspect the path or request_help; do not invent a helper. '):'')+'No copy was requested or run.',409),{copyReadiness:dependencies});
    }
  }
  // Node resolves module type from package.json. Never omit an existing root
  // manifest and silently run the copied files under a different module mode.
  const manifests=manifestPaths(files.map(f=>f.path)),absentManifests=[];
  for(const manifest of [...manifests].sort()){
    const exists=await lstat(manifest).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
    if(exists&&!files.some(f=>f.path===manifest))throw needsRead(manifest,'Read the package manifest before preparing its test copy: '+manifest);
    if(!exists)absentManifests.push(manifest);
  }
  // A .js file can inherit its module mode from a package outside the check
  // folder. That parent is deliberately not copied; refuse ambiguous snapshots.
  for(const f of files.filter(f=>f.path.endsWith('.js'))){
    let dir=dirname(f.path),bounded=false;
    for(;;){if(files.some(p=>p.path===join(dir,'package.json'))){bounded=true;break;}if(dir===check.cwd)break;dir=dirname(dir);}
    if(!bounded)throw new AppError('This JavaScript file needs an observed package.json inside the saved check folder to preserve its module context: '+f.path);
  }
  if(bytes-Buffer.byteLength(candidate.before)+Buffer.byteLength(candidate.content)>262144)throw new AppError('The candidate copy exceeds 256 KiB.');
  const snapshot=sha(JSON.stringify({files:files.map(f=>[f.relative,f.revision]),absentManifests})),repairBinding=binding(repair);
  // Identity follows the actual experiment, not an R-number that changes when
  // the model saves the same diagnosis again. The payload still binds its repair.
  const fingerprint=experimentFingerprint({snapshot,candidate,check});
  for(const o of w.operations.filter(o=>o.name==='propose_test_copy'&&o.status==='completed'&&(w.version<13||o.revision===w.revision))){
    let duplicate=o.result?.fingerprint===fingerprint;
    // 1.41.0 receipts included the R-number in their fingerprint. Compare their
    // original reviewed payload too, without rewriting historical approvals.
    if(!duplicate&&o.action){const a=await service.actions.store.get('actions',o.action);if(a.kind==='test_copy'&&a.status==='completed'&&a.workflow?.id===w.id&&a.workflow?.operation===o.id)duplicate=experimentFingerprint(a.payload)===fingerprint;}
    if(duplicate)throw new AppError('These exact files and candidate already have a copy-test result. Inspect that result; change the diagnosis or read changed sources before another test.');
  }
  const payload={...(w.version>=17?{diagnosisVersion:1}:{}),repair:repairBinding,checkId:args.check,check:structuredClone(check),root:check.cwd,candidate,files,absentManifests,snapshot,fingerprint,...dependencies?{dependencies}:{},
    directory:'/tmp/aurora-task-copy-'+randomUUID(),bytes,notice,limits:{files:32,bytes:262144,timeoutMs:10000,outputCharacters:32000},
    warning:'Runs the saved tests twice in isolated copies. Home files and network are unavailable; copied source is read-only. Only the listed observed files are included. Applying the edit requires another approval.'};
  payload.commands=['baseline','candidate'].map(v=>({variant:v,...sandbox(payload,v)}));
  return payload;
}

export async function validateTestCopy(system,payload){
  if(!/^\/tmp\/aurora-task-copy-[0-9a-f-]{36}$/.test(payload.directory)||!supportsCopyCheck(payload.check)||payload.files.length>32||payload.files.reduce((n,f)=>n+Buffer.byteLength(f.content),0)>262144)throw new AppError('Invalid copy-test snapshot.',409);
  if(await system.path(payload.root)!==payload.root)throw new AppError('The saved check folder changed.',409);
  for(const f of payload.files){
    if(!inside(payload.root,f.path)||f.relative!==relative(payload.root,f.path)||f.revision!==sha(f.content))throw new AppError('Invalid copy source binding.',409);
    if((await current(system,f.path)).revision!==f.revision)throw new AppError('A copy source changed since review. Dismiss this request and read the current files: '+f.path,409);
  }
  for(const path of payload.absentManifests)if(await lstat(path).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw new AppError('A package manifest appeared after review. Prepare a new copy snapshot.',409);
  if(!same(payload.commands,['baseline','candidate'].map(v=>({variant:v,...sandbox(payload,v)}))))throw new AppError('Copy commands changed.',409);
}

export async function cleanupInterruptedCopy(payload){
  if(!/^\/tmp\/aurora-task-copy-[0-9a-f-]{36}$/.test(payload.directory))return false;
  const info=await lstat(payload.directory).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(!info)return true;
  if(!info.isDirectory()||info.uid!==process.getuid()||info.mode&0o077)return false;
  const owner=join(payload.directory,'.aurora-copy-owner');
  const marker=await lstat(owner).catch(()=>null);
  if(!marker?.isFile()||marker.nlink!==1||await readFile(owner,'utf8')!==payload.fingerprint)return false;
  await rm(payload.directory,{recursive:true,force:true});return true;
}

export async function guardTestCopy(service,w,payload){
  if(w.version<12||!w.project)throw new AppError('Copy testing requires a new project task.',409);
  if(payload.diagnosisVersion!==(w.version>=17?1:undefined))throw new AppError('Copy review version changed. Prepare a new test request.',409);
  const r=repairPlanContext(w)?.repairs.find(r=>r.id===payload.repair.id),c=w.requirements.commands[Number(payload.checkId.slice(1))-1];
  if(!r||!same(binding(r),payload.repair)||!same(c,payload.check)||r.exampleLedger?.failed||r.expressionCheck?.hasFailedExamples)throw new AppError('The repair, examples or saved check changed. Prepare a new copy test.',409);
  await service.projectWorkspaces.target(w.project,payload.root);
  await service.projectWorkspaces.target(w.project,payload.candidate.path);
  proposalRequirements(w,'write',payload.candidate);
  await validateTestCopy(service.actions.system,payload);
}

export async function executeTestCopy(system,payload,{signal,onProgress=async()=>{}}={}){
  signal?.throwIfAborted();await validateTestCopy(system,payload);
  let owned=false;
  const result={kind:'test_copy',fingerprint:payload.fingerprint,snapshot:payload.snapshot,repair:payload.repair.id,sourceRoot:payload.root,sandboxRoot:'/project',
    candidate:{path:payload.candidate.path,beforeRevision:sha(payload.candidate.before),revision:sha(payload.candidate.content)},check:payload.check,sources:payload.files.map(({path,revision})=>({path,revision})),
    runs:[],notice,content:'Copy tests started; no original file is edited.',cleanedUp:false};
  try{
    await mkdir(payload.directory,{mode:0o700});owned=true;await writeFile(join(payload.directory,'.aurora-copy-owner'),payload.fingerprint,{flag:'wx',mode:0o600});
    for(const command of payload.commands){
      signal?.throwIfAborted();await mkdir(command.cwd,{mode:0o700});await mkdir(command.scratch,{mode:0o700});
      for(const f of payload.files){
        const path=join(command.cwd,f.relative),content=command.variant==='candidate'&&f.path===payload.candidate.path?payload.candidate.content:f.content;
        await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,content,{flag:'wx',mode:0o600});
        if(sha(await readFile(path))!==sha(content))throw new AppError('Copy readback failed.',409);
      }
      const run=await runCommand(command,{signal,timeout:command.timeout}),unchanged=[];
      for(const f of payload.files){const expected=command.variant==='candidate'&&f.path===payload.candidate.path?sha(payload.candidate.content):f.revision;if(sha(await readFile(join(command.cwd,f.relative)))!==expected)unchanged.push(f.relative);}
      const marker=run.content.includes(payload.check.outputIncludes),passed=run.code===0&&!run.stopped&&!run.truncated&&marker&&!unchanged.length;
      result.runs.push({variant:command.variant,...run,marker,passed,outcome:copyOutcome(run,passed),changedFiles:unchanged});
      result.content=result.runs.map(r=>`${r.variant}: ${r.passed?'saved check passed':'saved check did not pass'} (exit ${r.code}, marker ${r.marker?'present':'absent'}).`).join('\n')+'\n'+notice;
      await onProgress(result);
      if(run.stopped||run.truncated){result.stopped=true;break;}
    }
    try{await validateTestCopy(system,payload);result.originalSourcesCurrent=true;}catch(e){result.originalSourcesCurrent=false;result.sourceWarning=e.message;}
  }catch(e){result.stopped=!!signal?.aborted;result.error=e.status?e.message:signal?.aborted?'Copy tests stopped.':'Copy test could not complete.';result.content+='\n'+result.error;}
  finally{
    if(owned){await rm(payload.directory,{recursive:true,force:true});result.cleanedUp=true;}
    result.content+='\nOriginal project was not edited. '+(result.cleanedUp?'Temporary copies removed.':'No owned copy directory to remove.');
  }
  if(payload.diagnosisVersion===1)result.diagnosis=copyDiagnosis(payload,result);
  return result;
}

export function copyResultForModel(result){
  return {kind:result.kind,fingerprint:result.fingerprint,repair:result.repair,notice:result.notice,sourceRoot:result.sourceRoot,sandboxRoot:result.sandboxRoot,
    ...(result.diagnosis?{diagnosis:copyDiagnosisForModel(result.diagnosis)}:{}),originalSourcesCurrent:result.originalSourcesCurrent,sourceWarning:result.sourceWarning,error:result.error,stopped:result.stopped,cleanedUp:result.cleanedUp,
    runs:result.runs?.map(r=>({variant:r.variant,code:r.code,passed:r.passed,outcome:r.outcome,marker:r.marker,stopped:r.stopped,truncated:r.truncated,...(result.diagnosis?.status==='compared'?{outputInDiagnosis:true,notice:'Observed failures are in diagnosis; complete output is retained in the journal.'}:{outputExcerpted:r.content.length>1400,content:r.content.slice(0,1400)})}))};
}
