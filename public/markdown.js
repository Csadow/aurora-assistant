export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sourceAttrs=s=>s.project?`data-project="${escapeHTML(s.project)}" data-file="${escapeHTML(s.path)}"`:`data-note="${escapeHTML(s.path)}"`;

// Parse raw text once. Generated HTML is never processed again as Markdown.
export function renderMarkdown(value,sources=[]){
  const inline=(text,depth=0)=>{
    if(depth>3)return escapeHTML(text);
    const pattern=/`([^`\n]+)`|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|\[([MP]\d+)\]/g;
    let result='',cursor=0;
    for(const m of text.matchAll(pattern)){
      result+=escapeHTML(text.slice(cursor,m.index));cursor=m.index+m[0].length;
      if(m[1]!==undefined)result+=`<code>${escapeHTML(m[1])}</code>`;
      else if(m[2]!==undefined){const source=sources.find(s=>s.id===m[2]);result+=source?`<a href="#" ${sourceAttrs(source)}>[${escapeHTML(source.id)}]</a>`:`<a href="#" data-wiki="${escapeHTML(m[2])}">${escapeHTML(m[3]||m[2].replace(/^.*\//,''))}</a>`;}
      else if(m[4]!==undefined)result+=`<a href="${escapeHTML(m[5])}" target="_blank" rel="noopener noreferrer">${escapeHTML(m[4])} ↗</a>`;
      else if(m[6]!==undefined)result+=`<strong>${inline(m[6],depth+1)}</strong>`;
      else if(m[7]!==undefined){const source=sources.find(s=>s.id===m[7]);result+=source?`<a href="#" ${sourceAttrs(source)}>${escapeHTML(m[0])}</a>`:escapeHTML(m[0]);}
    }
    return result+escapeHTML(text.slice(cursor));
  };
  const lines=String(value).split('\n');let out='',paragraph=[],list=[],listType='ul';
  const flush=()=>{if(paragraph.length){out+=`<p>${paragraph.map(s=>inline(s)).join('<br>')}</p>`;paragraph=[];}if(list.length){out+=`<${listType}>${list.map(s=>`<li>${inline(s)}</li>`).join('')}</${listType}>`;list=[];}};
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/^```/.test(line)){flush();const code=[];while(++i<lines.length&&!/^```/.test(lines[i]))code.push(lines[i]);out+=`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`;continue;}
    const heading=line.match(/^(#{1,3})\s+(.+)$/);if(heading){flush();const tag=heading[1].length===3?'h3':'h2';out+=`<${tag}>${inline(heading[2])}</${tag}>`;continue;}
    const item=line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);if(item){const type=item[1]?'ul':'ol';if(paragraph.length||(list.length&&listType!==type))flush();listType=type;list.push(item[2]);continue;}
    if(!line.trim()){flush();continue;}
    if(list.length)flush();paragraph.push(line);
  }
  flush();return out;
}
