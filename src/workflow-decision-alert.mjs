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

// A literal premise check for the first two observations in each limit cue.
// An identifier is only an identifier, not proof that two prices describe the
// same current offer. Missing or ambiguous source text stays unresolved.
const identifierPattern=/\b(?:offer|sku|plan|option)\s*(?:id|code)?\s*[:#-]?\s*([a-z][a-z0-9_-]*\d[a-z0-9_-]*)\b/gi;
const units=[
 {pattern:/^(credits?)\s*(?:per\s+|\/\s*)(month|year)\b/i,kind:(_,unit,period)=>`credit/${period.toLowerCase()}`},
 {pattern:/^(kilomet(?:er|re)s?|km|miles?)\b/i,kind:(_,unit)=>/^(?:mile)/i.test(unit)?'mile':'km'}
];
const observation=(item,comparisons)=>{
 const values=new Map();
 for(const c of comparisons||[])for(const v of [c?.left,c?.right])if(v?.source===item?.source&&v.value===item?.value&&typeof v.id==='string')values.set(v.id,v);
 if(values.size!==1)return null;
 const v=[...values.values()][0],excerpt=typeof v.excerpt==='string'?v.excerpt:'';
 const numbers=[...excerpt.matchAll(/(?<![\p{L}\p{N}_.,+\-])[-+]?\d{1,12}(?:\.\d{1,6})?(?![\p{L}\p{N}_,+\-]|\.\d)/gu)].filter(m=>m[0]===v.value);
 const index=numbers.length===1?numbers[0].index:-1;
 const following=index>=0?excerpt.slice(index+v.value.length).trimStart():'';
 const unitMatches=units.flatMap(u=>{const m=u.pattern.exec(following);return m?[{literal:m[0],kind:u.kind(...m)}]:[];});
 // A neighboring sentence can name a different offer. Keep only the clause
 // containing this exact number; a clipped or ambiguous clause stays unknown.
 const before=index>=0?excerpt.slice(0,index):'';
 const start=Math.max(before.lastIndexOf('.'),before.lastIndexOf('!'),before.lastIndexOf('?'),before.lastIndexOf(';'),before.lastIndexOf('\n'))+1;
 const after=index>=0?excerpt.slice(index+v.value.length):'';
 const stop=after.search(/[.!?;\n]/);
 const clause=index>=0?excerpt.slice(start,stop<0?undefined:index+v.value.length+stop):'';
 const ids=[...clause.matchAll(identifierPattern)].map(m=>m[1]);
 const identifiers=[...new Set(ids.map(id=>id.toLowerCase()))];
 return {id:v.id,value:v.value,source:v.source,sourceRevision:v.sourceRevision||'',line:v.line||null,excerpt,unit:unitMatches.length===1?unitMatches[0]:null,identifier:identifiers.length===1?ids[0]:null};
};
export function decisionPremises(numberAlerts,comparisons){
 return (numberAlerts||[]).slice(0,3).map(alert=>{
  const below=observation(alert?.below?.[0],comparisons),above=observation(alert?.above?.[0],comparisons);
  let status='unresolved';
  if(below?.unit&&above?.unit){
   if(below.unit.kind!==above.unit.kind)status='incompatible_units_or_periods';
   else if(below.identifier&&above.identifier)status=below.identifier.toLowerCase()===above.identifier.toLowerCase()?'shared_identifier':'different_identifiers';
  }
  return {limit:alert?.limit||null,below,above,status};
 });
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
