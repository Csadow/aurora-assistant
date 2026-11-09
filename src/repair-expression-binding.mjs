import {parseExpression,expressionInputs} from './repair-expression.mjs';
import {AppError} from './vault.mjs';

// A conservative recognizer, not a JavaScript parser or scope analysis. It only
// selects complete expression slots in simple declarations, assignments and
// returns. Never enumerate arbitrary substrings or execute source to find a pair.
const name=/^[A-Za-z_$][\w$]*$/;
const unsupported=(code,message)=>({status:'unsupported',code,message});
function slots(text){
  const tokens=[];let at=0;
  while(at<text.length){
    const s=text.slice(at),space=s.match(/^\s+/);if(space){at+=space[0].length;continue;}
    const m=s.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|^(?:===|!==|<=|>=|&&|\|\||[+\-*/%<>!?:(),=;{}])/);
    if(!m||tokens.length>=512)return null;
    tokens.push({value:m[0],start:at,end:at+m[0].length});at+=m[0].length;
  }
  let i=0;const out=[],value=()=>tokens[i]?.value,take=v=>value()===v?(i++,true):false;
  const expr=()=>{
    const start=i;let depth=0;
    while(i<tokens.length){
      const t=value();if(!depth&&[',',';','}'].includes(t))break;
      if(t==='(')depth++;if(t===')'&&--depth<0)return false;
      if(t==='{'||t==='=')return false;i++;
    }
    if(depth||i===start)return false;
    const a=tokens[start].start,b=tokens[i-1].end;out.push({start:a,end:b,text:text.slice(a,b)});return true;
  };
  const property=()=>name.test(value()||'')?(i++,true):false;
  const finish=()=>{take(';');return i===tokens.length?out:null;};
  if(value()==='export')i++;
  if(['const','let','var'].includes(value())){
    i++;do{if(!property()||!take('=')||!expr())return null;}while(take(','));return finish();
  }
  if(take('return')){
    if(take('{')){do{if(!property()||!take(':')||!expr())return null;}while(take(','));if(!take('}'))return null;return finish();}
    if(!expr())return null;return finish();
  }
  if(name.test(value()||'')&&tokens[i+1]?.value==='=')i+=2;
  if(!expr())return null;return finish();
}

// Preserve offsets while excluding comments and strings. Reject templates and
// uncertain slash contexts rather than mistaking regex/template contents for code.
// Earlier division lines must themselves be supported numeric statements. This
// intentionally declines many valid programs; normal reviewed tests still work.
function observedLine(content,line){
  if(typeof content!=='string'||content.length>262144||!Number.isInteger(line)||line<1)return null;
  const lines=content.split(/\r\n|\n|\r/);if(line>lines.length||lines[line-1].length>4096)return null;
  let mode='code',quote='',escaped=false;
  for(let n=0;n<line;n++){
    const text=lines[n];let clean='',slash=false;
    for(let i=0;i<text.length;i++){
      const c=text[i],next=text[i+1];
      if(mode==='block'){if(c==='*'&&next==='/'){clean+='  ';i++;mode='code';}else clean+=' ';continue;}
      if(mode==='string'){
        clean+='§';if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c===quote)mode='code';continue;
      }
      if(c==='/'&&next==='/'){clean+=' '.repeat(text.length-i);break;}
      if(c==='/'&&next==='*'){clean+='  ';i++;mode='block';continue;}
      if(c==='`')return null;
      if(c==='"'||c==="'"){mode='string';quote=c;clean+='§';continue;}
      if(c==='/')slash=true;clean+=c;
    }
    if(mode==='string'){if(!escaped)return null;escaped=false;}
    if(slash&&n<line-1){
      const prior=slots(clean);if(!prior)return null;
      try{for(const s of prior)parseExpression(s.text);}catch(e){if(e instanceof AppError)return null;throw e;}
    }
    if(n===line-1)return {text,clean};
  }
  return null;
}

export function bindRepairExpression({content,line,before,after}){
  const source=observedLine(content,line);
  if(!source)return unsupported('source_context','Automatic calculation is unavailable for this source context or size. Use reviewed project tests.');
  if(typeof before!=='string'||!before||typeof after!=='string'||/[\r\n]/.test(before+after)||before===after)return unsupported('repair_shape','A single changed source fragment is required.');
  const start=source.text.indexOf(before);
  if(start<0||source.text.indexOf(before,start+1)>=0)return unsupported('source_fragment','The saved fragment is absent or ambiguous on this line. Read the source again.');
  const changed=source.text.slice(0,start)+after+source.text.slice(start+before.length);
  // Rescan the whole prefix with the proposed line so a new comment/string cannot
  // turn a numeric-looking substring into a falsely bound expression.
  const lines=content.split(/\r\n|\n|\r/);lines[line-1]=changed;
  const proposed=observedLine(lines.join('\n'),line);
  const old=slots(source.clean),next=proposed&&slots(proposed.clean);
  if(!old||!next)return unsupported('source_syntax','Only simple declarations, assignments and returns can be bound automatically. Use reviewed project tests for this repair.');
  const matches=new Map();
  for(const a of old)for(const b of next){
    if(source.text.slice(0,a.start)+b.text+source.text.slice(a.end)!==changed)continue;
    try{const inputs=expressionInputs(a.text,b.text);if(inputs.requiredInputs.length>16)continue;matches.set(a.start+'\0'+b.text,{column:a.start+1,before:a.text,after:b.text,...inputs});}
    catch(e){if(!(e instanceof AppError))throw e;}
  }
  if(matches.size===1)return {status:'bound',...[...matches.values()][0]};
  if(matches.size>1||old.length===next.length&&old.filter((a,i)=>a.text!==next[i].text).length>1)return {status:'ambiguous',code:'multiple_expressions',message:'The whole saved change cannot be bound to one expression. Keep the intended repair intact and use reviewed project tests; no partial calculation was selected.'};
  return unsupported('expression_syntax','No supported expression pair reproduces the whole saved change. Use reviewed project tests; no expression was guessed.');
}
