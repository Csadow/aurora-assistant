import {dirname,resolve} from 'node:path';
import {sha} from './vault.mjs';
import {mayChangeFiles} from './workflow-requirements.mjs';

const linkTarget=text=>(/^\]\(([^)\r\n]+)\)$/.exec(text)||/^\[[^\]\r\n]+\]\(([^)\r\n]+)\)$/.exec(text))?.[1];

// Only explicit saved link requirements opt in. Resolve relative destinations
// against the output file, never by a guessed basename or an online lookup.
export function citationSources(w,path){
  const rule=w.requirements?.files.find(r=>r.path===path);
  if(!rule||Object.hasOwn(rule,'exactText'))return [];
  const found=[];
  for(const text of rule.requiredText||[]){
    const target=linkTarget(text);
    if(!target||!/^[\p{L}\p{N}_./-]+$/u.test(target))continue;
    const source=resolve(dirname(path),target);if(source===path||found.some(s=>s.target===target))continue;
    const i=w.operations.findLastIndex(o=>o.name==='read_system_file'&&(o.result?.path||o.arguments?.path)===source),op=w.operations[i],r=op?.result;
    if(!op||op.status!=='completed'||op.revision!==w.revision||r?.error||r?.truncated||typeof r?.content!=='string'||r.revision!==sha(r.content)||w.operations.slice(i+1).some(mayChangeFiles))continue;
    const labels=(rule.requiredText||[]).filter(x=>x.startsWith('[')&&linkTarget(x)===target);if(labels.length>1)continue;
    found.push({target,path:source,evidence:op.id,revision:r.revision,content:r.content,after:labels[0]||`[${target}](${target})`});
  }
  return found;
}

// This deliberately supports a small, conservative subset of Markdown. It
// repairs existing reference spelling, never inserts a citation beside a claim.
export function citationDraft(w,args){
  const sources=citationSources(w,args.path),changes=[];
  if(!sources.length||typeof args.content!=='string')return {arguments:args,changes};
  const text=args.content,rule=w.requirements.files.find(r=>r.path===args.path),protectedRanges=[];
  for(const literal of rule.requiredText||[]){if(linkTarget(literal))continue;let at=0;while(literal&&((at=text.indexOf(literal,at))>=0)){protectedRanges.push([at,at+literal.length]);at+=literal.length;}}
  let fence=null,offset=0;
  for(const line of text.match(/[^\n]*\n|[^\n]+$/g)||[]){
    const marker=/^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if(marker){if(!fence)fence=marker;else if(marker[0]===fence[0]&&marker.length>=fence.length)fence=null;offset+=line.length;continue;}
    if(fence||/^(?: {4}|\t|\s*>)/.test(line)||/[<>]/.test(line)){offset+=line.length;continue;}
    const excluded=[];let i=0;
    while(i<line.length){
      if(line[i]==='`'||line[i]==='"'||line[i]==='“'){
        const token=line[i]==='`'?/^`+/.exec(line.slice(i))[0]:line[i],endToken=token==='“'?'”':token,end=line.indexOf(endToken,i+token.length);
        excluded.push([i,end<0?line.length:end+endToken.length]);i=excluded.at(-1)[1];
      }else i++;
    }
    for(const m of line.matchAll(/\[\[([^\]\r\n]+)\]\]|\[\]\(([^)\r\n]+)\)|\(([^)\r\n]+)\)/g)){
      const source=sources.find(s=>s.target===(m[1]||m[2]||m[3]));if(!source)continue;
      const from=m.index,to=from+m[0].length,start=offset+from,end=offset+to,previous=line[from-1];
      if(['\\','!',']','['].includes(previous)||excluded.some(([a,b])=>from<b&&to>a)||protectedRanges.some(([a,b])=>start<b&&end>a))continue;
      changes.push({start,end,before:m[0],after:source.after,source:source.path,sourceEvidence:source.evidence,sourceRevision:source.revision});
    }
    offset+=line.length;
  }
  // Avoid expansive transformations of generated documents. A smaller draft or
  // explicit patch is preferable to silently clipping a repair plan.
  if(changes.length>24)return {arguments:args,changes:[]};
  let content=text;for(const c of [...changes].reverse())content=content.slice(0,c.start)+c.after+content.slice(c.end);
  return {arguments:{...args,content},changes};
}
