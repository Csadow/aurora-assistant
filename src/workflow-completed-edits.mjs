import {sha} from './vault.mjs';
import {evidenceHandle} from './workflow-evidence.mjs';
import {observationNeedsFreshRead} from './workflow-tools.mjs';

// Model-view receipts only. The full journal remains authoritative, including
// corrections from replaced lists and previous task revisions. A completed write
// does not establish current source, program correctness or task completion.
export function completedEditReceipts(w){
  return w.operations.flatMap((op,index)=>{
    if(op.status!=='completed'||!op.expected)return [];
    const {path,revision}=op.expected;
    const plan=w.operations.slice(0,index).findLast(p=>p.name==='record_repair_plan'&&p.status==='completed'&&p.revision===op.revision&&p.result?.repairs?.some(r=>r.id===op.repair));
    const repair=plan?.result.repairs.find(r=>r.id===op.repair);
    const readIndex=w.operations.findLastIndex(o=>o.name==='read_system_file'&&(o.result?.path||o.arguments?.path)===path),read=w.operations[readIndex],r=read?.result;
    const fresh=readIndex>index&&read?.status==='completed'&&!r?.error&&!read.arguments?.offset&&!r?.truncated&&typeof r?.content==='string'&&r.revision===sha(r.content)&&!observationNeedsFreshRead(w,readIndex,path);
    const after=repair?.expressionBinding?.status==='bound'?repair.expressionBinding.after:repair?.after;
    return [{evidence:evidenceHandle(w,op.id),path,revision,...op.repair?{repair:op.repair}:{},
      ...(after!==undefined?{applied:{line:repair.line,after:after.slice(0,240),truncated:after.length>240}}:{}),
      currentFile:fresh?{source:evidenceHandle(w,read.id),state:r.revision===revision?'matches_write':'changed_since_write'}:{state:'unobserved_since_write_or_restart'}}];
  });
}
