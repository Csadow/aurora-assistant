import {readSelection} from './planning-selection.js';
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const selection=value=>readSelection({getItem:()=>JSON.stringify(value)},'draft');
export function validateWorkload(d){
 try{
  if(!d||d.version!==1)throw Error();
  const source=selection(d.source),current=selection(d.selection),ids=source.rows.map(r=>r.taskId);
  if(!ids.length||ids.length>100||ids.some(id=>!uuid(id))||source.pending||source.rows.some(r=>!r.selected||!r.task||r.task.id!==r.taskId)||current.rows.some(r=>!ids.includes(r.taskId)))throw Error();
  const p=current.pending;
  if(p){if(p.workloadSource!==undefined&&JSON.stringify(p.workloadSource)!==JSON.stringify(workloadContext(d)))throw Error();const last=new Date(current.date+'T12:00:00Z');last.setUTCDate(last.getUTCDate()+6);
   if(!uuid(p.requestId)||p.origin!=='week-workload'||p.timezone!==current.timezone||p.start!==current.start||p.end!==current.end||p.gap!==current.gap||typeof p.date!=='string'||p.date<current.date||p.date>last.toISOString().slice(0,10)||!Array.isArray(p.selected)||!p.selected.length||new Set(p.selected.map(r=>r.taskId)).size!==p.selected.length||p.selected.some(r=>!r||typeof r.contextRevision!=='string'||!current.rows.some(c=>c.selected&&c.taskId===r.taskId)))throw Error();
  }
  return d;
 }catch{throw Error('This saved workload comparison cannot be read. It has been kept; discard it explicitly to start another.');}
}
export function readWorkload(storage,key){const raw=storage.getItem(key);if(raw===null)return null;let d;try{d=JSON.parse(raw);}catch{}return validateWorkload(d);}
export function createWorkload(source){
 const saved={...structuredClone(source),rows:source.rows.filter(r=>r.selected).map(r=>structuredClone(r))};delete saved.pending;
 return validateWorkload({version:1,source:saved,selection:structuredClone(saved)});
}
export function writeWorkload(storage,key,expected,draft){
 validateWorkload(draft);
 if(storage.getItem(key)!==expected)throw Error('This comparison changed in another window. Reload the saved comparison before editing.');
 const value=JSON.stringify(draft);storage.setItem(key,value);return value;
}

export function workloadContext(d){
 return {version:1,date:d.source.date,timezone:d.source.timezone,start:d.source.start,end:d.source.end,gap:d.source.gap,rows:d.source.rows.map(r=>({taskId:r.taskId,task:Object.fromEntries(['id','path','text','done','planDate','startTime','duration','due'].map(k=>[k,r.task[k]??null]))})),selectedIds:d.selection.rows.filter(r=>r.selected).map(r=>r.taskId)};
}
