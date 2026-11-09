import {validScheduleDraft} from './planner-editor-drafts.js';
import {validFirstStepDraft} from './first-steps.js';
import {validStepOutcomeDraft} from './step-outcomes.js';
import {validDailySummaryDraft} from './daily-summary.js';
export const recoveryDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
export const validLocalCapture=d=>d?.version===1&&typeof d.revision==='string'&&d.fields&&Object.keys(d.fields).length===6&&['text','project','duration','due','planDate','startTime'].every(k=>typeof d.fields[k]==='string');

// A local edit can be cleared only after its exact stored bytes were reviewed.
// These keys are working drafts, never server capture state or durable receipts.
export function localDraftReview(storage,row){
 if(!['task-schedule','local-capture','first-step','step-outcome','daily-summary'].includes(row.clearType)||!row.localKey||row.unreadable||row.pending)throw Error('This recovery record must be opened in its original editor.');
 const raw=storage.getItem(row.localKey);if(raw===null)throw Error('This draft is no longer stored. Refresh the workspace.');
 let value;try{value=JSON.parse(raw);}catch{}
 if(row.clearType==='local-capture'&&!validLocalCapture(value))throw Error('This local capture copy changed or became unreadable. Refresh before reviewing it.');
 if(row.clearType==='task-schedule'&&!validScheduleDraft(value,row.route.taskId))throw Error('This schedule draft changed or became unreadable. Refresh before reviewing it.');
 if(row.clearType==='first-step'&&(!validFirstStepDraft(value)||value.taskId!==row.route.taskId))throw Error('This first-step draft changed or became unreadable. Refresh before reviewing it.');
 if(row.clearType==='step-outcome'&&(!validStepOutcomeDraft(value)||value.taskId!==row.route.taskId||value.cardSequence!==row.route.sequence))throw Error('This outcome draft changed or became unreadable. Refresh before reviewing it.');
 if(row.clearType==='daily-summary'&&(!validDailySummaryDraft(value)||value.date!==row.route.date))throw Error('This daily summary draft changed or became unreadable. Refresh before reviewing it.');
 if(value.pending)throw Error('This draft now has a pending request. Open its original editor to check the receipt.');
 return {key:row.localKey,raw,type:row.clearType,title:row.title,fields:value.fields,task:row.clearType==='task-schedule'?value.task?.text:null};
}
export function clearReviewedLocalDraft(storage,review){
 if(storage.getItem(review.key)!==review.raw)throw Error('This draft changed in another window. Refresh and review its current version before clearing.');
 storage.removeItem(review.key);
 if(storage.getItem(review.key)!==null)throw Error('The draft could not be cleared. Refresh and inspect the current copy.');
}

// Use explicit calendar dates, never the browser clock or a guessed creation day.
export function recoveryGroups(rows,today){
 const known=recoveryDate(today),groups=[['today','Today'],['week','This week'],['upcoming','Upcoming'],['earlier','Earlier dates'],['undated',known?'Date not recorded':'Current day unavailable']].map(([key,label])=>({key,label,rows:[]}));
 for(const row of rows){
  let key='undated';
  if(known&&recoveryDate(row.date)){
   const weekly=row.period==='week'||row.route?.type==='weekly'||row.route?.period==='week';
   const end=new Date(row.date+'T12:00:00Z');end.setUTCDate(end.getUTCDate()+6);
   key=weekly&&row.date<=today&&end.toISOString().slice(0,10)>=today?'week':row.date===today?'today':row.date>today?'upcoming':'earlier';
  }
  groups.find(g=>g.key===key).rows.push(row);
 }
 return groups.filter(g=>g.rows.length);
}

export async function captureRecovery({api,storage,vault}){
 const drafts=[],reviews=[],warnings=[],route={type:'task-capture'};
 try{
  const raw=storage.getItem('aurora-task-capture:'+vault+':main');
  if(raw!==null){
   let d;try{d=JSON.parse(raw);}catch{}
   const valid=validLocalCapture(d);
   drafts.push({title:'Local task capture recovery',route,unreadable:!valid,pending:false,text:valid?d.fields.text.slice(0,180):'Local capture text is unreadable and has been kept.',date:valid&&recoveryDate(d.fields.planDate)?d.fields.planDate:null,dateLabel:'Draft planned date',localKey:'aurora-task-capture:'+vault+':main',clearType:valid?'local-capture':null});
  }
 }catch{warnings.push('Local task capture recovery could not be read. Open task capture to inspect it.');}
 try{
  const d=await api('/api/task-capture'),p=d.proposal;
  const hasFields=Object.entries({text:'',project:'',duration:'30',due:'',planDate:'',startTime:''}).some(([k,v])=>d.fields[k]!==v);
  if(d.proposalId){
   const accepted=p?.status==='accepted',pending=p?.status==='pending';
   reviews.push({title:accepted?'Task capture · saved receipt':'Task capture · review',route,date:recoveryDate(d.fields.planDate)?d.fields.planDate:null,detail:(accepted?'Task already added. Open its existing receipt.':pending?d.saveStarted?'Save was attempted; inspect its receipt.':'Preview awaiting your decision.':'Preview or receipt unavailable; open capture to recover it.')+' '+d.fields.text.slice(0,180),dateLabel:'Planned date'});
  }else if(hasFields)drafts.push({title:'Shared task capture draft',route,unreadable:false,pending:false,text:d.fields.text.slice(0,180),date:recoveryDate(d.fields.planDate)?d.fields.planDate:null,dateLabel:'Draft planned date'});
 }catch{warnings.push('Shared task capture could not be read. Its draft or receipt may still be available in task capture.');}
 return {drafts,reviews,warnings};
}
