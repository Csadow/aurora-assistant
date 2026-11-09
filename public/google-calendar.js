export function mountGoogleCalendar(root,{api,refresh}){
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const launch=el('button','Google Calendar');launch.id='day-google-calendar';launch.type='button';root.append(launch);
 const summary=el('p','','calendar-sync-summary');summary.id='day-calendar-status';summary.setAttribute('role','status');root.after(summary);
 const dialog=el('dialog',undefined,'google-calendar-dialog');dialog.id='google-calendar-dialog';dialog.setAttribute('aria-label','Google Calendar sync');
 const heading=el('h2','Google Calendar'),status=el('p','','panel-help'),body=el('div'),review=el('section',undefined,'calendar-review'),close=el('button','Close calendar');status.setAttribute('role','status');close.type='button';close.onclick=()=>dialog.close();dialog.append(heading,status,body,review,close);document.body.append(dialog);
 let busy=false,state,selection=new Map(),currentReview=null,loadVersion=0,checkVersion=0;
 const notice=el('p','','week-warning');dialog.insertBefore(notice,body);
 dialog.addEventListener('close',()=>{if(!dialog.open)loadVersion++;});
 const run=fn=>async()=>{if(busy)return;busy=true;dialog.setAttribute('aria-busy','true');try{await fn();}catch(e){status.textContent=e.message;}finally{busy=false;dialog.removeAttribute('aria-busy');}};
 const button=(title,fn)=>{const b=el('button',title);b.type='button';b.onclick=run(fn);return b;};
 const label=(text,input)=>{const n=el('label',text);n.append(input);return n;};
 const link=(text,url)=>{const a=el('a',text);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;};
 const format=s=>s?`${s.title} · ${s.date} · ${s.time?s.time+' / '+s.duration+' min':'all day'}`:'No calendar block';
 const time=e=>e.start.date||new Date(e.start.dateTime).toLocaleString([],{dateStyle:'medium',timeStyle:'short'});
 function showSummary(s){
  const c=s.counts,r=s.review;
  launch.textContent='Google Calendar'+(s.connected?(r?.interrupted?' · interrupted':c.pending?' · '+c.pending+' pending':r?.remaining?' · '+r.remaining+' in review':!s.fresh?' · refresh needed':c.blocked?' · blocked':c.unknown?' · check links':''):'');
  const parts=!s.connected?['Connect Google Calendar to include busy time in your day plan.']:[
   s.fresh?'Calendar checked '+new Date(s.lastChecked).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'Calendar needs refresh; sync status may be out of date.',
   c.pending+' pending change'+(c.pending===1?'':'s'),c.conflict?c.conflict+' conflict'+(c.conflict===1?'':'s'):'',
   c.blocked?c.blocked+' blocked':'',c.unknown?c.unknown+' need checking':'',
   r?.remaining?r.remaining+' saved review item'+(r.remaining===1?'':'s')+(r.interrupted?' · interrupted':r.expired?' · expired':''):''];
  summary.textContent=parts.filter(Boolean).join(' · ');summary.dataset.fresh=String(s.fresh);
  if(dialog.open)notice.textContent=(currentReview?.id||null)!==(r?.id||null)?'The saved review changed. Close and reopen this panel to load it; your current choices have been kept.':'';
 }
 async function check(){const version=++checkVersion,s=await api('/api/calendar/summary');if(version===checkVersion)showSummary(s);return s;}
 function renderReview(r){
  if(!dialog.open)return;
  currentReview=r;selection=new Map();review.replaceChildren();if(!r)return;
  review.append(el('h3','Review sync changes'),el('p','Changes apply only after you choose Apply reviewed changes. Google deletions clear the planned block and keep the to-do. Completion, deadlines, reminders and task dependencies stay in Aurora.','panel-help'));
  for(const w of r.warnings||[])review.append(el('p',w,'week-warning'));
  if(!r.items.length)review.append(el('p',r.warnings?.length?'No changes can be applied from this review. Check the warnings above.':'No sync changes found for the reviewed selection.'));
  if(Date.now()-r.created>900000)review.append(el('p','This review has expired. Discard it and preview again before making new changes. Interrupted writes can still be checked for completed effects.','week-warning'));
  for(const i of r.items){
   const card=el('article',undefined,'calendar-change');card.dataset.calendarChange=i.key;card.append(el('h4',i.title),el('p','Aurora: '+format(i.local)),el('p','Google: '+format(i.google)));
   if(i.done){card.append(el('strong','Applied'));review.append(card);continue;}
   const choose=el('select');choose.setAttribute('aria-label','Sync choice for '+i.title);choose.append(new Option('Skip this change','skip'));
   for(const d of i.allowed){const text=d==='aurora'?(i.local?'Use Aurora → Google':'Delete Google block'):(i.google?'Use Google → Aurora':'Remove Aurora block (keep task)');choose.append(new Option(text,d));}
   if(i.kind==='conflict')card.append(el('p','Both copies changed. Choose which version to keep.','week-warning'));
   if(i.uncertain){card.append(el('p','An earlier attempt was interrupted. Retry the same direction to check what finished.','week-warning'));}
   if(i.error)card.append(el('p',i.error,'week-warning'));
   choose.onchange=()=>selection.set(i.key,choose.value);card.append(choose);review.append(card);
  }
  review.append(button('Apply reviewed changes',async()=>{
   const choices=[...selection].filter(([,d])=>d!=='skip').map(([key,direction])=>({key,direction}));if(!choices.length)throw Error('Choose at least one change to apply.');
   try{await api('/api/calendar/apply',{id:r.id,choices});await load();await refresh();status.textContent='Reviewed changes applied.';}
   catch(e){const current=await api('/api/calendar');renderReview(current.review);throw e;}
  }),button('Discard review',async()=>{await api('/api/calendar/discard',{id:r.id});await load();}));
  if(r.items.some(i=>i.uncertain))review.append(button('End interrupted review',async()=>{if(!confirm('End this review without undoing any saved changes? Aurora will keep a local record and compare both sides again in the next review.'))return;await api('/api/calendar/discard',{id:r.id,acknowledgeUncertain:true});await load();await refresh();}));
 }
 async function load(){const version=++loadVersion,syncVersion=++checkVersion;const next=await api('/api/calendar');if(version!==loadVersion)return;state=next;if(syncVersion===checkVersion)showSummary(state.sync);if(dialog.open){notice.textContent='';render();}}
 function render(){
  body.replaceChildren();status.textContent=state.error||(state.connected?`Connected · ${state.account||'choose Refresh connection'} · ${state.timezone}`:state.connecting?'Waiting for Google sign-in in your browser.':'Google Calendar is not connected.');
  body.append(el('p','Read selected calendars in your planner and morning briefing. Link selected personal events and tasks for two-way title, time and block-deletion sync. Refresh runs every five minutes while Aurora’s service is running; writes always use this review.','panel-help'));
  if(!state.configured){
   const setup=el('details');setup.open=true;setup.append(el('summary','One-time Google setup'));
   const steps=el('ol');for(const text of ['Create or choose a Google Cloud project and enable Google Calendar API.','Configure OAuth consent for your own account. If the app is in Testing, add yourself as a test user.','Create an OAuth client with application type Desktop app and download its JSON file.','Choose that JSON file below, then sign in through your system browser.'])steps.append(el('li',text));
   const file=el('input');file.type='file';file.accept='.json,application/json';file.setAttribute('aria-label','Google Desktop client JSON');
   setup.append(steps,link('Google Calendar setup guide','https://developers.google.com/workspace/calendar/api/quickstart/nodejs'),file,button('Save desktop client',async()=>{if(!file.files[0])throw Error('Choose the downloaded Desktop app client JSON.');if(file.files[0].size>64000)throw Error('Choose a client JSON file smaller than 64 KB.');let client;try{client=JSON.parse(await file.files[0].text());}catch{throw Error('This file is not valid JSON.');}await api('/api/calendar/configure',{client});file.value='';await load();}));body.append(setup);
  }
  if(state.configured&&!state.connected)body.append(button('Connect Google Calendar',async()=>{const r=await api('/api/calendar/connect',{});await load();const a=link('Continue Google sign-in in your browser',r.url);body.prepend(a);a.click();}));
  body.append(button('Refresh connection',async()=>{if((await api('/api/calendar')).connected)await api('/api/calendar/refresh',{});await load();await refresh();}));
  if(state.connected){
   body.append(button('Reconnect Google',async()=>{const r=await api('/api/calendar/connect',{});const a=link('Continue Google sign-in in your browser',r.url);body.prepend(a);a.click();status.textContent='Sign in with the same account to preserve linked tasks.';}));
   body.append(el('p',state.lastSync?`Last downloaded: ${new Date(state.lastSync).toLocaleString()} · ${state.range.from} to ${state.range.to} (end exclusive)`:'No calendar events downloaded yet.','panel-help'));
   const settings=el('details'),choices=el('div',undefined,'calendar-options'),target=el('select');target.setAttribute('aria-label','Google destination calendar');settings.append(el('summary','Calendars to show and sync'));
   const checked=[];for(const c of state.calendars){const box=el('input');box.type='checkbox';box.checked=state.selected.includes(c.id);box.value=c.id;box.setAttribute('aria-label','Show calendar '+c.title);checked.push(box);choices.append(label(c.title,box));if(['owner','writer'].includes(c.accessRole))target.append(new Option(c.title,c.id));}target.value=state.target||'';
   settings.append(choices,label('New task destination',target),button('Save calendar selection',async()=>{await api('/api/calendar/select',{selected:checked.filter(b=>b.checked).map(b=>b.value),target:target.value});await load();await refresh();}));body.append(settings);
   const tasks=el('details'),taskBoxes=[];tasks.append(el('summary','Send scheduled tasks to Google · '+state.tasks.length));
   for(const t of state.tasks){const box=el('input');box.type='checkbox';box.value=t.id;box.setAttribute('aria-label','Link task '+t.text);taskBoxes.push(box);tasks.append(label(`${t.text} · ${t.planDate}${t.startTime?' '+t.startTime:' · all day'}`,box));}body.append(tasks);
   const events=el('details'),eventBoxes=[];events.append(el('summary','Google events · '+state.events.length));
   for(const e of state.events){const row=el('div',undefined,'calendar-event');row.append(el('span',time(e)+' · '+e.title));if(e.linked)row.append(el('small','Linked to Aurora'));else if(e.readOnly)row.append(el('small',e.readOnly));else{const box=el('input');box.type='checkbox';box.setAttribute('aria-label','Import event '+e.title);eventBoxes.push({box,event:{calendarId:e.calendarId,id:e.id}});row.append(label('Link as an Aurora task',box));}events.append(row);}body.append(events);
   body.append(button('Preview two-way sync',async()=>{renderReview(await api('/api/calendar/preview',{taskIds:taskBoxes.filter(b=>b.checked).map(b=>b.value),eventRefs:eventBoxes.filter(x=>x.box.checked).map(x=>x.event)}));status.textContent='Review prepared. Choose the changes to apply.';review.scrollIntoView({block:'start'});}));
   const links=el('details');links.append(el('summary','Linked tasks · '+state.links.length));for(const l of state.links){const row=el('div',undefined,'calendar-event'),sync=state.sync.links.find(s=>s.taskId===l.taskId);row.append(el('span',l.title),el('small',(state.sync.fresh?'':'Last downloaded status: ')+(sync?.detail||'Refresh to check this pair.')),button('Unlink '+l.title,async()=>{await api('/api/calendar/unlink',{taskId:l.taskId});await load();await refresh();}));links.append(row);}links.append(el('p','Unlinking leaves both copies in place and stops future sync for that pair.','panel-help'));body.append(links);
  }
  if(state.connected||state.connecting)body.append(button('Disconnect Google',async()=>{if(!confirm('Disconnect Google Calendar and forget local links? Your Google events and Aurora tasks will remain. You can revoke the Google grant from your Google Account.'))return;await api('/api/calendar/disconnect',{});await load();await refresh();}));
  renderReview(state.review);
 }
 launch.onclick=run(async()=>{dialog.showModal();await load();});
 const openTask=task=>run(async()=>{
  dialog.showModal();await load();if(!dialog.open)return;
  if(!state.connected){status.textContent='Connect Google Calendar before linking a planner task.';return;}
  if(state.review?.items.some(i=>!i.done)){status.textContent='Your saved review is still open. Finish or discard it, then open this task again.';review.scrollIntoView({block:'start'});return;}
  const r=await api('/api/calendar/preview',{focusTask:task,reviewId:state.review?.id||null});
  if(!dialog.open)return;renderReview(r);status.textContent='Review for this task only. Choose a direction to apply its change.';await check();review.scrollIntoView({block:'start'});
 })();
 return {load,check,openTask};
}
