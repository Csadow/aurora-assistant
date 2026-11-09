export function mountWeek(root,{api,openDay}){
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const localDay=()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};
  const duration=n=>`${Math.floor(n/60)}h ${n%60}m`;
  let chosen=localDay(),sequence=0,report;
  const heading=el('div',undefined,'week-heading'),title=el('h2','Your week'),nav=el('div',undefined,'week-nav');
  const date=el('input');date.type='date';date.value=chosen;date.setAttribute('aria-label','Week containing');
  const status=el('p','','panel-help');status.setAttribute('role','status');
  const warnings=el('div'),grid=el('div',undefined,'week-grid'),attention=el('details'),attentionBody=el('div');attention.append(el('summary','Tasks to revisit'),attentionBody);
  const button=(label,fn)=>{const b=el('button',label);b.type='button';b.onclick=()=>Promise.resolve().then(fn).catch(e=>status.textContent=e.message);return b;};
  const move=n=>{const d=new Date(chosen+'T12:00:00Z');if(!Number.isFinite(d.getTime()))throw Error('Choose a valid week date.');d.setUTCDate(d.getUTCDate()+n);chosen=d.toISOString().slice(0,10);date.value=chosen;return load();};
  nav.append(button('Previous week',()=>move(-7)),date,button('Next week',()=>move(7)),button('This week',()=>{chosen=localDay();date.value=chosen;return load();}));
  date.onchange=()=>{chosen=date.value;load();};heading.append(title,nav);root.replaceChildren(heading,status,warnings,grid,attention);
  function taskList(title,items,parent){if(!items.length)return;const box=el('details');box.append(el('summary',title+' · '+items.length));for(const t of items){const p=el('p',t.text);if(t.due)p.append(el('small',' · due '+t.due));if(t.planDate)p.append(el('small',' · planned '+t.planDate));box.append(p);}parent.append(box);}
  function render(r){
    status.textContent=`${r.start} – ${r.end} · ${r.timezone} · ${r.totals.classes} classes (${duration(r.totals.classMinutes)}) · ${duration(r.totals.taskMinutes)} task blocks · ${r.totals.completed} completed · ${r.totals.conflicts} overlaps`;
    warnings.replaceChildren(...r.warnings.map(text=>el('p',text,'week-warning')));grid.replaceChildren();
    for(const d of r.days){
      const card=el('article',undefined,'week-day');card.dataset.date=d.date;if(d.today)card.classList.add('is-today');
      card.append(el('h3',new Intl.DateTimeFormat(undefined,{weekday:'long',timeZone:'UTC'}).format(new Date(d.date+'T12:00:00Z'))),el('p',d.date,'panel-help'));
      card.append(button('Open '+d.date,()=>openDay(d.date)));
      card.append(el('p',d.occupiedMinutes===null?'Reserved time incomplete':duration(d.occupiedMinutes)+' reserved','week-total'));
      if(d.availability)card.append(el('p','Available: '+(d.availability.map(w=>w.join('–')).join(', ')||'Day off'),'panel-help'));
      for(const t of d.blocked||[])card.append(el('p','Waiting: '+t.text+' · '+t.reasons.join('; '),'week-warning'));
      if(d.unknown)card.append(el('p','Class times are incomplete.','week-warning'));
      if(!d.timetableActive&&r.timetableTimezone)card.append(el('p','Outside the saved trimester dates.','panel-help'));
      for(const b of d.blocks){const item=el('div',undefined,'week-block week-'+b.kind);item.append(el('small',b.time+' · '+b.kind),el('strong',b.title));if(b.location)item.append(el('small',b.location));card.append(item);}
      if(r.timezoneMismatch)for(const c of d.classes){const item=el('div',undefined,'week-block week-class');item.append(el('small',c.start+'–'+c.end+' · '+r.timetableTimezone),el('strong',c.title));card.append(item);}
      if(!d.blocks.length&&!d.classes.length)card.append(el('p','No saved time blocks.','panel-help'));
      for(const c of d.conflicts)card.append(el('p','Overlap: '+c.first.title+' / '+c.second.title,'week-warning'));
      taskList('Needs a time',d.untimed,card);taskList('Deadlines',d.due,card);taskList('Completed',d.completed,card);grid.append(card);
    }
    attentionBody.replaceChildren(el('p','These counts use today’s date, even when viewing another week.','panel-help'));
    taskList('Overdue',r.overdue,attentionBody);taskList('Missed planned tasks',r.missed,attentionBody);taskList('Not planned yet',r.backlog,attentionBody);
    if(!r.overdue.length&&!r.missed.length&&!r.backlog.length)attentionBody.append(el('p','Nothing waiting to be planned.','panel-help'));
  }
  async function load(){
    const request=++sequence;root.setAttribute('aria-busy','true');status.textContent='Loading your week…';grid.replaceChildren();warnings.replaceChildren();attentionBody.replaceChildren();
    try{const r=await api('/api/week?date='+encodeURIComponent(chosen)+'&timezone='+encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone));if(request!==sequence)return;report=r;render(r);}
    catch(e){if(request===sequence){report=null;status.textContent=e.message;}}
    finally{if(request===sequence)root.removeAttribute('aria-busy');}
  }
  return {load};
}
