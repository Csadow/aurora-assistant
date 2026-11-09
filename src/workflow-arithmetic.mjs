import {citationSources} from './workflow-citations.mjs';
import {sourceValues,compareSourceValues} from './workflow-calculations.mjs';

// A small, explicit source set can supply arithmetic context without another
// model decision. These are numeric relations, not inferred units or claims.
// Larger or unselected sets retain the optional comparison tool instead.
export function sourceArithmetic(w){
  const sources=new Set((w.requirements?.files||[]).flatMap(f=>citationSources(w,f.path).map(s=>s.path)));
  const values=sourceValues(w).filter(v=>sources.has(v.source));
  if(values.length<2||values.length>6)return [];
  const results=[];
  for(let i=1;i<values.length;i++)for(let j=0;j<i;j++)results.push({...compareSourceValues(w,{left:values[i].id,right:values[j].id}),automatic:true});
  return results;
}
export function arithmeticContext(w){
  const comparisons=sourceArithmetic(w);if(!comparisons.length)return null;
  return {notice:'Exact arithmetic for numbers in your explicitly linked source observations. Check the excerpts in sourceValues for units, periods and relevance. Use the matching relations when comparing costs or limits, including each unresolved alternative. This is not a verification of the sources or the conclusion.',comparisons:comparisons.map(c=>({left:c.left.id,right:c.right.id,expression:c.expression,difference:c.difference}))};
}
