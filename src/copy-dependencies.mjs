import {isBuiltin} from 'node:module';
import {dirname,resolve,relative,isAbsolute} from 'node:path';

// Bounded discovery, never evaluation or a claim of complete JS resolution.
// Strings/comments are tokenized so examples in prose cannot become read paths.
export function literalImports(source){
  const tokens=[],limitations=new Set();let i=0;
  while(i<source.length){
    const c=source[i],n=source[i+1];
    if(/\s/.test(c)){i++;continue;}
    if(c==='/'&&n==='/'){i=source.indexOf('\n',i);if(i<0)break;continue;}
    if(c==='/'&&n==='*'){const end=source.indexOf('*/',i+2);if(end<0){limitations.add('Unclosed comment');break;}i=end+2;continue;}
    if(c==='"'||c==="'"||c==='`'){
      const quote=c;let value='',escaped=false,closed=false;i++;
      while(i<source.length){const x=source[i++];if(x===quote){closed=true;break;}if(x==='\\'){escaped=true;i++;}else value+=x;}
      if(quote==='`')limitations.add('Template syntax needs manual dependency review');
      if(!closed)limitations.add('Unclosed string');
      tokens.push({kind:'string',value:escaped||quote==='`'||!closed?null:value});continue;
    }
    // Slash expressions are deliberately not parsed. Do not read import-like
    // text from a regex as code. Dependencies later on that line need review.
    if(c==='/'){limitations.add('Slash syntax needs manual dependency review');const end=source.indexOf('\n',i);if(end<0)break;i=end+1;continue;}
    const word=source.slice(i).match(/^[A-Za-z_$][\w$]*/);
    if(word){tokens.push({kind:'word',value:word[0]});i+=word[0].length;}
    else{tokens.push({kind:'punctuation',value:c});i++;}
  }
  const imports=[];
  for(let j=0;j<tokens.length;j++){
    const t=tokens[j],next=tokens[j+1];if(t.kind!=='word'||tokens[j-1]?.value==='.')continue;
    let value;
    if(t.value==='require'||t.value==='import'&&next?.value==='('){
      if(next?.value!=='(')continue;
      if(tokens[j+2]?.kind==='string'&&tokens[j+3]?.value===')')value=tokens[j+2].value;
      else limitations.add('Computed or complex import/require needs manual dependency review');
    }else if(t.value==='import'&&next?.kind==='string')value=next.value;
    else if(['import','export'].includes(t.value)){
      for(let k=j+1;k<Math.min(j+100,tokens.length)&&tokens[k].value!==';';k++)if(tokens[k].value==='from'&&tokens[k+1]?.kind==='string'){value=tokens[k+1].value;break;}
    }
    if(value===null)limitations.add('Escaped module specifier needs manual dependency review');
    else if(value!==undefined)imports.push(value);
  }
  return {imports:[...new Set(imports)],limitations:[...limitations]};
}

export async function copyDependencies(files,root,candidate,probe,{discover}={}){
  const neededReads=new Set(),missing=new Set(),limitations=new Set(),edges=[];
  const observed=new Set(files.map(f=>f.path)),present=new Map(),previewed=new Set();
  const queue=[...files,...candidate?[{path:candidate.path,content:candidate.content}]:[]];
  let previewBytes=queue.reduce((n,f)=>n+Buffer.byteLength(f.content),0),previewFiles=queue.length;
  while(queue.length){
    const f=queue.shift();
    if(!/\.(mjs|cjs|js)$/.test(f.path))continue;
    const scan=literalImports(f.content);for(const l of scan.limitations)limitations.add(relative(root,f.path)+': '+l);
    for(const specifier of scan.imports){
      if(specifier.length>160){limitations.add('Oversized module specifier needs manual dependency review');continue;}
      if(isBuiltin(specifier))continue;
      if(!specifier.startsWith('./')&&!specifier.startsWith('../')){limitations.add('External or non-relative module: '+specifier.slice(0,160));continue;}
      const path=resolve(dirname(f.path),specifier),r=relative(root,path);
      if(!r||isAbsolute(r)||r==='..'||r.startsWith('../')||/[?#\\\x00-\x1f]/.test(specifier)||!/^.+\.(mjs|cjs|js|json)$/.test(specifier)){
        limitations.add('Unsupported local module resolution: '+specifier.slice(0,160));continue;
      }
      if(edges.length>=128)throw Error('Too many local import edges for a bounded test copy.');
      edges.push({from:relative(root,f.path),to:r});
      if(observed.has(path))continue;
      if(!present.has(path))present.set(path,await probe(path));
      if(!present.get(path)){missing.add(path);continue;}
      neededReads.add(path);
      if(!discover||previewed.has(path))continue;
      previewed.add(path);
      if(previewFiles>=32){limitations.add('Transitive import preview reached 32 files');continue;}
      const content=await discover(path);
      if(typeof content!=='string'){limitations.add('Transitive import preview could not read '+r);continue;}
      const size=Buffer.byteLength(content);
      if(size>65536||previewBytes+size>262144){limitations.add('Transitive import preview reached its byte limit at '+r);continue;}
      queue.push({path,content});previewFiles++;previewBytes+=size;
    }
  }
  return {neededReads:[...neededReads].sort(),missing:[...missing].sort(),limitations:[...limitations].slice(0,32),edges,
    notice:discover?'Literal imports discovered in observed source, candidate and a bounded read-only preview of existing local imports. Previewed files still need a complete model-facing read before copying. Computed imports, package resolution and runtime file access need review; this is not a complete dependency graph.':'Literal imports discovered in observed source and candidate only. Computed imports, package resolution and runtime file access need review; this is not a complete dependency graph.'};
}
