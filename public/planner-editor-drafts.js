const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const limits={text:600,due:10,planDate:10,startTime:5,duration:8,priority:10};
export function validScheduleDraft(d,id){return d?.version===1&&d.task?.id===id&&uuid(id)&&typeof d.task.text==='string'&&typeof d.task.path==='string'&&typeof d.task.revision==='string'&&Number.isInteger(d.task.line)&&d.task.line>=0&&typeof d.task.done==='boolean'&&d.fields&&Object.keys(d.fields).length===6&&Object.entries(limits).every(([k,n])=>typeof d.fields[k]==='string'&&d.fields[k].length<=n)&&['normal','high','low'].includes(d.fields.priority);}
export function plannerEditorDrafts({vault,storage=localStorage}){
 const key=id=>{const root=vault();if(!root||!uuid(id))throw Error('Wait for a valid task and vault before editing its schedule.');return 'aurora-schedule-draft:'+root+':'+id;};
 return {
  supports:task=>uuid(task?.id),
  read(id){let raw;try{raw=storage.getItem(key(id));}catch{throw Error('The schedule draft cannot be read. Keep existing edits open and retry.');}if(raw===null)return null;let d;try{d=JSON.parse(raw);}catch{}if(!validScheduleDraft(d,id))throw Error('The saved schedule draft is unreadable. It has been kept until you explicitly discard it.');return d;},
  save(task,fields){const d={version:1,task,fields};if(!validScheduleDraft(d,task.id))throw Error('The schedule draft is invalid. Keep your text and review the fields.');try{storage.setItem(key(task.id),JSON.stringify(d));}catch{throw Error('The schedule draft could not be stored. Keep this editor open and retry before leaving.');}},
  clear(id){try{storage.removeItem(key(id));}catch{throw Error('The schedule draft could not be cleared. It remains available for comparison.');}}
 };
}
