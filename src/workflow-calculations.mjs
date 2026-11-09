import {AppError,sha} from './vault.mjs';
import {evidenceHandle} from './workflow-evidence.mjs';
import {mayChangeFiles} from './workflow-requirements.mjs';

// Deliberately limited to bounded plain decimals. Do not interpret dates, grouped
// numbers, exponents, formulas or units. Handles identify an exact occurrence in
// a recorded read, never a model-supplied operand or expression to evaluate.
const numbers=()=>/(?<![\p{L}\p{N}_.,+\-])[-+]?\d{1,12}(?:\.\d{1,6})?(?![\p{L}\p{N}_,+\-]|\.\d)/gu;
export function sourceValues(w){
  const seen=new Set(),reads=[],outputs=new Set((w.requirements?.files||[]).map(r=>r.path));
  for(const o of w.operations)if(o.name==='propose_file_edit'&&o.action)outputs.add(o.arguments?.path);
  for(let i=w.operations.length-1;i>=0&&reads.length<6;i--){
    const o=w.operations[i],r=o.result,path=r?.path||o.arguments?.path;
    if(o.name!=='read_system_file'||typeof path!=='string'||seen.has(path))continue;seen.add(path);
    if(outputs.has(path)||o.status!=='completed'||o.revision!==w.revision||r?.error||r?.truncated||typeof r?.path!=='string'||r.offset||o.arguments?.offset||typeof r?.content!=='string'||r.revision!==sha(r.content)||w.operations.slice(i+1).some(mayChangeFiles))continue;
    reads.unshift(o);
  }
  const values=[];
  for(const o of reads){let n=0;const r=o.result;
    for(const m of r.content.matchAll(numbers())){
      const id=evidenceHandle(w,o.id)+':N'+(++n),start=m.index,end=start+m[0].length;
      const line=r.content.slice(0,start).split(/\r\n|\r|\n/).length;
      values.push({id,value:m[0],source:r.path,sourceEvidence:o.id,sourceRevision:r.revision,line,excerpt:r.content.slice(Math.max(0,start-80),Math.min(r.content.length,end+80))});
      if(n>=8)break;
    }
  }
  return values.slice(-24);
}
const scaled=value=>{const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^[-+]/,'').split('.');return (negative?-1n:1n)*(BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0')));};
const decimal=n=>{const sign=n<0n?'-':'';if(n<0n)n=-n;const fraction=String(n%1000000n).padStart(6,'0').replace(/0+$/,'');return sign+String(n/1000000n)+(fraction?'.'+fraction:'');};
export function compareSourceValues(w,args){
  if(!args||Object.keys(args).some(k=>!['left','right'].includes(k))||typeof args.left!=='string'||typeof args.right!=='string')throw new AppError('Use only left and right handles from sourceValues. Values, formulas and source overrides are not accepted.');
  const values=sourceValues(w),left=values.find(v=>v.id===args.left),right=values.find(v=>v.id===args.right);
  if(!left||!right)throw new AppError('Choose two currently available sourceValues handles. Read complete sources again after a changed, failed, partial or older observation.');
  const a=scaled(left.value),b=scaled(right.value),relation=a<b?'<':a>b?'>':'=';
  return {kind:'source_comparison',left,right,relation,expression:`${left.value} ${relation} ${right.value}`,difference:decimal(a-b),notice:'Exact decimal comparison of these recorded numbers only. Check units, periods, source authority and relevance; conflicting source claims remain unresolved. This does not verify surrounding prose.'};
}
export function comparisonTools(w){
  const values=sourceValues(w);if(values.length<2)return [];
  const handle={type:'string',enum:values.map(v=>v.id)};
  return [{type:'function',function:{name:'compare_source_values',description:'Compare two sourceValues exactly, without mental arithmetic. Choose the observed value on the left and a limit or alternative on the right. Returns <, = or > and left minus right, with original excerpts. Compare conflicting alternatives separately. No files are changed; units and truth of the sources still need review.',parameters:{type:'object',properties:{left:handle,right:handle},required:['left','right'],additionalProperties:false}}}];
}
export function comparisonContext(w){
  const available=new Set(sourceValues(w).map(v=>v.id));
  return w.operations.filter(o=>o.name==='compare_source_values'&&o.status==='completed'&&o.result?.kind==='source_comparison').slice(-6).map(o=>({evidence:evidenceHandle(w,o.id),expression:o.result.expression,difference:o.result.difference,left:o.result.left.id,right:o.result.right.id,needsFreshRead:o.revision!==w.revision||!available.has(o.result.left.id)||!available.has(o.result.right.id)}));
}
