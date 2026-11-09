// Test-only inclusive timings. No request bodies or personal paths are recorded.
export function nativeProfile(backend){
 const active=process.env.AURORA_NATIVE_PROFILE==='1',metrics={},restore=[];
 if(active)for(const [label,target,names] of [['vault',backend.vault,['list','read','safe']],['store',backend.store,['list','get']],['planner',backend.dayPlanning,['briefing','execution','weekCapacity']],['tasks',backend.taskWorkflows,['summary']]])for(const name of names){
  if(typeof target?.[name]!=='function')continue;const original=target[name],m=metrics[label+'.'+name]={calls:0,milliseconds:0};
  target[name]=async function(...args){const at=performance.now();m.calls++;try{return await original.apply(this,args);}finally{m.milliseconds+=performance.now()-at;}};
  restore.push(()=>target[name]=original);
 }
 return {snapshot:()=>active?{cpu:process.cpuUsage(),methods:Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,{calls:v.calls,milliseconds:Math.round(v.milliseconds)}]))}:undefined,restore:()=>restore.forEach(fn=>fn())};
}
