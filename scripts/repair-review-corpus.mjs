// Fixed development/evaluation fixtures, never model output or personal files.
// Labels, partitions, oracle expectations and names stay outside reviewer input.
import {diagnosisCases} from './repair-diagnosis-cases.mjs';
import {sha} from '../src/vault.mjs';
export const reviewAspects=['behavior','scope','examples'];
const width='Math.max(value.width,area.width)',minimum='Math.min(value.width,area.width)';
export function applyCandidate(input){
 const f=input.files.find(f=>f.path===input.candidate.path);if(!f||f.revision!==sha(f.content))throw Error('Candidate source is missing or changed.');
 const {line,before,after}=input.candidate,lines=f.content.split('\n'),text=lines[line-1];
 if(!Number.isInteger(line)||!before||typeof after!=='string'||/[\r\n]/.test(before+after)||text===undefined||text.indexOf(before)<0||text.indexOf(before)!==text.lastIndexOf(before))throw Error('Candidate must replace one exact observed fragment.');
 lines[line-1]=text.replace(before,()=>after);return {path:f.path,content:lines.join('\n'),revision:sha(lines.join('\n')),notice:'Computed preview of this exact replacement; not an observation or executed code.'};
}
const statuses=(behavior,scope,examples='not_supplied')=>({behavior,scope,examples});
export function expectedVerdict(expected){return Object.values(expected).includes('problem')?'revise':Object.values(expected).includes('unknown')?'uncertain':'supported';}
export async function repairReviewCases(){
 const legacy=await diagnosisCases(),out=legacy.map(c=>({...structuredClone(c),partition:['width_min','margin_subtract','conditional_width','unbound_margins'].includes(c.name)?'development':'evaluation',expected:statuses(c.expected==='supported'?'supported':'problem',['conditional_width','default_margins','minimum_floor','neighbor_height','unbound_margins'].includes(c.name)?'problem':'supported'),oracle:'execute'}));
 const add=(base,name,after,expected,rubric,mutate,oracle='execute')=>{
  const c=structuredClone(legacy[base]);Object.assign(c,{name,partition:'evaluation',expected,rubric,oracle});c.input.candidate.after=after;c.input.candidate.reason='Repair the stated geometry defect while preserving other behavior.';mutate?.(c.input);out.push(c);
 };
 add(0,'width_ternary','value.width<area.width?value.width:area.width',statuses('supported','supported'),'The equivalent minimum handles both orderings and equality without changing height or position.');
 add(1,'margin_grouped','width-(left+right)',statuses('supported','supported'),'Parenthesized subtraction preserves scaled/rotated width and both margins.');
 add(0,'width_after_margin',minimum,statuses('supported','supported'),'Only width remains; the other module already has its correct subtraction.',input=>{const f=input.files[1];f.content=f.content.replace('width:width+left+right','width:width-left-right');f.revision=sha(f.content);input.notice='The margin repair is already present. Review only this pending width candidate.';});
 add(1,'early_margin_initialization','const width=Math.round((rotated?m.height:m.width)/m.scale)-left-right,height=Math.round((rotated?m.width:m.height)/m.scale);',statuses('problem','problem'),'The candidate reads left/right before their const initialization and leaves the faulty return expression unchanged.',input=>{input.candidate.line=8;input.candidate.before=input.files[1].content.split('\n')[7].trim();});
 add(1,'correct_repair_wrong_example','width-left-right',statuses('supported','supported','problem'),'The repair is correct but the supplied width 1280 is inconsistent with the cited logical width 720; its claimed result 700 is also arithmetically false.',input=>{input.examples=[{inputs:{width:1280,left:10,right:10},expected:700,expression:'width-left-right',basis:{source:'goal',quote:'720 minus 10 on each side gives 700'}}];});
 add(0,'neighbor_reordering','const width=Math.min(value.width,area.width),height=Math.min(area.height,value.height);',statuses('supported','problem'),'Finite geometry is correct, but the previously correct height expression is changed despite the expression-only scope.',input=>{input.candidate.before='const width='+width+',height=Math.min(value.height,area.height);';});
 add(1,'missing_width_helper','width-left-right',statuses('unknown','supported'),'The imported width helper is not supplied; its conversion/rotation behavior cannot be assessed from this packet.',input=>{
  const f=input.files[1];f.content=f.content.replace("import {execFile} from 'node:child_process';","import {execFile} from 'node:child_process';\nimport {logicalWidth} from './monitor-math.mjs';").replace('Math.round((rotated?m.height:m.width)/m.scale)','logicalWidth(m)');f.revision=sha(f.content);
  input.candidate.line++;
  input.notice='Source includes a helper import whose implementation was not observed. Do not assume its behavior.';
 },'missing');
 add(1,'conflicting_margin_test','width-left-right',statuses('unknown','supported'),'The goal requires 700 but the immutable supplied test expects 740 for the same monitor. Clarification is required before judging support.',input=>{const f=input.files[2];f.content=f.content.replace('width:700,height:1230','width:740,height:1230');f.revision=sha(f.content);},'conflict');
 for(const c of out){c.input.examples??=[];c.expectedVerdict=expectedVerdict(c.expected);applyCandidate(c.input);}
 return out;
}
