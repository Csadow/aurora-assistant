import {readTaskListState,taskListModel} from './task-list-core.js';
export function mountTaskList({root,filter,date,renderRow,vault,notes,storage=localStorage}){
 const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
 let key=null,state=null,damaged=false,saveError='',loadError='',tasks=[],rendered=false;
 const heading=node('h3','Task list');heading.tabIndex=-1;root.id='planner-task-list';
 const fields=node('div');fields.className='task-list-controls';const query=node('input');query.type='search';query.maxLength=500;query.id='task-list-search';query.placeholder='Task, project or source note';
 const project=node('select');project.id='task-list-project';filter.id='task-list-status';filter.replaceChildren();
 for(const [value,label] of [['open','All open tasks'],['today','Planned for selected date'],['unscheduled','Without a planned date'],['done','Completed tasks'],['all','All tasks, including completed']]){const option=node('option',label);option.value=value;filter.append(option);}
 for(const [label,input] of [['Search tasks',query],['Project',project],['Status',filter]]){const wrap=node('label',label);wrap.append(input);fields.append(wrap);}
 const reset=node('button','Reset saved filters');reset.type='button';fields.append(reset);
 const help=node('p','Search matches every word across task text, project titles and source paths. Filters only affect this list; schedule suggestions still consider all commitments.');help.className='panel-help';
 const status=node('p');status.id='task-list-summary';status.setAttribute('role','status');
 const warning=node('p');warning.id='task-list-storage';warning.className='planner-warning';warning.setAttribute('role','status');
 const problems=node('details');problems.id='task-list-problems';
 const results=node('div');results.id='task-list-results';results.tabIndex=0;results.setAttribute('aria-label','Matching tasks');
 root.replaceChildren(heading,fields,help,warning,problems,status,results);
 const defaults=()=>({version:1,query:'',project:'all',status:'open',date:date.value,scrollTop:0,focus:null});
 const visible=()=>!!root.getClientRects().length;
 function prepare(){
  const current=vault();if(!current)throw Error('Wait for the vault to load.');const next='aurora-task-list:'+current;if(next===key)return;
  key=next;damaged=false;saveError='';loadError='';rendered=false;
  try{state=readTaskListState(storage,current)||defaults();date.value=state.date;}catch(e){state=defaults();damaged=true;saveError=e.message;}
  query.value=state.query;filter.value=state.status;
 }
 function persist(){if(!state||damaged)return;try{storage.setItem(key,JSON.stringify(state));saveError='';}catch{saveError='Task filters work in this session but could not be saved for restart. Your tasks and editor drafts are kept.';}warning.textContent=saveError;}
 function capture(){if(state&&rendered&&visible())state.scrollTop=results.scrollTop;}
 const focusTarget=()=>[...results.querySelectorAll('[data-task-list-key]')].find(el=>el.dataset.taskListKey===state.focus?.key);
 function restoreFocus(){
  const card=focusTarget(),button=card&&[...card.querySelectorAll('button')].find(b=>b.textContent===state.focus?.action&&!b.disabled);
  if(button)button.focus({preventScroll:true});else{heading.focus({preventScroll:true});if(state.focus)status.textContent+=' The previous task or action is no longer in these results. Your filters are kept.';}
 }
 function render(){
  if(!state)return;const previous=document.activeElement,hadFocus=results.contains(previous)&&previous!==results;
  capture();const model=taskListModel(tasks,notes(),state),scroll=state.scrollTop;
  project.replaceChildren();for(const [value,label] of [['all','All projects'],['none','No project'],...model.projects.map(p=>[p.path,p.title+(p.missing?' · missing project note':'')])]){const option=node('option',label);option.value=value;project.append(option);}project.value=state.project;
  status.textContent=loadError?'Tasks could not be refreshed: '+loadError+'. Showing the last loaded results.':model.rows.length+' matching of '+model.total+' tasks · '+(state.status==='today'?'Selected date '+state.date:'Filters apply to the task list');
  warning.textContent=saveError;
  const expanded=problems.open;problems.replaceChildren(node('summary',model.problems.length+' task source issue(s) across all tasks'));
  for(const {task,issue} of model.problems){const line=node('p',issue+' · '+task.path+' · line '+(task.line+1)+' '),source=node('button','Open source note');source.type='button';source.dataset.note=task.path;line.append(source);problems.append(line);}problems.hidden=!model.problems.length;problems.open=expanded;
  results.replaceChildren();for(const {task,key:taskKey,issue} of model.rows){const card=renderRow(task);card.dataset.taskListKey=taskKey;if(issue){for(const b of card.querySelectorAll('button'))b.disabled=true;const p=node('p',issue+' — repair the source note before changing this task.');p.className='planner-warning';const source=node('button','Open source note');source.type='button';source.dataset.note=task.path;card.append(p,source);}results.append(card);}
  if(!model.rows.length)results.append(node('p',model.total?'No tasks match these filters. Try another search or reset saved filters.':'No tasks yet. Add one above to start planning.'));
  // Hidden views have no measurable scroll offset; keep their saved position.
  rendered=visible();results.scrollTop=scroll;if(hadFocus)restoreFocus();
 }
 function changed(){state.query=query.value;state.project=project.value;state.status=filter.value;state.date=date.value;state.scrollTop=0;state.focus=null;results.scrollTop=0;persist();render();}
 query.oninput=changed;project.onchange=changed;filter.onchange=changed;
 results.addEventListener('scroll',()=>{if(visible()){capture();persist();}});
 results.addEventListener('focusin',event=>{const b=event.target.closest('button'),card=b?.closest('[data-task-list-key]');if(card){state.focus={key:card.dataset.taskListKey,action:b.textContent};persist();}});
 results.addEventListener('click',event=>{const b=event.target.closest('button'),card=b?.closest('[data-task-list-key]');if(card){capture();state.focus={key:card.dataset.taskListKey,action:b.textContent};persist();}},true);
 reset.onclick=()=>{try{storage.removeItem(key);}catch{warning.textContent='Saved filters could not be reset. Your current filters are kept.';return;}damaged=false;saveError='';state=defaults();query.value='';filter.value='open';results.scrollTop=0;render();persist();query.focus({preventScroll:true});};
 return {prepare,update(next){tasks=next;loadError='';if(state.date!==date.value){state.date=date.value;state.scrollTop=0;state.focus=null;results.scrollTop=0;persist();}render();},unavailable(error){loadError=error.message;render();},reopen(){root.scrollIntoView({block:'start',behavior:'instant'});results.scrollTop=state.scrollTop;restoreFocus();},element:root};
}
