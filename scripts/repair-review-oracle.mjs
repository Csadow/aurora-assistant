// Execute ONLY repository-defined fixture candidates, never reviewer output.
// vm is used for deterministic function evaluation, not as a security boundary.
import {runInNewContext} from 'node:vm';
import {expressionExamples} from '../src/repair-expression.mjs';
import {sha} from '../src/vault.mjs';
import {repairReviewCases,applyCandidate} from './repair-review-corpus.mjs';
const quickInputs=[
 [{width:700,height:900,position:{x:2040,y:-900}},{x:-1280,y:30,width:1280,height:690}],
 [{width:460,height:680,position:null},{x:0,y:0,width:320,height:350}],
 [{width:200,height:180,position:null},{x:0,y:0,width:1280,height:720}],
 [{width:900,height:800,position:{x:0,y:0}},{x:0,y:0,width:320,height:350}],
 [{width:320,height:350,position:null},{x:10,y:20,width:320,height:350}],
 [{width:300.5,height:100.25,position:null},{x:5,y:-40,width:600.75,height:400.5}]
];
const monitorInputs=[
 {x:-1000,y:0,width:1920,height:1080,scale:1.5,transform:1,reserved:[10,30,10,20]},
 {x:0,y:0,width:1920,height:1080,scale:1,transform:0,reserved:[0,0,0,0]},
 {x:50,y:-20,width:1000,height:800,scale:2,transform:0,reserved:[15,7,25,9]},
 {x:0,y:0,width:1280,height:720,scale:1,transform:0},
 {x:-700,y:40,width:1200,height:900,scale:1.25,transform:3,reserved:[4,9,12,3]}
];
// Independent reference equations, no call to either production implementation.
const quickReference=([v,a])=>{
 const width=v.width<a.width?v.width:a.width,height=v.height<a.height?v.height:a.height;
 const bound=(n,start,end)=>Math.round(n<start?start:n>end?end:n);
 return {width,height,x:bound(Number.isFinite(v.position?.x)?v.position.x:a.x+(a.width-width)/2,a.x,a.x+a.width-width),y:bound(Number.isFinite(v.position?.y)?v.position.y:a.y+(a.height-height)/2,a.y,a.y+a.height-height)};
};
const monitorReference=m=>{
 const [left,top,right,bottom]=m.reserved??[0,0,0,0],swapped=(m.transform&1)!==0;
 return {x:m.x+left,y:m.y+top,width:Math.round((swapped?m.height:m.width)/m.scale)-(left+right),height:Math.round((swapped?m.width:m.height)/m.scale)-(top+bottom)};
};
export async function reviewOracle(name,input){
 const fixed=(await repairReviewCases()).find(c=>c.name===name);
 if(!fixed||sha(JSON.stringify(fixed.input))!==sha(JSON.stringify(input)))throw Error('Oracle accepts only unchanged built-in fixtures, never arbitrary or model-generated code.');
 if(fixed.oracle!=='execute')return {status:'not_executed',reason:fixed.rubric};
 const preview=applyCandidate(input),quick=preview.path.endsWith('quick-window.mjs'),start=preview.content.indexOf('export function '+(quick?'quickBounds':'monitorArea')+'('),end=preview.content.indexOf(quick?'export class QuickWindowSettings':'export async function desktopWindow',start);
 if(start<0||end<0)throw Error('Fixture function boundaries changed.');
 const code=preview.content.slice(start,end).replace('export function','function'),fn=quick?'quickBounds':'monitorArea',matrix=quick?quickInputs:monitorInputs;
 const cases=matrix.map(input=>{
  const expected=quick?quickReference(input):monitorReference(input);let actual,error;
  try{actual=JSON.parse(JSON.stringify(runInNewContext(code+'\n'+fn+'(...args)',{args:structuredClone(quick?input:[input])},{timeout:200})));}catch(e){error=e.message;}
  return {input,expected,...error?{error}:{actual},matches:!error&&JSON.stringify(actual)===JSON.stringify(expected)};
 });
 const examples=(input.examples||[]).map(e=>expressionExamples(e.expression,e.expression,[{inputs:e.inputs,expected:e.expected}])[0]);
 return {status:'executed',passed:cases.every(c=>c.matches),cases,examples,notice:'Finite, independently specified geometry cases for the target function only. Does not establish scope compliance or complete correctness.'};
}
