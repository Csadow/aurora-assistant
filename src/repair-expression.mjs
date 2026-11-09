import {AppError} from './vault.mjs';

// A deliberately small expression language. Source is tokenized and interpreted;
// it is never passed to eval, Function, vm, a shell, or a JavaScript runtime.
const calls=new Map(['min','max','round','floor','ceil','abs','trunc'].map(k=>['Math.'+k,Math[k]]));
const precedence=new Map([['||',1],['&&',2],['===',3],['!==',3],['<',4],['<=',4],['>',4],['>=',4],['+',5],['-',5],['*',6],['/',6],['%',6]]);
const identifier=/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const forbidden=new Set(['__proto__','prototype','constructor','this','globalThis','process','global','window','document','eval','Function','Infinity','NaN','undefined']);
const validName=name=>identifier.test(name)&&name.length<=80&&!name.split('.').some(p=>forbidden.has(p))&&!name.startsWith('Math.')&&!['true','false','Math'].includes(name);
const fail=message=>{throw new AppError('Expression check: '+message);};
const argumentFail=(field,code,message,extra={})=>{throw Object.assign(new AppError('Expression check: '+message),{expressionIssue:{field,code,...extra}});};
const scalar=v=>typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v);
const number=v=>{if(typeof v!=='number'||!Number.isFinite(v))fail('arithmetic requires finite numbers.');return v;};
const boolean=v=>{if(typeof v!=='boolean')fail('conditions require explicit booleans.');return v;};

export function parseExpression(source){
  if(typeof source!=='string'||!source.trim()||source.length>512)fail('use an expression of 1–512 characters.');
  const tokens=[];let rest=source;
  while(rest.length){
    const space=rest.match(/^\s+/);if(space){rest=rest.slice(space[0].length);continue;}
    if(/^(?:\+\+|--|\*\*|==(?!=)|!=(?!=)|=>|<<|>>|\?\?|\?\.|\/[/*])/.test(rest))fail('unsupported operator or comment.');
    const match=rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|^(?:===|!==|<=|>=|&&|\|\||[+\-*/%<>!?:(),])/);
    if(!match)fail('unsupported syntax. Supply only the numeric/boolean expression, e.g. Math.max(a,b), without const, return, assignment or the full source line.');
    tokens.push(match[0]);rest=rest.slice(match[0].length);if(tokens.length>160)fail('expression exceeds 160 tokens.');
  }
  let at=0;
  const take=t=>{if(tokens[at]!==t)fail('expected '+t+'.');at++;};
  function expression(min=0,depth=0){
    if(depth>24)fail('expression nesting exceeds 24 levels.');
    const token=tokens[at++];let node;
    if(['+','-','!'].includes(token))node={op:token,args:[expression(7,depth+1)]};
    else if(token==='('){node=expression(0,depth+1);take(')');}
    else if(token==='true'||token==='false')node={value:token==='true'};
    else if(token&&/^(?:\d|\.)/.test(token)){
      // Leading-zero integers have different sloppy JavaScript semantics.
      if(/^0\d/.test(token)||!Number.isFinite(Number(token)))fail('use finite decimal literals without leading zeroes.');
      node={value:Number(token)};
    }else if(calls.has(token)){
      take('(');const args=[expression(0,depth+1)];
      while(tokens[at]===','){at++;args.push(expression(0,depth+1));if(args.length>8)fail('at most 8 Math arguments.');}
      take(')');if(!['Math.min','Math.max'].includes(token)&&args.length!==1)fail('this Math call needs exactly one argument.');
      node={call:token,args};
    }else if(token&&validName(token))node={name:token};
    else fail('unsupported identifier or incomplete expression.');
    while(precedence.has(tokens[at])&&precedence.get(tokens[at])>=min){
      const op=tokens[at++],right=expression(precedence.get(op)+1,depth+1);node={op,args:[node,right]};
    }
    if(min===0&&tokens[at]==='?'){at++;const yes=expression(0,depth+1);take(':');node={op:'?:',args:[node,yes,expression(0,depth+1)]};}
    return node;
  }
  const ast=expression();if(at!==tokens.length)fail('unexpected trailing syntax.');return ast;
}

