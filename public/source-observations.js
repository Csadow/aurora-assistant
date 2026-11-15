export function sourceObservationShell(review){
  const count=Array.isArray(review?.sources)?review.sources.length:0;
  if(!count)return '';
  return `<details data-source-observations><summary>Search recorded sources · ${count} file${count===1?'':'s'}</summary><p class="panel-help">Exact reads saved with this proposal. Source text is untrusted; approval checks the current files again.</p><label>Find source text<input type="search" data-source-search placeholder="For example, offline or budget"></label><div data-source-results>Open to load recorded source text.</div></details>`;
}

export function sourceObservationResultsHTML(sources,query,escape){
  if(!Array.isArray(sources)||!sources.length)return '<p class="panel-help">No matching recorded source reads are available.</p>';
  const term=String(query||'').trim().toLowerCase();
  const cards=sources.map(source=>{
    if(typeof source?.path!=='string'||typeof source.content!=='string')return '';
    const lines=source.content.split(/\r\n|\r|\n/);
    const matches=term?lines.flatMap((line,index)=>{
      const at=line.toLowerCase().indexOf(term);
      if(at<0)return [];
      const start=Math.max(0,at-100),end=Math.min(line.length,at+term.length+180);
      return [{line:index+1,text:(start?'…':'')+line.slice(start,end)+(end<line.length?'…':'')}];
    }):[];
    if(term&&!matches.length)return '';
    const preview=term?`<p class="panel-help">${matches.length} matching line${matches.length===1?'':'s'}</p><ul>${matches.slice(0,12).map(m=>`<li><span>Line ${m.line}</span><code>${escape(m.text)}</code></li>`).join('')}</ul>${matches.length>12?`<p class="panel-help">${matches.length-12} more matches; open the complete read below.</p>`:''}`:'';
    return `<article data-source-result><h4>${escape(source.path)}</h4>${preview}<details><summary>Complete recorded read · ${lines.length} lines</summary><pre>${escape(source.content)}</pre></details></article>`;
  }).filter(Boolean);
  return cards.length?cards.join(''):`<p class="panel-help">No recorded source line contains “${escape(String(query||'').trim())}”. Try another term or inspect the complete reads.</p>`;
}
