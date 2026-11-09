import {plannerEditorDrafts} from './planner-editor-drafts.js';
import {mountTaskList} from './task-list.js';
import {mountContinueDay} from './continue-day.js';
import {taskWorkflowsUI} from './task-workflows.js';
import {mountGoogleCalendar} from './google-calendar.js';
import {mountTaskProjects} from './task-projects.js';
import {mountPlanningSettings} from './planning-settings.js';
import {mountWeek} from './weekly-planner.js';
import {TIMETABLE_PATH} from './timetable.js';
import {mountPlanner} from './planner.js';
import {currentTask} from './planner-core.js';
export function planning({api,escape,toast,state,refresh,setView,send,openWorkflow,prepareFollowup,editRequirements,serializeRequirements,navigateDay,openCapture}){
  const $=s=>document.querySelector(s);let selected,overview,taskList,reminderEpoch=0,reminderSaving=0;
  const continueDay=mountContinueDay($('#continue-day-workspace'),{api,escape,navigate:async route=>{planner.flushEditor();return route.type==='task-capture'?openCapture({onReturn:returnToContinue}):route.type==='task-schedule'?openTaskSchedule(route.taskId):navigateDay(route);}});
  async function returnToContinue(){planner.flushEditor();await setView('overview');if(!continueDay.restoreReturn()){$('#continue-day-title').focus({preventScroll:true});$('#continue-day-workspace').scrollIntoView({block:'start'});}}
  const safe=fn=>async e=>{try{await fn(e);}catch(e){toast(e.message);}};
  const time=value=>new Date(value).toLocaleString([],{dateStyle:'medium',timeStyle:'short'});
  const localInput=value=>{if(!value)return '';const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
  const readTime=id=>$(id).value?new Date($(id).value).toISOString():null;
  const row=t=>`<div class="task-row"><input type="checkbox" aria-label="Complete ${escape(t.text)}" data-overview-task="${escape(t.path)}" data-line="${t.line}" data-revision="${t.revision}"><div><span class="task-text">${escape(t.text)}</span><small>${escape(t.due?'Due '+t.due:'No deadline')}${t.remindAt?' · Reminder '+escape(time(t.remindAt)):''}</small></div>${t.id?'<button data-open-task-detail="'+escape(t.id)+'">Task details</button>':''}<button data-task-schedule="${escape(t.path)}" data-line="${t.line}">Schedule</button></div>`;
  function group(title,tasks,key,open=false){
    const content=`${tasks.length?tasks.slice(0,40).map(row).join(''):'<p class="panel-help">Nothing here.</p>'}${tasks.length>40?'<p class="panel-help">More tasks are available in Tasks.</p>':''}`;
    return key?`<details class="day-section day-task-group" data-day-group="${key}" ${open?'open':''}><summary>${title}<small>${tasks.length}</small></summary>${content}</details>`:`<section class="day-section"><h2>${title}<small>${tasks.length}</small></h2>${content}</section>`;
  }
  const google=mountGoogleCalendar($('#day-refresh').parentElement,{api,refresh:load});
  const execution=taskWorkflowsUI({host:$('#day-stats'),api,escape,toast,refresh,openWorkflow,prepareFollowup,editRequirements,serializeRequirements});
  const projects=mountTaskProjects($('#day-refresh').parentElement,{api,refresh:load});
  const planner=mountPlanner($('#daily-planner'),{
    returnToWorkspace:returnToContinue,
    editorDrafts:plannerEditorDrafts({vault:()=>state.bootstrap?.vault}),
    description:'',collapseOptions:true,
    list:()=>api('/api/tasks'),
    mountList:options=>(taskList=mountTaskList({...options,vault:()=>state.bootstrap?.vault,notes:()=>state.notes})),
    calendar:(date,fresh=false)=>api('/api/calendar/day'+(fresh?'':'?date='+encodeURIComponent(date)),fresh?{date}:undefined),
    calendarSync:()=>google.check(),
    reviewCalendar:t=>google.openTask(t),
    execution:t=>execution.openTask(t),
    details:t=>navigateDay({type:'task-detail',taskId:t.id}),
    timetable:async()=>{const notes=await api('/api/notes');return notes.some(n=>n.path===TIMETABLE_PATH)?api('/api/note?path='+encodeURIComponent(TIMETABLE_PATH)):null;},
    saveTimetable:async(content,revision)=>{await api('/api/note',{path:TIMETABLE_PATH,content,revision});await week.load();},
    add:async text=>{await api('/api/tasks',{text});await refresh();},
    connections:t=>projects.open(t),
    update:async(expected,changes,options={})=>{
      const t=currentTask(await api('/api/tasks'),expected);
      if('done' in changes)await api('/api/task-toggle',{...t,done:changes.done});
      else await api('/api/task-schedule',{...t,...changes,...options});
      await refresh();
    }
  });
  function plannerView(view){
    $('#weekly-planner').hidden=view!=='week';$('#daily-planner').hidden=view==='week';$('#day-tasks').hidden=view==='week';
    $('#show-day').setAttribute('aria-pressed',String(view==='day'));$('#show-week').setAttribute('aria-pressed',String(view==='week'));
  }
  mountPlanningSettings($('#day-refresh').parentElement,{api,refresh:load});
  $('#show-day').onclick=()=>plannerView('day');$('#show-week').onclick=()=>plannerView('week');
  async function openTaskSchedule(id){planner.flushEditor();await setView('overview');plannerView('day');await planner.editTask(id);}
  async function openTaskList(){await setView('overview');plannerView('day');taskList.reopen();}
  const findTask=document.createElement('button');findTask.id='day-task-list';findTask.textContent='Find a task';$('#show-week').after(findTask);findTask.onclick=safe(openTaskList);
  const week=mountWeek($('#weekly-planner'),{api,openDay:date=>{
    const root=$('#daily-planner');if(root.hasAttribute('aria-busy'))throw Error('Wait for the current planner save to finish.');
    plannerView('day');
    const input=root.querySelector('[aria-label="Plan date"]');input.value=date;input.dispatchEvent(new Event('change',{bubbles:true}));
    root.querySelector('.planner-options').open=true;root.scrollIntoView({behavior:'smooth',block:'start'});input.focus({preventScroll:true});
  }});
  async function load(){
    const reminderAtStart=reminderEpoch;
    await Promise.all([planner.load({preserveDraft:true}),week.load(),execution.load(),...(state.view==='overview'?[continueDay.load()]:[])]);
    overview=await api('/api/overview');const c=overview.counts;
    $('#day-summary').textContent=`${overview.date} · ${c.overdue} overdue · ${c.dueToday} for today · ${c.open} open tasks`;
    $('#day-date').textContent=overview.date+' · '+overview.timezone;
    const stats=$('#day-stats');stats.hidden=!c.overdue&&!c.dueToday;
    stats.innerHTML=(c.overdue?`<span><strong>${c.overdue}</strong> overdue</span>`:'')+(c.dueToday?`<span><strong>${c.dueToday}</strong> for today</span>`:'');
    $('#day-task-summary').textContent=`Tasks by date · ${overview.overdue.length} overdue · ${overview.today.length} today`;
    const expanded=new Set([...$('#day-tasks').querySelectorAll('[data-day-group][open]')].map(el=>el.dataset.dayGroup));
    $('#day-tasks').innerHTML=group('Overdue',overview.overdue)+group('Today',overview.today)+group('Coming up',overview.upcoming,'upcoming',expanded.has('upcoming'))+group('Without a date',overview.unscheduled,'unscheduled',expanded.has('unscheduled'));
    const cards=notes=>notes.map(n=>`<button class="day-note" data-note="${escape(n.path)}"><strong>${escape(n.title)}</strong><span>${escape(n.excerpt)}</span></button>`).join('')||'<p class="panel-help">Add a note to this folder when you are ready.</p>';
    $('#day-projects').innerHTML=cards(overview.projects);$('#day-profile').innerHTML=cards(overview.profile);if(!reminderSaving&&reminderAtStart===reminderEpoch)$('#reminders-enabled').checked=overview.remindersEnabled;
    $('#day-warning').textContent=overview.invalidSchedules?`${overview.invalidSchedules} task(s) have invalid reminder metadata. Open their Markdown notes to repair it.`:'';
    return overview;
  }
  function find(path,line){return state.tasks.find(t=>t.path===path&&t.line===Number(line));}
  document.addEventListener('click',safe(async event=>{const button=event.target.closest('[data-task-schedule]');if(!button)return;selected=find(button.dataset.taskSchedule,button.dataset.line);if(!selected){await refresh();toast('The task changed. Open its schedule again.');return;}$('#schedule-title').textContent=selected.text;$('#schedule-due').value=selected.due||'';$('#schedule-remind').value=localInput(selected.remindAt);$('#schedule-error').textContent='';$('#schedule-zone').textContent='Reminder time: '+Intl.DateTimeFormat().resolvedOptions().timeZone;$('#schedule-dialog').showModal();}));
  $('#schedule-close').onclick=()=>$('#schedule-dialog').close();$('#schedule-clear').onclick=()=>{$('#schedule-due').value='';$('#schedule-remind').value='';};
  $('#schedule-snooze').onclick=()=>$('#schedule-remind').value=localInput(Date.now()+15*60000);
  $('#schedule-form').onsubmit=async event=>{event.preventDefault();$('#schedule-save').disabled=true;try{await api('/api/task-schedule',{path:selected.path,line:selected.line,revision:selected.revision,due:$('#schedule-due').value||null,remindAt:readTime('#schedule-remind')});$('#schedule-dialog').close();await refresh();toast('Task schedule saved.');}catch(e){$('#schedule-error').textContent=e.message;}finally{$('#schedule-save').disabled=false;}};
  $('#day-tasks').onchange=safe(async event=>{const el=event.target;if(!el.dataset.overviewTask)return;el.disabled=true;try{await api('/api/task-toggle',{path:el.dataset.overviewTask,line:Number(el.dataset.line),revision:el.dataset.revision,done:el.checked});}finally{await refresh();}});
  $('#reminders-enabled').onchange=safe(async e=>{const enabled=e.target.checked;reminderEpoch++;reminderSaving++;try{await api('/api/settings',{remindersEnabled:enabled});toast(enabled?'Desktop reminders enabled.':'Desktop reminders paused.');}finally{reminderEpoch++;reminderSaving--;}});
  $('#day-refresh').onclick=safe(load);$('#day-plan').onclick=safe(async()=>{await setView('chat');$('#mode').value='plan';await send('Help me make a realistic plan for today using my overdue tasks, due dates, and project notes. Suggest up to three priorities and one manageable first step. Ask about my available time if needed.');});
  $('#day-journal').onclick=()=>$('#today').click();
  $('#task-timezone').textContent='Reminder times use '+Intl.DateTimeFormat().resolvedOptions().timeZone+'.';
  return {load,restoreContinue:()=>continueDay.restoreReturn(),unavailable:error=>taskList?.unavailable(error),openTaskList,flushEditor:()=>planner.flushEditor(),openTaskSchedule,openExecution:execution.openLink,openAttention:execution.openAttention,newSchedule:()=>({due:$('#task-due').value||null,remindAt:readTime('#task-remind')}),clearNew:()=>{$('#task-due').value='';$('#task-remind').value='';},label:t=>`${t.planDate?'Planned '+t.planDate+(t.startTime?' at '+t.startTime:'')+' · '+t.duration+' min · ':''}${t.due?'Due '+t.due:''}${t.remindAt?' · Reminder '+time(t.remindAt):''}${t.scheduleError?' · Invalid schedule':''}`};
}
