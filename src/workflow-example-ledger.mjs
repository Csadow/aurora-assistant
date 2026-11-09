import {expressionExamples} from './repair-expression.mjs';

// Only identical observed expression locations share examples. Never guess a
// mapping across changed names, moved lines, task revisions or other files.
export const exampleScope=r=>JSON.stringify([r.path,r.line,r.expressionBinding?.column,r.expressionBinding?.before]);
const sample=c=>({inputs:c.inputs,expected:c.expected});
const key=c=>JSON.stringify([Object.entries(c.inputs).sort(([a],[b])=>a.localeCompare(b)),c.expected]);
export function exampleLedger(w,repair){
  if(w.version<11||repair.expressionBinding?.status!=='bound')return null;
  const scope=exampleScope(repair),repairs=new Map(),cases=new Map();let latest;
  for(const [index,op] of w.operations.entries()){
    if(op.revision!==w.revision||op.status!=='completed'||op.result?.error)continue;
    if(op.name==='record_repair_plan')for(const r of op.result.repairs)repairs.set(r.id,r);
    if(op.name==='check_repair_expression'){
      const r=repairs.get(op.result.repair);
      if(!r||exampleScope(r)!==scope)continue;
      latest='E'+(index+1);
      for(const [i,c] of op.result.cases.entries()){
        const k=key(c),entry=cases.get(k);
        if(entry){entry.lastSeen=latest;continue;}
        cases.set(k,{id:`X${index+1}.${i+1}`,origin:latest,originRepair:r.id,sourceEvidence:op.result.sourceEvidence,sourceRevision:op.result.sourceRevision,original:structuredClone(c),effective:structuredClone(sample(c)),lastSeen:latest,reviews:[]});
      }
    }
    if(op.name==='review_repair_example'&&op.actor==='user'&&op.result.scope===scope){
      const entry=[...cases.values()].find(c=>c.id===op.result.caseId);
      if(entry){entry.effective=structuredClone(op.result.after);entry.reviews.push({evidence:'E'+(index+1),at:op.at,reason:op.result.reason,provenance:op.result.provenance,before:op.result.before,after:op.result.after});}
    }
  }
  if(!cases.size)return null;
  const entries=[...cases.values()].map(c=>{
    let verdict;
    try{verdict=expressionExamples(repair.expressionBinding.before,repair.expressionBinding.after,[c.effective])[0];}
    catch(e){verdict={...c.effective,matches:false,error:e.message};}
    return {...c,verdict,retained:c.lastSeen!==latest,corrected:c.reviews.length>0};
  });
  return {cases:entries,total:entries.length,failed:entries.filter(c=>!c.verdict.matches).length,corrected:entries.filter(c=>c.corrected).length,retained:entries.filter(c=>c.retained).length,notice:'Original examples remain in the journal. Only an explicit user review changes an example. Rechecks use the current saved expression at this same file, line and column; other locations are not mapped. Quotes establish provenance, not correctness. Arithmetic examples do not prove scope, units or whole-program behavior.'};
}
export function compactExampleLedger(ledger){return ledger?{total:ledger.total,failed:ledger.failed,corrected:ledger.corrected,retained:ledger.retained,failingCases:ledger.cases.filter(c=>!c.verdict.matches).map(c=>c.id),reviewedCases:ledger.cases.filter(c=>c.corrected).map(c=>({id:c.id,...c.effective,review:c.reviews.at(-1).evidence})),notice:'Retained examples apply. If an example is mistaken, request_help for user review in Planned repairs; never replace it silently. Review is not execution or completion evidence.'}:null;}

// A replaced list may remove a repair or move/change its source expression.
// Surface those cases separately; evaluating them against a different expression
// would invent a mapping. They remain inspectable in the original journal.
export function unmappedExampleHistory(w){
  if(w.version<11)return [];
  const plans=w.operations.filter(o=>o.name==='record_repair_plan'&&o.status==='completed'&&o.revision===w.revision),current=new Set((plans.at(-1)?.result.repairs||[]).map(exampleScope)),old=new Map();
  for(const p of plans)for(const r of p.result.repairs)if(!current.has(exampleScope(r)))old.set(exampleScope(r),r);
  return [...old.values()].map(r=>({repair:r.id,path:r.path,line:r.line,expression:r.expressionBinding,ledger:exampleLedger(w,r)})).filter(g=>g.ledger);
}