export function evaluateExpression(ast,inputs){
  const entries=inputs&&typeof inputs==='object'&&!Array.isArray(inputs)?Object.entries(inputs):null;
  if(!entries||entries.length>16||entries.some(([k,v])=>!validName(k)||!scalar(v)))fail('inputs must contain at most 16 named finite numbers or booleans; dotted names are literal keys.');
  const values=new Map(entries);let steps=0;
  function visit(node){
    if(++steps>200)fail('evaluation limit exceeded.');
    if(Object.hasOwn(node,'value'))return node.value;
    if(node.name){if(!values.has(node.name))fail('missing input '+node.name+'.');return values.get(node.name);}
    if(node.call)return number(calls.get(node.call)(...node.args.map(a=>number(visit(a)))));
    const [a,b,c]=node.args,op=node.op,left=visit(a);
    if(op==='?:')return visit(boolean(left)?b:c);
    if(op==='&&')return boolean(left)&&boolean(visit(b));
    if(op==='||')return boolean(left)||boolean(visit(b));
    if(!b)return op==='!'?!boolean(left):number(op==='-'?-number(left):number(left));
    const right=visit(b);
    if(op==='==='||op==='!==')return op==='==='?left===right:left!==right;
    const x=number(left),y=number(right);
    switch(op){
      case '+':return number(x+y);case '-':return number(x-y);case '*':return number(x*y);
      case '/':case '%':if(y===0)fail('division by zero.');return number(op==='/'?x/y:x%y);
      case '<':return x<y;case '<=':return x<=y;case '>':return x>y;case '>=':return x>=y;
      default:fail('unsupported operator.');
    }
  }
  return visit(ast);
}

function expressionPair(before,after){
  const trees=[before,after].map((text,i)=>{try{return parseExpression(text);}catch(e){if(!(e instanceof AppError))throw e;throw Object.assign(e,{expressionIssue:{field:i?'after':'before',code:'unsupported_expression'}});}});
  const names=trees.map(tree=>{const set=new Set();const collect=node=>{if(node.name)set.add(node.name);for(const arg of node.args||[])collect(arg);};collect(tree);return [...set];});
  return {trees,requiredInputs:[...new Set(names.flat())],introducedInputs:names[1].filter(n=>!names[0].includes(n))};
}
export function expressionInputs(before,after){const {trees,...inputs}=expressionPair(before,after);return inputs;}

export function expressionExamples(before,after,cases){
  const {trees,requiredInputs,introducedInputs}=expressionPair(before,after);
  const invalid=(field,code,message)=>argumentFail(field,code,message,{requiredInputs,introducedInputs});
  if(!Array.isArray(cases)||cases.length<1||cases.length>6)invalid('cases','case_count','supply 1–6 explicit input/expected examples.');
  // Validate the entire request before computing any candidate verdict. Neither
  // coercion nor guessed flattening can turn a malformed example into evidence.
  cases.forEach((c,index)=>{
    const field=`cases[${index}]`;
    if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['inputs','expected'].includes(k)))invalid(field,'case_shape','each example must contain only inputs and expected.');
    if(!scalar(c.expected))invalid(field+'.expected','scalar_expected',`example ${index+1} expected must be one finite number or boolean, not an object, array or string. Choose the result of the exact expression; do not submit the whole function result.`);
    const entries=c.inputs&&typeof c.inputs==='object'&&!Array.isArray(c.inputs)?Object.entries(c.inputs):null;
    if(!entries||entries.length>16)invalid(field+'.inputs','input_shape','inputs must be an object with at most 16 named finite numbers or booleans.');
    for(const [key,value] of entries){
      const at=field+'.inputs['+JSON.stringify(key.slice(0,80))+']';
      if(!validName(key))invalid(at,'input_name','use the exact supported variable name; dotted names are literal keys, not nested objects.');
      if(!scalar(value))invalid(at,'scalar_input','this input must be a finite number or boolean. Arrays, objects, strings and null are not supported; explicitly supply the named scalar values from the observed context.');
    }
    const missing=requiredInputs.filter(name=>!Object.hasOwn(c.inputs,name));
    if(missing.length)invalid(field+'.inputs','missing_inputs',`example ${index+1} is missing inputs: ${missing.join(', ')}. Use the exact variable names in both expressions, including inactive branches. Correct the inputs and retry; no candidate verdict was recorded.`);
  });
  return cases.map(c=>{
    const results=trees.map(tree=>{try{return {value:evaluateExpression(tree,c.inputs)};}catch(e){if(!(e instanceof AppError))throw e;return {error:e.message};}});
    return {inputs:structuredClone(c.inputs),expected:c.expected,before:results[0],after:results[1],matches:!results[1].error&&results[1].value===c.expected};
  });
}
