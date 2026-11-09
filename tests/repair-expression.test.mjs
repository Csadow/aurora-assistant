import test from 'node:test';
import assert from 'node:assert/strict';
import {parseExpression,evaluateExpression,expressionExamples} from '../src/repair-expression.mjs';
const calc=(s,inputs={})=>evaluateExpression(parseExpression(s),inputs);

test('expression interpreter respects arithmetic precedence, strict conditions and supported Math calls',()=>{
  for(const [s,value] of [['2+3*4',14],['(2+3)*4',20],['20/2/5',2],['10-3-2',5],['-2*-3+ +1',7],['.5+1e2',100.5],['10%3',1],['Math.min(8,Math.max(2,3))',3],['Math.round(-1.5)',-1],['Math.floor(1.9)+Math.ceil(1.1)+Math.trunc(-1.9)+Math.abs(-2)',4],['1<2 && !(3<=2) || false',true],['true ? 3 : 1/0',3],['false ? 1 : true ? 2 : 3',2],['false && absent',false],['true || absent',true],['true !== 1',true],['2===2',true]])assert.equal(calc(s),value,s);
  assert.equal(calc('(rotated ? m.height : m.width)/m.scale',{'rotated':true,'m.height':1080,'m.width':1920,'m.scale':1.5}),720);
});
test('expression interpreter rejects execution, property access, coercion and unbounded syntax',()=>{
  for(const s of ['process.exit()','globalThis.x','x.constructor','x.__proto__','Math.random()','Math["max"](1,2)','Math.max.call(null,1,2)','(()=>1)()','new Date()','a=1','a++','1;2','"1"+2','[1,2]','{a:1}','1/**/+2','2**3','010','Infinity','NaN','1e999','Math.round(1,2)','Math.max()','1?2:3','true+1','1&&2'])assert.throws(()=>calc(s),undefined,s);
  for(const s of ['x'.repeat(513),'('.repeat(26)+'1'+')'.repeat(26),Array(82).fill('1').join('+')])assert.throws(()=>calc(s));
  assert.throws(()=>calc('a',{a:{value:1}}));assert.throws(()=>calc('a',JSON.parse('{"__proto__":1,"a":2}')));assert.throws(()=>calc('missing'));assert.throws(()=>calc('1/0'));assert.throws(()=>calc('1e308*1e308'));
  for(const s of ['a+++b','a---b','--1','++1','1==1','1!=2','1<<2'])assert.throws(()=>calc(s,{a:1,b:2}));
});
test('computed examples distinguish failure, missing input and exact floating-point results',()=>{
  const r=expressionExamples('a+b','a-b',[{inputs:{a:720,b:20},expected:700}]);
  assert.equal(r[0].before.value,740);assert.equal(r[0].after.value,700);assert.equal(r[0].matches,true);
  assert.throws(()=>expressionExamples('a+b','a-b',[{inputs:{a:1},expected:0}]),/missing inputs: b/);
  assert.throws(()=>expressionExamples('a','true ? a : b',[{inputs:{a:1},expected:1}]),/missing inputs: b/);
  const divide=expressionExamples('a','a/b',[{inputs:{a:1,b:0},expected:0}])[0];assert.match(divide.after.error,/division by zero/);assert.equal(divide.matches,false);
  assert.equal(expressionExamples('0.1','0.1+0.2',[{inputs:{},expected:0.3}])[0].matches,false,'no undisclosed tolerance');
  for(const c of [[],Array(7).fill({inputs:{},expected:0}),[{inputs:{},expected:Infinity}],[{inputs:{},expected:'0'}],[{inputs:{a:[]},expected:0}],[{inputs:{},expected:0,override:true}]])assert.throws(()=>expressionExamples('0','1',c));
});

test('retained arithmetic failures are detected while passing floors remain only partial coverage',()=>{
  const before='Math.max(value.width,area.width)',cases=[{inputs:{'value.width':700,'area.width':1280},expected:700},{inputs:{'value.width':460,'area.width':320},expected:320}];
  for(const after of ['Math.min(Math.max(value.width,area.width),area.width)','Math.round(Math.min(Math.max(value.width,area.width),area.width))'])assert.equal(expressionExamples(before,after,cases)[0].matches,false);
  assert(expressionExamples(before,'Math.min(value.width,area.width)',cases).every(r=>r.matches));
  const floor='Math.min(Math.max(value.width,340),area.width)';assert(expressionExamples(before,floor,cases).every(r=>r.matches),'the given cases do not catch an unrequested floor');
  assert.equal(expressionExamples(before,floor,[{inputs:{'value.width':200,'area.width':1280},expected:200}])[0].matches,false);
  const monitor={inputs:{rotated:true,'m.height':1080,'m.width':1920,'m.scale':1.5,left:10,right:10},expected:700};
  assert.equal(expressionExamples('Math.round((rotated?m.height:m.width)/m.scale)-left-right','Math.round(((rotated?m.height:m.width)-left-right)/m.scale)',[monitor])[0].matches,false);
  assert(expressionExamples('width+left+right','width-left-right',[{inputs:{width:720,left:10,right:10},expected:700}])[0].matches);
});
