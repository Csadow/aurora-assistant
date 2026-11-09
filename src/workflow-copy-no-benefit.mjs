import {sha} from './vault.mjs';
import {evidenceHandle} from './workflow-evidence.mjs';
import {sourceLines} from './workflow-tools.mjs';

// A passing copy on both sides is limited evidence. In a repair task that
// already applied one edit, it is a reason to reconsider another saved edit,
// not proof that the second change is wrong in all untested cases.
export function copyNoBenefitReview(w,repair){
 if(w.version<27||w.engine!=='local'||!repair?.id||!repair.currentRead)return null;
 const source=w.operations.findLast(o=>o.name==='read_system_file'&&(o.result?.path||o.arguments?.path)===repair.path);
 if(source?.status!=='completed'||source.result?.truncated||typeof source.result?.content!=='string'||source.result.revision!==sha(source.result.content))return null;
 const line=sourceLines(source.result.content)[repair.line-1],offset=line?.text.indexOf(repair.before);
 if(!line||offset<0||line.text.indexOf(repair.before,offset+1)>=0)return null;
 const position=line.start+offset,candidate=source.result.content.slice(0,position)+repair.after+source.result.content.slice(position+repair.before.length),candidateRevision=sha(candidate);
 const index=w.operations.findLastIndex(o=>o.name==='propose_test_copy'&&o.status==='completed'&&o.action&&o.result?.kind==='test_copy'&&o.result?.diagnosis?.change?.path===repair.path&&o.result.diagnosis.change.sourceRevision===source.result.revision&&o.result.diagnosis.change.candidateRevision===candidateRevision);
 if(index<0)return null;
 const op=w.operations[index],d=op.result.diagnosis;
 if(d.status!=='compared'||d.baseline?.counts?.fail!==0||d.candidate?.counts?.fail!==0||d.baseline?.counts?.pass<1||d.baseline.counts.pass!==d.candidate.counts.pass||d.resolved!==0||d.newlyFailing!==0||d.stillFailing!==0||!Array.isArray(d.changes)||d.changes.some(c=>c.baseline!==c.candidate))return null;
 if(!w.operations.slice(0,index).some(o=>o.status==='completed'&&o.expected?.path===repair.path&&o.action))return null;
 if(w.operations.slice(index+1).some(o=>o.status==='completed'&&o.expected?.path===repair.path&&o.action))return null;
 return {copy:evidenceHandle(w,op.id),repair:repair.id,path:repair.path,passed:d.baseline.counts.pass,notice:'The saved tests reported the same passing cases before and after this candidate. This is not proof about behavior outside those tests or authorization to edit.'};
}
