import {readView} from './read-view.mjs';
import {remainingAdjustments} from './remaining-adjustments.mjs';
import {localDay} from '../mobile/web/planner-core.js';

// A navigation snapshot, never a new decision or execution policy. Each destination
// re-reads its own sources and keeps its existing confirmation and receipt guards.
export function continueDay(planner){return readView(()=>buildContinueDay(planner));}
async function buildContinueDay(planner){
 const b=await planner.briefing(),warnings=[...b.warnings];
 for(const key of ['focusError','firstStepsError','checkinsError','reflectionError','followThroughError','estimateFollowThroughError'])if(b[key])warnings.push(b[key]);
 let adjustments=null,adjustmentsError=null;try{adjustments=await remainingAdjustments(planner,{date:b.date});}catch(e){adjustmentsError=e.message;}
 const focused=b.start?.focused||[],focusTotal=b.start?.focusTotal??0;
 if(b.startError)warnings.push(b.startError);
 warnings.push(...(b.start?.warnings||[]));
 let reviews=[],reviewsAvailable=!b.reflectionError;
 try{reviews=(await planner.store.list('proposals')).filter(p=>p.status==='pending'&&['day_replan','future_schedule','focus_schedule','evening_review','weekly_review'].includes(p.kind)).map(p=>({id:p.id,title:p.title,period:p.kind==='weekly_review'?'week':'day',date:p.targetDate||p.date||p.start||null,created:p.created,savedNotes:p.saved?.length||0,totalNotes:new Set(p.changes.map(c=>c.before.path)).size}));}
 catch(e){reviewsAvailable=false;warnings.push('Planning reviews are unavailable: '+e.message);}
 let sessionReviews=[];try{for(const period of ['day','week'])sessionReviews.push(...await planner.sessionReviews[period].index());}catch(e){reviewsAvailable=false;warnings.push('Session reviews are unavailable: '+e.message);}
 let estimateReviews=[];try{estimateReviews=(await planner.estimateReviews.index()).filter(r=>r.status==='pending');}catch(e){reviewsAvailable=false;warnings.push('Estimate reviews are unavailable: '+e.message);}
 let sessions=null;try{sessions=await planner.focusSessions.overview();}catch(e){warnings.push(e.message);}
 if(localDay(planner.now())!==b.date)warnings.push('The day changed while loading. Reload this workspace before continuing.');
 return {adjustments,adjustmentsError,start:b.start,startError:b.startError,handoff:b.handoff,handoffError:b.handoffError,estimateReviews,sessionReviews,sessions,date:b.date,timezone:b.timezone,generatedAt:planner.now().toISOString(),focused,focusTotal,focusAvailable:!!b.focus,next:b.next,conflicts:b.day.conflicts.length,attention:(b.execution||[]).filter(e=>e.attention),executionDrafts:(b.execution||[]).filter(e=>!e.workflowId&&!e.done),reviews,reviewsAvailable,checkins:b.checkins?.entries.filter(e=>e.status==='open')||[],summaryReviews:b.reflection?.pending||[],reflection:b.reflection?.latest||null,followThrough:b.followThrough||null,warnings:[...new Set(warnings)]};
}
