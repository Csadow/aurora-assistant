// A review cue from exact recorded numbers. It does not infer that values
// describe the same offer, share units, or are current.
const limitWords=/\b(?:budget|ceiling|limit|cap|maximum)\b/i;
const side=(relation,limitOnLeft)=>limitOnLeft?(relation==='<'?'>':'<'):relation;
export function decisionNumberAlerts(comparisons){
 const groups=new Map();
 for(const comparison of comparisons||[]){
  if(!['<','>'].includes(comparison?.relation))continue;
  for(const [limit,value,limitOnLeft] of [[comparison.left,comparison.right,true],[comparison.right,comparison.left,false]]){
   if(!limit||!value||typeof limit.excerpt!=='string'||!limitWords.test(limit.excerpt)||limitWords.test(value.excerpt||''))continue;
   if(typeof limit.value!=='string'||typeof value.value!=='string'||typeof limit.source!=='string'||typeof value.source!=='string')continue;
   const key=limit.id||limit.source+'\0'+limit.value;
   if(!groups.has(key))groups.set(key,{limit:{value:limit.value,source:limit.source},below:new Map(),above:new Map()});
   const group=groups.get(key),direction=side(comparison.relation,limitOnLeft),item={value:value.value,source:value.source,expression:comparison.expression};
   group[direction==='<'?'below':'above'].set(value.id||value.source+'\0'+value.value,item);
  }
 }
 return [...groups.values()].filter(group=>group.below.size&&group.above.size).slice(0,3).map(group=>({limit:group.limit,below:[...group.below.values()].slice(0,3),above:[...group.above.values()].slice(0,3),notice:'Recorded numbers fall on both sides of this limit. Check units, periods, which option each value describes, and whether a disputed value is current before accepting a decision.'}));
}

// Focus the human review on exact authored claim text when a limit cue exists.
// These words find possible choices; they do not classify whether one is sound.
const decisionWords=/\b(?:recommend(?:s|ation|ed)?|choos(?:e|ing)|select(?:ed|ion)?|pick|prefer|best|should|defer|delay|wait)\b/i;
export function decisionWording(review,numberAlerts){
 if(!Array.isArray(numberAlerts)||!numberAlerts.length||!Array.isArray(review?.claims))return [];
 return review.claims.map((claim,index)=>({claim,index,score:typeof claim?.text==='string'&&/^\s*decision\b/i.test(claim.text)?3:typeof claim?.text==='string'&&decisionWords.test(claim.text)?2:0}))
  .filter(({claim,score})=>score&&claim.kind==='inference'&&typeof claim.limits==='string')
  .sort((a,b)=>b.score-a.score||b.index-a.index).slice(0,2).sort((a,b)=>a.index-b.index)
  .map(({claim,index})=>({number:index+1,text:claim.text,limits:claim.limits}));
}
