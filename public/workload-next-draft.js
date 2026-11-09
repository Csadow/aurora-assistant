import {readSelection} from './planning-selection.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const validDate=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T12:00:00Z'))&&new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s;
export function validateWorkloadNext(d){
 try{
  if(!d||d.version!==1||!d.source||!uuid(d.source.proposalId)||!/^[0-9a-f]{64}$/.test(d.source.revision)||typeof d.source.title!=='string'||!validDate(d.source.date)||!['pending','accepted','dismissed'].includes(d.source.status)||typeof d.source.legacy!=='boolean'||!Number.isInteger(d.source.recorded)||d.source.recorded<0||!Array.isArray(d.source.rows)||d.source.rows.length>100||d.source.recorded>d.source.rows.length)throw Error();
  const ids=d.source.rows.map(r=>r?.taskId);if(ids.some(id=>!uuid(id))||new Set(ids).size!==ids.length||d.source.rows.some(r=>!r.retained||typeof r.retained.text!=='string'))throw Error();
  const s=readSelection({getItem:()=>JSON.stringify(d.selection)},'selection');if(!s||s.rows.some(r=>!ids.includes(r.taskId)))throw Error();
  const p=s.pending;if(p){const end=new Date(s.date+'T12:00:00Z');end.setUTCDate(end.getUTCDate()+6);if(!uuid(p.requestId)||p.origin!=='workload-next'||p.workloadFrom?.proposalId!==d.source.proposalId||p.workloadFrom?.revision!==d.source.revision||p.timezone!==s.timezone||p.start!==s.start||p.end!==s.end||p.gap!==s.gap||!validDate(p.date)||!validDate(p.today)||p.date<s.date||p.date>end.toISOString().slice(0,10)||!Array.isArray(p.selected)||!p.selected.length||new Set(p.selected.map(r=>r?.taskId)).size!==p.selected.length||p.selected.some(r=>!r||typeof r.contextRevision!=='string'||!s.rows.some(s=>s.selected&&s.taskId===r.taskId)))throw Error();}
  return d;
 }catch{throw Error('This saved unfinished-work draft cannot be read. It has been kept; discard it explicitly to start another.');}
}
export function readWorkloadNext(storage,key){const raw=storage.getItem(key);if(raw===null)return null;let d;try{d=JSON.parse(raw);}catch{}return validateWorkloadNext(d);}
export function createWorkloadNext(report){return validateWorkloadNext({version:1,source:structuredClone(report.source),selection:{version:1,date:report.date,timezone:report.timezone,start:'09:00',end:'18:00',gap:10,rows:report.rows.map(r=>({...structuredClone(r),selected:false}))}});}
export function writeWorkloadNext(storage,key,expected,draft){validateWorkloadNext(draft);if(storage.getItem(key)!==expected)throw Error('This unfinished-work draft changed in another window. Reload before editing.');const value=JSON.stringify(draft);storage.setItem(key,value);return value;}
