import {AppError} from './vault.mjs';

// All matches refer to the original file. No regex, fuzzy matching, global
// replacement, whitespace normalization or sequential/chained substitutions.
export function filePatch(source,edits){
  if(!Array.isArray(edits)||!edits.length||edits.length>8||JSON.stringify(edits).length>16000)throw new AppError('Supply one to eight exact replacements, within 16,000 characters.');
  const changes=edits.map(e=>{
    if(!e||typeof e!=='object'||Object.keys(e).some(k=>!['before','after'].includes(k))||typeof e.before!=='string'||!e.before||typeof e.after!=='string'||e.before===e.after||[e.before,e.after].some(s=>s.includes('\0')||Buffer.from(s).toString('utf8')!==s))throw new AppError('Each replacement needs nonempty before text and different after text (empty deletes). Use valid text, with exact whitespace.');
    const offset=source.indexOf(e.before);
    if(offset<0)throw new AppError('Replacement text was not found exactly. Read the current file and copy its literal text, including whitespace.',409);
    if(source.indexOf(e.before,offset+1)>=0)throw new AppError('Replacement text is ambiguous. Include more surrounding text so it matches exactly once.',409);
    const prefix=source.slice(0,offset),line=prefix.split('\n').length,column=Array.from(prefix.slice(prefix.lastIndexOf('\n')+1)).length+1;
    return {...e,offset,line,column};
  }).sort((a,b)=>a.offset-b.offset);
  for(let i=1;i<changes.length;i++)if(changes[i].offset<changes[i-1].offset+changes[i-1].before.length)throw new AppError('Replacement matches overlap. Use separate non-overlapping text from the original file.');
  let content=source;
  for(const c of [...changes].reverse())content=content.slice(0,c.offset)+c.after+content.slice(c.offset+c.before.length);
  if(Buffer.byteLength(content)>64000)throw new AppError('The resulting file exceeds the 64 KiB edit limit.');
  return {content,changes,diff:changes.map(c=>`@@ line ${c.line}, column ${c.column} @@\n- ${JSON.stringify(c.before)}\n+ ${JSON.stringify(c.after)}`).join('\n\n')};
}
