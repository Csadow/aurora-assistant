import {AppError,sha} from './vault.mjs';
import {stepOutcomeRows} from './step-outcomes.mjs';
import {projectNotes} from '../mobile/web/task-links.js';

// This is an observation of unfinished work, never a task mutation or a focus choice.
export async function outcomePlanningRows(planner,report){
 if(!planner.firstSteps)throw new AppError('First-step history is unavailable.',503);
 const state=await planner.firstSteps.read(),projects=projectNotes(await planner.vault.list()),groups=new Map();
 for(const o of stepOutcomeRows(state).filter(o=>o.unresolved&&o.context.date<=report.today)){
  if(!groups.has(o.taskId))groups.set(o.taskId,[]);
  const {id,taskId,cardSequence,kind,note,recordedAt,card,context}=o;
  groups.get(o.taskId).push({id,taskId,cardSequence,kind,note,recordedAt,card,context});
 }
 const rows=[...groups].map(([taskId,outcomes])=>{
  const row=report.rows.find(r=>r.taskId===taskId)||{taskId,text:outcomes.at(-1).card.context.task.text,task:null,issue:'Task no longer in active notes; completion is unknown.',execution:[],dependencyReasons:[],contextRevision:'missing'};
  const n=row.task?.project?projects.find(n=>n.path===row.task.project):null;
  const project=row.task?.project?{path:row.task.project,title:n?.title||row.task.project,revision:n?.revision||null,missing:!n,excerpt:n?.body.slice(0,1000)||''}:null;
  const source={taskId,outcomes,project,currentCard:state.cards[taskId]};
  source.revision=sha(JSON.stringify({source,planContext:row.contextRevision}));
  return {...row,planContext:row.contextRevision,contextRevision:source.revision,source};
 });
 return {...report,rows};
}
