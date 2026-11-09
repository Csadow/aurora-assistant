import test from 'node:test';
import assert from 'node:assert/strict';
import {bindRepairExpression} from '../src/repair-expression-binding.mjs';

const bind=(content,before,after,line=1)=>bindRepairExpression({content,before,after,line});
test('binding finds complete expression slots for fragments, operators and whole lines',()=>{
 const content='  const width=Math.max(a,b),height=Math.min(c,d); // unchanged\n';
 for(const [before,after] of [['max','min'],['Math.max','Math.min'],['Math.max(a,b)','Math.min(a,b)'],[content.trimEnd().trimStart(),content.trimEnd().trimStart().replace('Math.max','Math.min')]]){
  assert.deepEqual(bind(content,before,after),{status:'bound',column:15,before:'Math.max(a,b)',after:'Math.min(a,b)',requiredInputs:['a','b'],introducedInputs:[]});
 }
 for(const text of ['return width+left+right;','return {x:x+left,width:width+left+right,height:height-top-bottom};','width=width+left+right;','export const width=width+left+right;','width+left+right;']){
  const r=bind(text,'width+left+right','width-left-right');assert.equal(r.status,'bound');assert.equal(r.before,'width+left+right');assert.deepEqual(r.requiredInputs,['width','left','right']);
 }
 const nested=bind('const width=Math.round((rotated?m.height:m.width)/m.scale);','m.scale','m.scale-left');assert.equal(nested.status,'bound');assert.equal(nested.before,'Math.round((rotated?m.height:m.width)/m.scale)');assert.deepEqual(nested.introducedInputs,['left']);
});
test('binding never hides a second changed expression or structural change',()=>{
 for(const [a,b] of [['const w=Math.max(a,b),h=Math.min(c,d);','const w=Math.min(a,b),h=Math.max(c,d);'],['return {width:a+b,height:c-d};','return {width:a-b,height:c+d};']])assert.equal(bind(a,a,b).status,'ambiguous');
 for(const [a,b] of [['const w=a+b;','const other=a-b;'],['const w=a+b;','let w=a-b;'],['return {width:a+b};','return {height:a-b};'],['const w=a+b;','const w=a-b; other();']])assert.notEqual(bind(a,a,b).status,'bound');
 assert.notEqual(bind('const width=a+b+a+b;','a+b','a-b').status,'bound');
 const repeated=bind('const x=a+b,y=a+b;','y=a+b','y=a-b');assert.equal(repeated.status,'bound');assert.equal(repeated.column,15);
});
test('comments, strings, templates and regex contexts cannot masquerade as bound code',()=>{
 for(const content of ['// const width=a+b;','/* const width=a+b; */','const text="const width=a+b;";','const text=`const width=a+b;`;','const r=/a+b/;'])assert.notEqual(bind(content,'a+b','a-b').status,'bound',content);
 for(const prefix of ['/*\n','const t=`\n','const t="escaped\\\n','const r=/["/*]/;\n'])assert.notEqual(bind(prefix+'const width=a+b;','a+b','a-b',2).status,'bound',prefix);
 for(const after of ['"a-b"','a-b // ignored','a-b /*','a-b; other()'])assert.notEqual(bind('const width=a+b;','a+b',after).status,'bound',after);
 assert.equal(bind('/* note */ const width=a+b; // note','a+b','a-b').status,'bound');
 assert.equal(bind('const rotated=true;\nconst width=Math.round((rotated?m.height:m.width)/m.scale),height=1;\nreturn {width:width+left+right,height:height};','width+left+right','width-left-right',3).status,'bound');
});
test('binding respects scalar-language and resource limits without partial-expression fallback',()=>{
 for(const text of ['const w=Number(a+b);','const w=a?.width+b;','const w=values[0]+b;','const w=a**b;','const w=a==b;'])assert.notEqual(bind(text,text,text.replace('b','c')).status,'bound');
 assert.notEqual(bind('const w='+Array(82).fill('a').join('+')+';','const w=','let w=').status,'bound');
 const wide='const w='+Array.from({length:17},(_,i)=>'v'+i).join('+')+';';assert.notEqual(bind(wide,'v0','v0+1').status,'bound');
 assert.notEqual(bind('x'.repeat(4097)+'\nconst w=a+b;','a+b','a-b',1).status,'bound');
 assert.notEqual(bind('x'.repeat(262145),'x','y').status,'bound');
 assert.notEqual(bind('const w=a+b;','a+b','a-b\nother();').status,'bound');
});
