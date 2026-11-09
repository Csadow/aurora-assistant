import {sourcedDraft} from './workflow-claims.mjs';

// A claim-only view is safe only when those exact claims reconstruct every byte
// of the proposed note. Custom prose, edited appendices and legacy renderings
// keep the full draft; labels/metadata alone must never hide model-authored text.
export function isGeneratedClaimNote(w,op){
 if(!op?.sourceReview?.claims?.length||typeof op.arguments?.content!=='string')return false;
 try{
  const claims=op.sourceReview.claims.map(c=>({text:c.text,kind:c.kind,limits:c.limits,evidence:c.evidence.map(e=>({source:e.evidence,quote:e.quote}))}));
  const state={...w,operations:w.operations.map(o=>o.id===op.id?{...o,action:undefined}:o)};
  return sourcedDraft(state,{path:op.arguments.path,reason:'Reconstruct generated note for content review',claims}).arguments.content===op.arguments.content;
 }catch{return false;}
}

// Preserve the actual editable fields, including late claims and their limits.
// Failed malformed/oversized input is not echoed as an apparently complete list.
export function editableClaims(op){
 const claims=op?.claimInputs;
 if(!Array.isArray(claims)||!claims.length||claims.length>12||JSON.stringify(claims).length>18000)return null;
 return structuredClone(claims);
}

// Keep the full audit in the journal/UI. Correction context needs the actual
// objections, not a second copy of every passing judgment and receipt hash.
export function critiqueFeedback(critique){
 if(!critique)return undefined;
 const {verdict,summary,issues,notice}=critique;
 return structuredClone({verdict,summary,issues,notice});
}
