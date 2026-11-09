import {taskGraph,taskRef} from './task-links.js';
import {readTimetable,timetableMarkdown,emptyTimetable,classesForDay,weekdays} from './timetable.js';
import {agenda,suggestDay,localDay,clock,minutes,taskKey,currentTask,taskSignature} from './planner-core.js';
export function mountPlanner(root,adapter){
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const message=node('p','','planner-message');message.setAttribute('role','status');
  let calendar={enabled:false,blocks:[]};
  let calendarSync={connected:false,links:[]};
  let loaded=false,loadVersion=0,calendarVersion=0,persistEditor=null,readEditor=null;
  let tasks=[],linksGraph=taskGraph([]),draft=null,busy=false,editing=null,timetable=emptyTimetable(),timetableNote=null,timetableError=null;
  const run=fn=>async()=>{if(busy)return;busy=true;root.setAttribute('aria-busy','true');message.textContent='';try{await fn();}catch(e){message.textContent=e.message;}finally{busy=false;root.removeAttribute('aria-busy');}};
  const button=(label,fn)=>{const b=node('button',label);b.type='button';b.onclick=run(fn);return b;};
  const field=(label,type,value)=>{const wrap=node('label',label),input=node('input');input.type=type;input.value=value;input.setAttribute('aria-label',label);wrap.append(input);return {wrap,input};};
  const title=node('h2','Day planner'),intro=node('p',adapter.description,'planner-help');
  const toolbar=node('div',undefined,'planner-fields');
  const day=field('Plan date','date',localDay()),start=field('Day starts','time','09:00'),end=field('Day ends','time','18:00'),gap=field('Break (minutes)','number','10');
  gap.input.min='0';gap.input.max='120';
  try{const saved=JSON.parse(localStorage.getItem('aurora-planner-hours')||'null');if(saved){start.input.value=saved.start;end.input.value=saved.end;gap.input.value=saved.gap;}}catch{}
  toolbar.append(day.wrap,start.wrap,end.wrap,gap.wrap);
  const options=node('details',undefined,'planner-options'),optionsSummary=node('summary','Plan date and available hours');options.open=!adapter.compact&&!adapter.collapseOptions;options.append(optionsSummary,toolbar);
  const actions=node('div',undefined,'planner-actions');
  const summary=node('p','','planner-help'),blocks=node('div'),preview=node('div'),list=node('div');
  const editor=node('form',undefined,'planner-editor');editor.hidden=true;
  const timetablePanel=node('details'),timetableBody=node('div'),classEditor=node('form',undefined,'planner-editor');classEditor.hidden=true;
  timetablePanel.append(node('summary','Class timetable · repeats weekly'),timetableBody,classEditor);
  const capture=node('form',undefined,'planner-capture'),input=node('input');input.placeholder='Add a task you want to remember…';input.setAttribute('aria-label','Planner new task');input.required=true;input.maxLength=600;
  const add=node('button','Add task');add.type='submit';capture.append(input,add);
  capture.onsubmit=e=>{e.preventDefault();run(async()=>{await adapter.add(input.value);input.value='';await load();message.textContent='Task saved.';})()};
  const filter=node('select');filter.setAttribute('aria-label','Planner task filter');
  for(const [value,text] of [['open','All open tasks'],['today','Planned for this day'],['done','Completed tasks']]){const o=node('option',text);o.value=value;filter.append(o);}
  filter.onchange=()=>render();
  function discardEditor(){if(!editor.hidden){if(adapter.editorDrafts?.supports(editing))persistEditor?.();else if(!confirm('Discard this unsaved task edit?'))return false;}editor.hidden=true;editing=null;persistEditor=null;return true;}
  actions.append(button('Today',async()=>{day.input.value=localDay();await loadCalendar();applyDayHours();draft=null;render();}),button('Refresh tasks',load),button('Suggest schedule',async()=>{
    await loadCalendar(true);const reserved=reservedFor(day.input.value);
    draft={...suggestDay(tasks,{date:day.input.value,start:start.input.value,end:end.input.value,gap:classesForDay(timetable,day.input.value).gap??Number(gap.input.value),reserved,windows:classesForDay(timetable,day.input.value).windows}),gap:classesForDay(timetable,day.input.value).gap??Number(gap.input.value),date:day.input.value,calendarRevision:calendar.revision,timetableRevision:timetableNote?.revision??null};
    try{localStorage.setItem('aurora-planner-hours',JSON.stringify({start:start.input.value,end:end.input.value,gap:gap.input.value}));}catch{}
    renderPreview();
  }));
  for(const f of [day,start,end,gap])f.input.onchange=run(async()=>{if(f===day){await loadCalendar();applyDayHours();}draft=null;render();});
  root.classList.add('aurora-planner');root.replaceChildren(title,...(adapter.description?[intro]:[]),capture,options,actions,message,summary,blocks,preview,timetablePanel,editor,filter,list);
  const taskList=adapter.mountList?.({root:list,filter,date:day.input,renderRow:row});
  function row(t){
    const card=node('div',undefined,'planner-task'),info=node('div');
    if(t.id)card.dataset.taskId=t.id;
    info.append(node('strong',t.text));
    const detail=[t.priority+' priority',t.duration+' min',t.due?'Due '+t.due:'',t.planDate?'Planned '+t.planDate+(t.startTime?' at '+t.startTime:''):'Unscheduled',t.scheduleError?'Invalid task metadata':''].filter(Boolean).join(' · ');
    info.append(node('small',detail),node('small',t.path));
    const links=linksGraph.states.get(taskRef(t));if(t.project)info.append(node('small','Project: '+t.project));if(links?.parent)info.append(node('small','Subtask of '+links.parent));if(links?.children.length)info.append(node('small',links.completedChildren+' / '+links.children.length+' subtasks complete'));if(links?.blocked)info.append(node('small',links.reasons.join('; '),'planner-warning'));for(const w of links?.warnings||[])info.append(node('small',w,'planner-warning'));
    const controls=node('div',undefined,'planner-actions');
    controls.append(button(t.done?'Reopen':'Complete',async()=>{await adapter.update(t,{done:!t.done});await load();}));
    controls.append(button('Edit / schedule',()=>openEditor(t)));
    if(adapter.details&&t.id)controls.append(button('Task details',()=>adapter.details(t)));
    if(adapter.execution)controls.append(button('Work with Aurora',()=>adapter.execution(t)));
    if(adapter.connections)controls.append(button('Project / steps',()=>adapter.connections(t)));
    if(adapter.reviewCalendar&&calendarSync.connected){
      const sync=calendarSync.links.find(l=>l.taskId===t.id);
      if(sync)info.append(node('small','Google Calendar · '+(calendarSync.fresh?'':'last checked: ')+sync.detail,'planner-calendar-status'));
      if(sync||t.id&&!t.done&&t.planDate&&!t.scheduleError)controls.append(button(sync?'Review calendar sync':'Link Google Calendar',()=>adapter.reviewCalendar(t)));
    }
    card.append(info,controls);return card;
  }
  function render(){
    linksGraph=taskGraph(tasks);
    const date=day.input.value,view=agenda(tasks,date),classes=classesForDay(timetable,date);
    if(adapter.collapseOptions)optionsSummary.textContent='Plan '+date+' · '+start.input.value+'–'+end.input.value+' · '+gap.input.value+' min breaks';
    renderTimetable();
    summary.textContent=`${tasks.filter(t=>!t.done).length} open · ${view.minutes} task minutes scheduled · ${view.overdue.length} overdue · ${view.missed.length} missed planned tasks`;
    blocks.replaceChildren(node('h3','Schedule · '+date));
    blocks.append(node('p','Times use this device’s local clock: '+Intl.DateTimeFormat().resolvedOptions().timeZone+'. Scheduled blocks do not create notifications.','planner-help'));
    if(classes.windows)blocks.append(node('p','Available windows: '+(classes.windows.map(w=>w.join('–')).join(', ')||'day off')+' · '+classes.gap+' min breaks. Day start/end further limit suggestions.','planner-help'));
    for(const warning of calendar.warnings||[])blocks.append(node('p',warning,'planner-warning'));
    if(calendar.enabled&&!calendar.complete)blocks.append(node('p','Google Calendar coverage is incomplete. Refresh before suggesting a schedule.','planner-warning'));
    for(const b of calendar.blocks||[]){const card=node('div',undefined,'planner-class calendar-block');card.dataset.start=clock(b.start);card.append(node('strong',(b.allDay?'All day':clock(b.start)+'–'+clock(b.end))+' · '+b.title),node('small','Google Calendar'+(b.location?' · '+b.location:'')));blocks.append(card);}
    if(timetableError)blocks.append(node('p',timetableError,'planner-warning'));
    if(classes.unknown)blocks.append(node('p','Class times for '+weekdays[new Date(date+'T12:00:00Z').getUTCDay()]+' are incomplete. Add them before using schedule suggestions.','planner-warning'));
    for(const c of classes.classes){const card=node('div',undefined,'planner-class');card.dataset.start=c.start;card.append(node('strong',c.start+'–'+c.end+' · '+c.title),node('small',c.location+' · weekly class'));blocks.append(card);}
    if(classes.classes.length)blocks.append(node('p','Travel: '+timetable.travelBefore+' min before first class, '+timetable.travelAfter+' min after last.'+(timetable.travelConfirmed?'':' Travel time is not configured yet.'),'planner-help'));
    if(view.blocks.some(t=>classes.unavailable.some(([a,b])=>minutes(t.startTime)<b&&minutes(t.startTime)+t.duration>a)))blocks.append(node('p','A task is outside your available hours. Existing blocks stay in place until you edit them.','planner-warning'));
    if(view.blocks.some(t=>classes.busy.some(([a,b])=>minutes(t.startTime)<b&&minutes(t.startTime)+t.duration>a)))blocks.append(node('p','A task overlaps a class or travel block. Edit its time before planning more.','planner-warning'));
    for(const t of view.blocks){const card=row(t);card.dataset.start=t.startTime;card.prepend(node('p',t.startTime+'–'+clock(minutes(t.startTime)+t.duration),'planner-time'));blocks.append(card);}
    [...blocks.children].filter(n=>n.dataset.start).sort((a,b)=>a.dataset.start.localeCompare(b.dataset.start)).forEach(n=>blocks.append(n));
    if(!view.blocks.length)blocks.append(node('p','No task blocks yet. Add tasks, then suggest a schedule or set a time yourself.','planner-help'));
    if(view.conflicts.length)blocks.append(node('p',view.conflicts.length+' overlapping block(s). Edit their times to make room.','planner-warning'));
    if(view.invalid.length)blocks.append(node('p','Some task metadata is invalid. Open its Markdown note to repair it.','planner-warning'));
    if(view.missed.length){const missed=node('details');missed.append(node('summary','Missed planned tasks · '+view.missed.length));view.missed.forEach(t=>missed.append(row(t)));blocks.append(missed);}
    if(taskList)taskList.update(tasks);else{
      list.replaceChildren();
      const shown=tasks.filter(t=>filter.value==='done'?t.done:filter.value==='today'?!t.done&&t.planDate===date:!t.done);
      for(const t of shown)list.append(row(t));
      if(!shown.length)list.append(node('p','No tasks in this view.','planner-help'));
    }
    renderPreview();
  }
  function renderPreview(){
    preview.replaceChildren();if(!draft)return;
    preview.append(node('h3','Suggested schedule · not saved'),node('p','Existing blocks stay in place. Due tasks and high priorities come first. Review this suggestion before applying it.','planner-help'));
    for(const p of draft.proposed)preview.append(node('p',p.changes.startTime+' · '+p.task.text+' · '+p.task.duration+' min'));
    for(const b of draft.blocked||[])preview.append(node('p',b.task.text+' · '+b.reasons.join('; '),'planner-warning'));
    if(draft.unplaced.length)preview.append(node('p','No room today: '+draft.unplaced.map(t=>t.text).join(', '),'planner-warning'));
    if(draft.proposed.length)preview.append(button('Save suggested schedule',async()=>{
      const plan=draft;let saved=0;
      try{for(const p of plan.proposed){
        const currentNote=await adapter.timetable?.()||null;
        if((currentNote?.revision??null)!==plan.timetableRevision)throw Error('Your class timetable changed. Suggest a fresh schedule.');
        await loadCalendar(true);if(calendar.revision!==plan.calendarRevision)throw Error('Google Calendar changed. Suggest a fresh schedule.');
        const reserved=reservedFor(plan.date);
        const latest=await adapter.list();currentTask(latest,p.task);
        const at=minutes(p.changes.startTime),finish=at+p.changes.duration;
        if(reserved.some(([a,b])=>at<b+plan.gap&&finish+plan.gap>a))throw Error('This time is reserved for a class or travel. Suggest a fresh schedule.');
        if(agenda(latest,p.changes.planDate).blocks.some(t=>taskKey(t)!==taskKey(p.task)&&at<minutes(t.startTime)+t.duration+plan.gap&&finish+plan.gap>minutes(t.startTime)))throw Error('Another task now occupies this time. Suggest a fresh schedule.');
        await adapter.update(p.task,p.changes,{requireReady:true,calendarRevision:plan.calendarRevision});saved++;
      }draft=null;await load();message.textContent=`Saved ${saved} task blocks.`;}
      catch(e){draft=null;await load();throw Error(`Saved ${saved} of ${plan.proposed.length} task blocks. ${e.message} Review the remaining tasks before trying again.`);}
    }));
    else preview.append(node('p','No unscheduled tasks fit. Change your available hours, estimates, or planned dates.','planner-help'));
    preview.append(button('Discard suggestion',()=>{draft=null;renderPreview();}));
  }
  const editorContext=t=>JSON.stringify([t.path,taskSignature(t)]);
  function openEditor(t,{current=false,keptFields=null}={}){
    const drafts=adapter.editorDrafts?.supports(t)?adapter.editorDrafts:null;let liveDraft=null;
    if(!editor.hidden&&editing&&t.id&&editing.id===t.id&&!current){persistEditor?.();if(editorContext(editing)===editorContext(t)){editor.scrollIntoView({block:'nearest'});editor.querySelector('input')?.focus();return;}liveDraft={task:editing,fields:readEditor()};}
    if(!discardEditor())return;
    if(t.scheduleError)throw Error('Repair this task’s metadata before editing its schedule.');
    let saved=null;try{if(!current)saved=liveDraft||drafts?.read(t.id);}catch(e){
      editor.replaceChildren(node('h3','Schedule draft needs attention'),node('p',e.message,'planner-warning'),button('Discard unreadable schedule draft',()=>{if(confirm('Discard this saved schedule draft? The task itself stays unchanged.')){drafts.clear(t.id);editor.hidden=true;openEditor(t);}}),button('Cancel edit',()=>{editor.hidden=true;}));editor.hidden=false;return;
    }
    editing=saved?.task||t;const values=keptFields||saved?.fields||{text:t.text,due:t.due||'',planDate:t.planDate||'',startTime:t.startTime||'',duration:String(t.duration||30),priority:t.priority||'normal'};
    editor.replaceChildren(node('h3','Edit task'));editor.hidden=false;
    const text=field('Task title','text',values.text);text.input.required=true;text.input.maxLength=600;
    const due=field('Due date','date',values.due),planned=field('Planned date','date',values.planDate),time=field('Start time','time',values.startTime),duration=field('Duration (minutes)','number',values.duration);
    duration.input.min='5';duration.input.max='720';duration.input.required=true;
    const priority=node('select');priority.setAttribute('aria-label','Task priority');
    for(const value of ['high','normal','low']){const o=node('option',value);o.value=value;priority.append(o);}priority.value=values.priority;
    const pr=node('label','Priority');pr.append(priority);
    const fields=node('div',undefined,'planner-fields');fields.append(due.wrap,planned.wrap,time.wrap,duration.wrap,pr);
    const save=node('button','Save task');save.type='submit';const status=node('p',drafts?'Schedule edits stay on this desktop until you save the task.':'','planner-help');status.id='planner-editor-draft-state';
    const read=()=>({text:text.input.value,due:due.input.value,planDate:planned.input.value,startTime:time.input.value,duration:duration.input.value,priority:priority.value});
    readEditor=read;let initial=JSON.stringify(read()),hasDraft=!!saved||!!keptFields;
    persistEditor=()=>{if(drafts&&(hasDraft||JSON.stringify(read())!==initial)){drafts.save(editing,read());hasDraft=true;initial=JSON.stringify(read());status.textContent='Schedule draft kept on this desktop.';}};
    const persist=()=>{try{persistEditor();}catch(e){status.textContent=e.message;}};editor.oninput=persist;editor.onchange=persist;
    const changed=editorContext(editing)!==editorContext(t);
    editor.append(text.wrap,fields,status);
    if(changed){
      save.disabled=true;const compare=node('section',undefined,'planner-warning');compare.id='planner-editor-stale';
      const describe=x=>x.text+' · '+(x.done?'Complete':'Open')+' · '+(x.planDate||'Unscheduled')+' '+(x.startTime||'')+' · '+x.duration+' min · Due '+(x.due||'not set')+' · Priority '+(x.priority||'normal')+' · Reminder '+(x.remindAt||'not set')+' · Source '+x.path+' · Project '+(x.project||'none')+' · Parent '+(x.parent||'none')+' · Prerequisites '+((x.dependsOn||[]).join(', ')||'none');
      compare.append(node('h4','Task changed while this draft was saved'),node('p','Original: '+describe(editing)),node('p','Current: '+describe(t)),button('Use current task, keep my edits',()=>{const kept=read();persistEditor?.();openEditor(t,{current:true,keptFields:kept});persistEditor?.();}));editor.append(compare);
    }
    editor.append(save,button('Remove planned block',()=>{planned.input.value='';time.input.value='';persist();}),button('Cancel edit',()=>{drafts?.clear(editing.id);editor.hidden=true;editing=null;persistEditor=null;}));
    if(adapter.returnToWorkspace){const back=button('Continue my day',async()=>{persistEditor?.();await adapter.returnToWorkspace();});back.dataset.plannerContinue='true';editor.append(back);}
    editor.onsubmit=e=>{e.preventDefault();run(async()=>{
      persistEditor?.();if(changed)throw Error('Compare the current task before saving these edits.');
      await adapter.update(editing,{text:text.input.value,due:due.input.value||null,planDate:planned.input.value||null,startTime:time.input.value||null,duration:Number(duration.input.value),priority:priority.value});
      drafts?.clear(editing.id);editor.hidden=true;editing=null;persistEditor=null;await load();message.textContent='Task saved.';
    })()};
    editor.scrollIntoView({behavior:'smooth',block:'nearest'});text.input.focus();
  }
  function reservedFor(date){
    if(timetableError)throw Error(timetableError);
    const view=classesForDay(timetable,date);
    if(view.unknown)throw Error('This day has incomplete class times. Fill in the timetable before suggesting a schedule.');
    if((timetable.classes.length||timetable.availability)&&timetable.timezone!==Intl.DateTimeFormat().resolvedOptions().timeZone)throw Error('The timetable timezone differs from this device. Review its timezone before scheduling.');
    if(agenda(tasks,date).blocks.some(t=>view.busy.some(([a,b])=>minutes(t.startTime)<b&&minutes(t.startTime)+t.duration>a)))throw Error('Move the task that overlaps a class or travel block before suggesting more.');
    if(calendar.enabled&&!calendar.complete)throw Error('Refresh Google Calendar before suggesting a schedule.');
    return [...view.busy,...(calendar.blocks||[]).map(b=>[b.start,b.end])];
  }
  function classForm(){
    if(!classEditor.hidden&&!confirm('Discard the unsaved timetable edit?'))return false;
    classEditor.replaceChildren();classEditor.hidden=false;timetablePanel.open=true;return true;
  }
  async function saveTimetable(value,revision){
    await adapter.saveTimetable(timetableMarkdown(value),revision);
    classEditor.hidden=true;await load();message.textContent='Weekly timetable saved.';
  }
  function renderTimetable(){
    timetableBody.replaceChildren();
    if(timetableError){timetableBody.append(node('p',timetableError,'planner-warning'));return;}
    const base=structuredClone(timetable),revision=timetableNote?.revision??null;
    timetableBody.append(node('p','Weekly in '+base.timezone+' · '+(base.from||'no start limit')+' to '+(base.until||'trimester end not set')+'.','planner-help'));
    if(base.unknownDays.length)timetableBody.append(node('p','Incomplete days: '+base.unknownDays.map(d=>weekdays[d]).join(', '),'planner-warning'));
    for(const c of base.classes.slice().sort((a,b)=>(a.day||7)-(b.day||7)||a.start.localeCompare(b.start))){
      const card=node('div',undefined,'planner-class');card.append(node('strong',weekdays[c.day]+' '+c.start+'–'+c.end+' · '+c.title),node('small',c.location));
      card.append(button('Edit class',()=>openClass(c,base,revision)),button('Remove class',async()=>{if(confirm('Remove this weekly class: '+c.title+'?'))await saveTimetable({...base,classes:base.classes.filter(v=>v.id!==c.id)},revision);}));timetableBody.append(card);
    }
    timetableBody.append(button('Add weekly class',()=>openClass(null,base,revision)),button('Travel and trimester settings',()=>{
      if(!classForm())return;
      const before=field('Travel before first class (minutes)','number',base.travelBefore),after=field('Travel after last class (minutes)','number',base.travelAfter),from=field('Trimester starts','date',base.from||''),until=field('Trimester ends','date',base.until||''),zone=field('Timetable timezone','text',base.timezone);
      before.input.min=after.input.min='0';before.input.max=after.input.max='180';before.input.required=after.input.required=true;
      classEditor.append(node('h3','Travel and trimester settings'),before.wrap,after.wrap,from.wrap,until.wrap,zone.wrap,node('p','Mark any days whose class times are still incomplete:','planner-help'));
      const unknown=weekdays.map((name,i)=>{const f=field(name+' incomplete','checkbox','');f.input.checked=base.unknownDays.includes(i);classEditor.append(f.wrap);return f.input;});
      const save=node('button','Save timetable settings');save.type='submit';classEditor.append(save,button('Cancel timetable edit',()=>classEditor.hidden=true));
      classEditor.onsubmit=e=>{e.preventDefault();run(()=>saveTimetable({...base,travelBefore:Number(before.input.value),travelAfter:Number(after.input.value),travelConfirmed:true,from:from.input.value||null,until:until.input.value||null,timezone:zone.input.value,unknownDays:unknown.flatMap((n,i)=>n.checked?[i]:[])},revision))()};
    }));
  }
  function openClass(c,base,revision){
    if(!classForm())return;
    const title=field('Class name','text',c?.title||''),location=field('Class room','text',c?.location||''),start=field('Class starts','time',c?.start||'09:00'),end=field('Class ends','time',c?.end||'09:50');
    title.input.required=start.input.required=end.input.required=true;title.input.maxLength=location.input.maxLength=200;
    const weekday=node('select');weekday.setAttribute('aria-label','Class weekday');weekdays.forEach((name,i)=>{const o=node('option',name);o.value=i;weekday.append(o);});weekday.value=c?.day??1;
    const save=node('button','Save weekly class');save.type='submit';
    classEditor.append(node('h3',c?'Edit weekly class':'Add weekly class'),title.wrap,location.wrap,weekday,start.wrap,end.wrap,save,button('Cancel timetable edit',()=>classEditor.hidden=true));
    classEditor.onsubmit=e=>{e.preventDefault();run(()=>{const value={id:c?.id||crypto.randomUUID(),day:Number(weekday.value),title:title.input.value,location:location.input.value,start:start.input.value,end:end.input.value};return saveTimetable({...base,classes:[...base.classes.filter(v=>v.id!==value.id),value]},revision);})()};
  }
  function applyDayHours(){
    const view=classesForDay(timetable,day.input.value);gap.input.disabled=!!timetable.availability;
    if(view.windows){start.input.value=view.windows[0]?.[0]||'00:00';end.input.value=view.windows.at(-1)?.[1]||'23:59';gap.input.value=view.gap;}
    else{let saved={start:'09:00',end:'18:00',gap:10};try{saved={...saved,...JSON.parse(localStorage.getItem('aurora-planner-hours')||'{}')};}catch{}start.input.value=saved.start;end.input.value=saved.end;gap.input.value=saved.gap;}
  }
  async function loadCalendar(fresh=false){
    const version=++calendarVersion,date=day.input.value;
    const next=await adapter.calendar?.(date,fresh)||{enabled:false,blocks:[]},sync=await adapter.calendarSync?.()||{connected:false,links:[]};
    if(version===calendarVersion&&date===day.input.value){calendar=next;calendarSync=sync;}
  }
  async function load({preserveDraft=false}={}){
    const version=++loadVersion,previousRevision=timetableNote?.revision;
    taskList?.prepare();let nextTasks;try{await loadCalendar();nextTasks=await adapter.list();}catch(e){if(version===loadVersion)taskList?.unavailable(e);throw e;}let note=null,value,error=null;
    try{note=await adapter.timetable?.()||null;value=readTimetable(note);}catch(e){value=emptyTimetable();error=e.message;}
    if(version!==loadVersion)return;
    tasks=nextTasks;timetableNote=note;timetable=value;timetableError=error;
    if(!preserveDraft||!loaded||previousRevision!==timetableNote?.revision)applyDayHours();
    if(!preserveDraft)draft=null;loaded=true;render();
  }
  return {load,flushEditor:()=>{if(!editor.hidden)persistEditor?.();},editTask:async taskId=>{if(busy)throw Error('Wait for the current planner action.');await load({preserveDraft:true});const matches=tasks.filter(t=>t.id===taskId);if(matches.length!==1)throw Error('This task is missing or has a duplicate ID. Open its notes to repair it.');openEditor(matches[0]);}};
}
