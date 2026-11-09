import {readTimetable,emptyTimetable,timetableMarkdown,TIMETABLE_PATH,weekdays} from './timetable.js';
export function mountPlanningSettings(root,{api,refresh}){
 const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const dialog=node('dialog'),heading=node('h2','Planning settings'),body=node('div'),message=node('p');dialog.id='planning-settings-dialog';dialog.setAttribute('aria-labelledby','planning-settings-title');heading.id='planning-settings-title';message.setAttribute('role','status');
 let busy=false,note=null,data,recurring;
 const run=fn=>async()=>{if(busy)return;busy=true;dialog.setAttribute('aria-busy','true');message.textContent='';try{await fn();}catch(e){message.textContent=e.message;}finally{busy=false;dialog.removeAttribute('aria-busy');}};
 const button=(text,fn)=>{const b=node('button',text);b.type='button';b.onclick=run(fn);return b;};
 const field=(parent,label,type,value='')=>{const l=node('label',label),i=node('input');i.type=type;i.value=value;i.setAttribute('aria-label',label);l.append(i);parent.append(l);return i;};
 const submit=(form,text,fn)=>{const b=node('button',text);b.type='submit';form.append(b);form.onsubmit=e=>{e.preventDefault();run(fn)();};};
 const section=(title,help)=>{const s=node('section');s.append(node('h3',title),node('p',help));body.append(s);return s;};
 const days=(parent,selected,prefix)=>weekdays.map((name,i)=>{const c=field(parent,prefix+' '+name,'checkbox');c.checked=selected.includes(i);return c;});
 async function load(){const notes=await api('/api/notes');note=notes.some(n=>n.path===TIMETABLE_PATH)?await api('/api/note?path='+encodeURIComponent(TIMETABLE_PATH)):null;data=note?readTimetable(note):emptyTimetable();recurring=await api('/api/recurring');render();}
 async function saved(){await load();await refresh();message.textContent='Saved.';}
 async function calendar(next){await api('/api/note',{path:TIMETABLE_PATH,revision:note?.revision??null,content:timetableMarkdown(next)});await saved();}
 async function change(input){await api('/api/recurring',{...input,revision:recurring.revision});await saved();}
 function render(){
  body.replaceChildren();
  const a=section('Weekly availability','Suggestions use these windows and avoid classes. Separate windows with commas, for example 09:00-12:00, 14:00-18:00, to reserve lunch or other breaks. Blank means a day off. Existing task blocks stay in place; hours use the timetable timezone: '+data.timezone+'.');
  const af=node('form'),enabled=field(af,'Use weekly availability','checkbox');enabled.checked=!!data.availability;
  const inputs=[];
  for(const i of [1,2,3,4,5,6,0]){inputs[i]=field(af,weekdays[i]+' windows','text',(data.availability?.days[i]||[]).map(w=>w.join('-')).join(', '));inputs[i].placeholder='Day off (leave blank)';}
  const gap=field(af,'Break between tasks (minutes)','number',data.availability?.gap??10);gap.min='0';gap.max='120';gap.required=true;
  submit(af,'Save availability',()=>calendar({...data,availability:enabled.checked?{gap:Number(gap.value),days:inputs.map(i=>i.value.trim()?i.value.split(',').map(v=>v.trim().split('-').map(t=>t.trim())):[])}:null}));a.append(af);
  const e=section('Class exceptions','Cancel or move one occurrence, or mark a date with no classes. A holiday removes all classes on that date, including moved sessions. Your weekly timetable remains unchanged.');
  for(const item of data.exceptions||[]){const row=node('p');row.append(node('span',item.date+' · '+(item.kind==='holiday'?'No classes':(data.classes.find(c=>c.id===item.classId)?.title||'Class')+' · '+item.kind)+(item.kind==='move'?' → '+item.targetDate+' '+item.start+'–'+item.end:'')+' '),button('Remove exception',()=>calendar({...data,exceptions:data.exceptions.filter(x=>x.id!==item.id)})));e.append(row);}
  const ef=node('form'),date=field(ef,'Original class date','date',recurring.today),kind=node('select');kind.setAttribute('aria-label','Exception type');
  for(const [v,t] of [['holiday','No classes on this date'],['cancel','Cancel one class'],['move','Move one class']]){const o=node('option',t);o.value=v;kind.append(o);}ef.append(kind);
  const cls=node('select');cls.setAttribute('aria-label','Exception class');for(const c of data.classes){const o=node('option',weekdays[c.day]+' '+c.start+' · '+c.title);o.value=c.id;cls.append(o);}ef.append(cls);
  const target=field(ef,'Replacement date','date',recurring.today),start=field(ef,'Replacement starts','time','09:00'),end=field(ef,'Replacement ends','time','09:50');date.required=true;
  const mode=()=>{cls.disabled=kind.value==='holiday';for(const i of [target,start,end]){i.disabled=kind.value!=='move';i.required=kind.value==='move';}};kind.onchange=mode;mode();
  submit(ef,'Save exception',()=>calendar({...data,exceptions:[...(data.exceptions||[]),{id:crypto.randomUUID(),date:date.value,kind:kind.value,classId:cls.value,targetDate:target.value,start:start.value,end:end.value}]}));e.append(ef);
  const r=section('Recurring tasks','Aurora prepares today and the next 13 days while running. Missed days are not backfilled. Occurrences are independent untimed tasks, ready for your planner. Pause and end affect future generation; already-created tasks remain. Skip removes one unfinished occurrence and prevents its return.');
  if(recurring.error)r.append(node('p','Generation paused after an error: '+recurring.error));
  for(const rule of recurring.rules){
   const row=node('article');row.className='recurring-rule';row.dataset.recurringId=rule.id;
   row.append(node('h4',rule.text),node('p',rule.days.map(d=>weekdays[d]).join(', ')+' · '+rule.duration+' min · '+rule.priority+' priority · '+rule.from+' to '+(rule.until||'no end date')+' · '+(rule.paused?'Paused':'Active')+' · '+rule.generated.length+' issued, '+rule.skipped.length+' skipped'));
   row.append(button(rule.paused?'Resume series':'Pause series',()=>change({operation:rule.paused?'resume':'pause',id:rule.id})));
   const until=field(row,'End date for '+rule.text,'date',rule.until||recurring.today);row.append(button('Set series end',()=>change({operation:'end',id:rule.id,until:until.value})));
   const skip=field(row,'Skip date for '+rule.text,'date',recurring.today);row.append(button('Skip occurrence',()=>change({operation:'skip',id:rule.id,date:skip.value})));r.append(row);
  }
  if(recurring.invalid){r.append(node('p','Repair '+recurring.path+' in Notes before editing recurring tasks.'));return;}
  const rf=node('form'),text=field(rf,'Recurring task title','text');text.required=true;text.maxLength=600;
  const from=field(rf,'Series starts','date',recurring.today),until=field(rf,'Series ends (optional)','date');from.required=true;
  const duration=field(rf,'Recurring duration (minutes)','number',30);duration.min='5';duration.max='720';duration.required=true;
  const checks=days(rf,[],'Repeat on'),priority=node('select');priority.setAttribute('aria-label','Recurring priority');for(const v of ['normal','high','low']){const o=node('option',v);o.value=v;priority.append(o);}rf.append(priority);
  submit(rf,'Create recurring task',()=>change({operation:'add',rule:{text:text.value,from:from.value,until:until.value||null,duration:Number(duration.value),priority:priority.value,days:checks.flatMap((c,i)=>c.checked?[i]:[])}}));r.append(rf);
 }
 dialog.append(heading,node('p','Changes save only when you use a Save or action button. Save one section at a time: each save reloads the settings. Close discards unfinished form edits.'),button('Close settings',()=>dialog.close()),message,body);document.body.append(dialog);
 dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 const open=button('Planning settings',async()=>{body.replaceChildren();dialog.showModal();await load();});open.id='day-planning-settings';root.append(open);
 return {open:()=>open.click()};
}
