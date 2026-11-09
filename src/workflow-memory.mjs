import {AppError,markdown,slug} from './vault.mjs';

export async function workflowMemory({store,assistant},w,{body,title,project=''}={}){
  if(w.status!=='completed')throw new AppError('Finish the workflow before drafting its project memory.',409);
  let projectNote;if(project){projectNote=await assistant.vault.read(project);if(['journal','draft','archived'].includes(projectNote.status))throw new AppError('Link a confirmed project or knowledge note.');}
  const draft=[`## Goal\n${w.goal}`,projectNote?`Related: [[${projectNote.path.slice(0,-3)}]]`:'',
    `## Decisions and corrections\n${w.directives?.length?w.directives.map(d=>'- '+d.instruction).join('\n'):'No changes to the original instructions were recorded.'}`,
    `## Results\n${w.steps.filter(s=>s.status==='completed').map(s=>`### ${s.title}\n${s.summary||''}\nCheck: ${s.check}`).join('\n\n')}`,
    `## Evidence\n${w.operations.filter(o=>o.status==='completed'&&['propose_file_edit','propose_command','verify_outcome'].includes(o.name)).map(o=>'- '+o.name+': '+JSON.stringify(o.name==='propose_file_edit'?{path:o.arguments.path,revision:o.expected?.revision}:o.arguments)).join('\n').slice(0,3500)||'See the saved workflow for observation results.'}`,
    '## Unresolved issues and next steps\nReview these conclusions and add any remaining work before accepting this memory. Aurora’s step summaries are assessments, not independent guarantees.',
    `Workflow: ${w.id}\nCompleted: ${w.completed}\nModel: ${w.model}`].filter(Boolean).join('\n\n');
  if(body===undefined)return {title:slug(w.goal.slice(0,75)),body:draft.slice(0,14000),project};
  if(typeof body!=='string'||!body.trim()||body.length>16000||typeof title!=='string'||!title.trim()||title.length>100)throw new AppError('Review a title (up to 100 characters) and memory text (up to 16,000 characters).');
  const existing=(await store.list('proposals')).find(p=>p.workflow===w.id&&['pending','accepted'].includes(p.status));if(existing)return existing;
  const link=projectNote?`[[${projectNote.path.slice(0,-3)}]]`:null;
  const noteTitle=slug(title),content=markdown(noteTitle,body+(link&&!body.includes(link)?'\n\nRelated: '+link:''),{status:'confirmed',kind:'project',source:`workflow:${w.id}`});
  return store.proposal({kind:'note',workflow:w.id,conversation:w.conversation||null,title:noteTitle,path:`20 Projects/${noteTitle} ${w.id.slice(0,8)}.md`,content});
}
