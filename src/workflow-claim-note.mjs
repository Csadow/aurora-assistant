// A single claim list produces both the note and its review. This avoids asking
// a small model to keep a separately generated document and claim copy in sync.
export function claimNote(review,links){
  const labels={source_statement:'Source statement',conflict:'Unresolved conflict',unknown:'Not established in the reviewed sources',inference:'Inference / recommendation'};
  const excerpts=new Map();
  for(const c of review.claims)for(const e of c.evidence){const key=JSON.stringify([e.source,e.quote]);if(!excerpts.has(key))excerpts.set(key,e);}
  const sections=review.claims.map(c=>[
    `## ${labels[c.kind]}`,
    c.text,
    `Limits: ${c.limits}`,
    ...(c.unsupported?['No source passage attached. This inference is unsupported and needs review.']:[]),
    ...[...new Set(c.evidence.map(e=>links.find(s=>s.path===e.source).link))]
  ].join('\n\n'));
  return '# Source review\n\n'+sections.join('\n\n')+'\n\n## Source excerpts\n\n'+[...excerpts.values()].map(e=>links.find(s=>s.path===e.source).link+'\n\n'+e.quote.split(/\r\n|\r|\n/).map(line=>'> '+line).join('\n')).join('\n\n')+'\n\n## Reviewed source set\n\n'+links.map(s=>'- '+s.link).join('\n')+'\n\nThese classifications and conclusions are Aurora’s assessments of the listed sources. Exact excerpts do not prove that an inference is correct or that a source is true.\n';
}
