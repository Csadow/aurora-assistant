export function taskProposalReview(p,escape,{controls=true,saveStarted=false}={}){
  const r=p.review;
  if(r?.version!==1)return null;
  const value=(task,key)=>{
    if(!task)return '—';const v=task[key];
    if(v===null||v===undefined||v==='')return 'Not set';
    if(key==='parent')return r.linkLabels?.[v]?r.linkLabels[v]+' · '+v:v;
    if(key==='dependsOn')return v.map(id=>r.linkLabels?.[id]?r.linkLabels[id]+' · '+id:id).join('; ')||'None';
    if(key==='duration')return v+' minutes';
    if(key==='remindAt')return new Date(v).toLocaleString()+' ('+Intl.DateTimeFormat().resolvedOptions().timeZone+')';
    return String(v);
  };
  const fields=[['text','Task'],['planDate','Planned date'],['startTime','Start time'],['duration','Duration'],['priority','Priority'],['due','Deadline'],['remindAt','Reminder']];
  if(r.before?.project||r.after.project)fields.push(['project','Project note']);
  if(r.before?.parent||r.after.parent)fields.push(['parent','Parent task ID']);
  if(r.before?.dependsOn?.length||r.after.dependsOn?.length)fields.push(['dependsOn','Prerequisite task IDs']);
  const rows=fields.map(([key,label])=>`<tr${r.before&&r.before[key]!==r.after[key]?' class="task-review-changed"':''}><th scope="row">${label}</th><td>${escape(value(r.before,key))}</td><td>${escape(value(r.after,key))}</td></tr>`).join('');
  return `<article class="proposal task-review" data-task-review="${p.id}"><small>${r.before?'TASK CHANGE':'NEW TASK'} · ${saveStarted?'SAVE NEEDS CHECKING':'NOT YET SAVED'}</small><h3>${escape(p.title)}</h3><p>${escape(r.path)} · Work times: ${escape(r.timezone)}</p><div class="task-review-table"><table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${rows}</tbody></table></div>${r.warnings.map(w=>`<p class="panel-help">${escape(w)}</p>`).join('')}${r.conflicts.length?`<div class="task-review-conflicts"><strong>Schedule conflicts to review</strong>${r.conflicts.map(c=>`<p>${escape(c.time)} · ${escape(c.kind)} · ${escape(c.title)}</p>`).join('')}<label><input type="checkbox" data-task-overlaps="${p.id}"> Save despite these conflicts</label></div>`:''}<p class="panel-help">${saveStarted?'Retrying checks the existing save before writing again. Editing also checks for a completed save.':'Only accepting this review changes the task. Other fields stay as shown. A changed task or schedule requires a fresh review.'}</p>${controls?`<button class="primary" data-proposal="${p.id}" data-action="accept">${r.before?'Save task changes':'Add task'}</button><button data-proposal="${p.id}" data-action="dismiss">Dismiss</button>`:''}</article>`;
}
