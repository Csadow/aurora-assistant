import {AppError,sha} from './vault.mjs';
import {buildWorkloadFollow} from './workload-follow.mjs';
import {weekCapacityReport,assessWeekCapacity} from './week-capacity.mjs';

const hash=v=>sha(JSON.stringify(v));
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function workloadFrom(value){
 if(!value||!uuid(value.proposalId)||typeof value.revision!=='string'||!/^[0-9a-f]{64}$/.test(value.revision))throw new AppError('Choose a valid source workload plan.');
 return {proposalId:value.proposalId,revision:value.revision};
}
// No nested vault lock: preview/save verification also calls this while holding it.
export async function workloadPlanningSource(planner,proposalId){
 if(!uuid(proposalId))throw new AppError('Choose a valid source workload plan.');
 const report=await buildWorkloadFollow(planner,{proposalId}),p=report.plans[0];
 if(!report.sources.proposals||!report.sources.history||!report.sources.tasks||!p||p.error)throw new AppError(p?.error||'The source workload, task details or recorded history is unavailable. Keep this draft and retry.',503);
 const history=await planner.dailyFocus.history.read();
 if(history?.pending?.decision?.proposalId===proposalId)throw new AppError('The source history awaits reconciliation. Review task history before choosing another plan.',409);
 return workloadSourceSnapshot(p);
}
// Historical fields only; current task edits never rewrite the source revision.
export function workloadSourceSnapshot(p){
 const rows=p.rows.map(r=>({taskId:r.taskId,retained:r.retained,selection:r.selection,beforePreview:r.beforePreview,proposed:r.proposed,held:r.held,saved:r.saved,noteSaved:r.noteSaved}));
 const source={proposalId:p.id,date:p.date,title:p.title,status:p.status,legacy:p.legacy,recorded:p.recorded,rows};
 return {...source,revision:hash(source)};
}
export async function verifyWorkloadFrom(planner,from,selected){
 from=workloadFrom(from);const source=await workloadPlanningSource(planner,from.proposalId);
 if(from.revision!==source.revision)throw new AppError('The source workload or its recorded saves changed. Reload and compare the source before continuing.',409);
 if(!Array.isArray(selected)||selected.some(r=>!source.rows.some(s=>s.taskId===r?.taskId)))throw new AppError('Choose only tasks from this source workload.');
 return source;
}
export function workloadNextReport(planner,input={}){return planner.vault.exclusive(()=>report(planner,input));}
async function report(planner,{proposalId,date}={}){
 const source=await workloadPlanningSource(planner,proposalId),week=await weekCapacityReport(planner,date);
 const rows=source.rows.map(s=>{const row=week.rows.find(r=>r.taskId===s.taskId);return row?{...row,source:s}:{taskId:s.taskId,text:s.retained.text,task:null,contextRevision:hash([s.taskId,'unavailable']),issue:'Task is missing or has unreadable identity. Review its current source.',eligibleDates:[],execution:[],source:s};});
 const after=await workloadPlanningSource(planner,proposalId);if(source.revision!==after.revision)throw new AppError('The source workload changed while loading. Reload the draft.',409);
 return {...week,source,rows};
}
export async function assessWorkloadNext(planner,input){
 const from=workloadFrom(input.workloadFrom),source=await verifyWorkloadFrom(planner,from,input.selected);
 const result=await assessWeekCapacity(planner,input);await verifyWorkloadFrom(planner,from,input.selected);
 for(const day of result.days)if(day.preview)day.preview={...day.preview,origin:'workload-next',workloadFrom:from};
 return {...result,source};
}
