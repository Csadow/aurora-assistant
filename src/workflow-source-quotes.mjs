// Append only missing, explicitly required literals that occur in one observed
// source. This is a proposed excerpt appendix, not a rewrite or a fact check.
export function sourceQuoteDraft(args,requiredText,sources){
  const quotes=[];
  for(const text of new Set(requiredText||[])){
    if(args.content.includes(text)||text.length<8||/[\r\n\0]/.test(text)||!/[\p{L}\p{N}]/u.test(text)||/^\s*[#>`]/.test(text))continue;
    const matches=sources.filter(s=>s.content.includes(text)),paths=new Set(matches.map(s=>s.path));
    if(paths.size!==1)continue;
    const s=matches[0];quotes.push({text,source:s.path,sourceEvidence:s.evidence,sourceRevision:s.revision,link:s.after});
  }
  if(!quotes.length)return {arguments:args,quotes};
  const appendix='## Required source excerpts\n\n'+quotes.map(q=>'> '+q.text+'\n\n'+q.link).join('\n\n');
  const content=args.content+(args.content.endsWith('\n\n')?'':args.content.endsWith('\n')?'\n':'\n\n')+appendix+'\n';
  return {arguments:{...args,content},quotes};
}
