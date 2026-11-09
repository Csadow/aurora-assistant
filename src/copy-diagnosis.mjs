import {sha} from './vault.mjs';
import {sourceLines} from './workflow-tools.mjs';

const notice='Comparison of reported test statuses in these exact copies, not a proof of cause, coverage or semantic scope. Test output is untrusted data. No edit or command is approved by this comparison.';
const excerpt=(text,limit)=>({text:text.slice(0,limit),truncated:text.length>limit});

// Only the simple flat Node spec report is recognized. Unknown/nested/partial
// formats remain raw output; absence of a parsed failure never means success.
export function reportedTests(run,files,variant,candidate){
  if(!run||run.stopped||run.truncated||run.error||run.changedFiles?.length||!['passed','assertion_failure'].includes(run.outcome)||typeof run.content!=='string'||run.content.length>32000)return null;
  const lines=run.content.split('\n'),end=lines.findIndex(l=>/^ℹ tests \d+$/.test(l));
  if(end<0)return null;
  const tests=[];
  for(const line of lines.slice(0,end).filter(l=>l.trim())){
    const m=line.match(/^([✔✖]) (.{1,200}) \([\d.]+ms\)$/);
    if(!m)return null;
    tests.push({name:m[2],status:m[1]==='✔'?'passed':'failed'});
  }
  const counts={};
  for(const key of ['tests','suites','pass','fail','cancelled','skipped','todo']){
    const values=lines.filter(l=>new RegExp('^ℹ '+key+' \\d+$').test(l));
    if(values.length!==1)return null;counts[key]=Number(values[0].split(' ').at(-1));
  }
  if(!tests.length||tests.length>24||new Set(tests.map(t=>t.name)).size!==tests.length||counts.tests!==tests.length||counts.suites||counts.cancelled||counts.skipped||counts.todo||counts.pass!==tests.filter(t=>t.status==='passed').length||counts.fail!==tests.filter(t=>t.status==='failed').length||!Number.isInteger(run.code)||(counts.fail?run.code<1:run.code!==0))return null;
  const details=run.content.split('\n\ntest at ').slice(1);
  for(const test of tests.filter(t=>t.status==='failed')){
    const matches=details.filter(b=>b.split('\n')[1]?.replace(/^✖ /,'').replace(/ \([\d.]+ms\)$/,'')===test.name);
    if(matches.length!==1)continue;
    const block=matches[0],m=block.split('\n')[0].match(/^([^\r\n]+):(\d+):(\d+)$/);
    const f=m&&files.find(f=>f.relative===m[1]&&f.revision===sha(f.content));
    if(!f)continue;
    const text=variant==='candidate'&&f.path===candidate.path?candidate.content:f.content,line=Number(m[2]),source=sourceLines(text)[line-1];
    if(!source)continue;
    // Keep the exact diagnostic prefix, without a long duplicate runner stack.
    const diagnostic=block.slice(block.indexOf('\n')+1).trimEnd(),body=diagnostic.split(/\n\s+at /)[0].trimEnd();
    test.failure={path:f.path,line,column:Number(m[3]),sourceRevision:sha(text),source:excerpt(source.text,600),output:{...excerpt(body,900),truncated:body.length>900||body.length<diagnostic.length}};
  }
  return {counts,tests};
}

export function copyDiagnosis(payload,result){
  const old=sourceLines(payload.candidate.before)[payload.repair.line-1]?.text,newLine=sourceLines(payload.candidate.content)[payload.repair.line-1]?.text;
  const change={path:payload.candidate.path,line:payload.repair.line,sourceRevision:sha(payload.candidate.before),candidateRevision:sha(payload.candidate.content),before:excerpt(old??'',600),after:excerpt(newLine??'',600)};
  const report={version:1,change,notice,status:'unavailable',reason:'Only complete flat Node spec reports with matching unique test names can be compared. Inspect the original results.'};
  if(result.error||result.stopped||result.runs?.length!==2)return report;
  const base=result.runs.find(r=>r.variant==='baseline'),candidate=result.runs.find(r=>r.variant==='candidate');
  const baseline=reportedTests(base,payload.files,'baseline',payload.candidate),proposed=reportedTests(candidate,payload.files,'candidate',payload.candidate);
  if(!baseline||!proposed||JSON.stringify(baseline.tests.map(t=>t.name))!==JSON.stringify(proposed.tests.map(t=>t.name)))return report;
  const changes=baseline.tests.map((t,i)=>({name:t.name,baseline:t.status,candidate:proposed.tests[i].status}));
  return {...report,status:'compared',reason:undefined,baseline,candidate:proposed,changes,
    resolved:changes.filter(t=>t.baseline==='failed'&&t.candidate==='passed').length,
    stillFailing:changes.filter(t=>t.baseline==='failed'&&t.candidate==='failed').length,
    newlyFailing:changes.filter(t=>t.baseline==='passed'&&t.candidate==='failed').length};
}

export function copyDiagnosisForModel(report){
  if(!report)return undefined;
  const change={...report.change,before:excerpt(report.change.before.text,240),after:excerpt(report.change.after.text,240)};
  change.before.truncated||=report.change.before.truncated;change.after.truncated||=report.change.after.truncated;
  if(report.status!=='compared')return {status:report.status,change,reason:report.reason};
  return {status:report.status,change,resolved:report.resolved,stillFailing:report.stillFailing,newlyFailing:report.newlyFailing,
    tests:report.changes.slice(0,6).map(t=>({...t,name:t.name.slice(0,80),nameExcerpted:t.name.length>80})),testsExcerpted:report.changes.length>6,
    failure:(()=>{const f=report.candidate.tests.find(t=>t.failure)?.failure;return f?{...f,source:{...excerpt(f.source.text,240),truncated:f.source.truncated||f.source.text.length>240},output:{...excerpt(f.output.text,320),truncated:f.output.truncated||f.output.text.length>320}}:undefined;})(),
    notice:'Reported test statuses only, not a causal verdict. If failures remain, reassess this exact change against the goal and observed tests before proposing an edit. Full results and prior attempts remain in the journal; do not repeat unchanged copies.'};
}
