import {AppError,sha} from './vault.mjs';
import {isProjectRepair} from './workflow-prompt.mjs';
import {sourceLines,observationNeedsFreshRead} from './workflow-tools.mjs';
import {resolveEvidence,evidenceHandle} from './workflow-evidence.mjs';

export const sourceLinesTool={type:'function',function:{name:'inspect_source_lines',description:'Inspect exact numbered lines from a current complete file snapshot when its display was shortened. No disk reread or new completion evidence. Use the source E-number, a 1-based startLine and count (1–40). Preserve literal whitespace; character offsets are not line numbers.',parameters:{type:'object',properties:{evidence:{type:'string'},startLine:{type:'integer',minimum:1},count:{type:'integer',minimum:1,maximum:40}},required:['evidence','startLine','count'],additionalProperties:false}}};

function source(w,evidence){
  const id=resolveEvidence(w,evidence),index=w.operations.findIndex(o=>o.id===id),op=w.operations[index],r=op?.result;
  if(w.version<16||!isProjectRepair(w)||op?.name!=='read_system_file'||op.status!=='completed'||r?.error||op.arguments?.offset||r?.truncated||typeof r?.content!=='string'||r.revision!==sha(r.content)||observationNeedsFreshRead(w,index,r.path)||w.operations.findLast(o=>o.name==='read_system_file'&&(o.result?.path||o.arguments?.path)===r.path)!==op)throw new AppError('Choose the latest complete, unredacted, current file read. If it is partial or historical, read the whole file again first.');
  return op;
}

export function inspectSourceLines(w,args){
  const requestedCount=args?.count,limited=w.version>=23&&w.engine!=='chatgpt'&&Number.isInteger(requestedCount)&&requestedCount>40&&requestedCount<=120;
  const count=limited?40:requestedCount;
  if(!args||Array.isArray(args)||Object.keys(args).some(k=>!['evidence','startLine','count'].includes(k))||typeof args.evidence!=='string'||!/^E[1-9]\d?$/.test(args.evidence)||!Number.isInteger(args.startLine)||args.startLine<1||!Number.isInteger(count)||count<1||count>40)throw new AppError('Supply evidence, a positive 1-based startLine and count from 1 to 40.');
  const op=source(w,args.evidence),lines=sourceLines(op.result.content),out=[];
  if(args.startLine>lines.length)throw new AppError(`This snapshot has ${lines.length} lines. Choose an existing starting line.`);
  for(let n=args.startLine;n<=Math.min(lines.length,args.startLine+count-1);n++){
    const line=`${n}: ${lines[n-1].text}`;
    if(Buffer.byteLength([...out,line].join('\n'))>2400)break;
    out.push(line);
  }
  if(!out.length)throw new AppError('This source line exceeds the bounded line view. Inspect it with ordinary file tools; no partial line was returned.');
  const endLine=args.startLine+out.length-1;
  return {sourceEvidence:evidenceHandle(w,op.id),path:op.result.path,revision:op.result.revision,startLine:args.startLine,endLine,totalLines:lines.length,nextLine:endLine<lines.length?endLine+1:null,numberedLines:out.join('\n'),snapshotOnly:true,displayExcerpted:args.startLine>1||endLine<lines.length,...limited?{requestedCount,countLimitedTo:40}:{},notice:(limited?'Requested '+requestedCount+' lines; limited to 40. Use nextLine for another view. ':'')+'Excerpt of the saved source, not a fresh disk read or proof of completion. Line labels are not source text. Edits still require the complete source snapshot and exact approval.'};
}

export function currentSourceLines(w,op){
  if(op.name!=='inspect_source_lines'||op.status!=='completed'||op.result?.error)return false;
  try{return source(w,op.result.sourceEvidence).result.revision===op.result.revision;}catch{return false;}
}
