const labels={blocked:'Blocked',continue:'Continue'};
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export function outcomeDraftError(d){
 if(!d)return null;
 const source=s=>s&&uuid(s.taskId)&&typeof s.revision==='string'&&typeof s.currentCard?.text==='string'&&Number.isSafeInteger(s.currentCard.sequence)&&Array.isArray(s.outcomes)&&s.outcomes.length&&s.outcomes.every(o=>o&&uuid(o.id)&&o.taskId===s.taskId&&Number.isSafeInteger(o.cardSequence)&&o.cardSequence>0&&Object.hasOwn(labels,o.kind)&&typeof o.note==='string'&&typeof o.context?.date==='string'&&typeof o.context.timezone==='string'&&typeof o.card?.text==='string'&&typeof o.card.context?.task?.text==='string')&&(s.project===null||s.project&&typeof s.project.title==='string'&&typeof s.project.excerpt==='string');
 if(d.rows.some(r=>!source(r.source)||r.source.taskId!==r.taskId)||d.pending&&(d.pending.outcomeMode!==true||!uuid(d.pending.requestId)||!Array.isArray(d.pending.selected)))return 'The saved unfinished-step sources cannot be read. Your draft has been kept; reset it explicitly to start again.';
 return null;
}
export function outcomeSourceHTML(s,escape,label='Recorded reasons for this selection'){
 if(!s)return '';
 return '<details class="outcome-source"><summary>'+escape(label)+'</summary><p>Self-reported observations retained from planning. They do not verify AI work or establish task completion.</p>'+'<p>Current step when compared: version '+s.currentCard.sequence+'</p><p class="summary-prose">'+escape(s.currentCard.text)+'</p>'+s.outcomes.map(o=>'<article><p><strong>'+escape(labels[o.kind]||o.kind)+'</strong> · '+escape(o.context.date)+' · '+escape(o.context.timezone)+' · Step '+o.cardSequence+'</p><p>Task then: '+escape(o.card.context.task.text)+'</p><p class="summary-prose">'+escape(o.card.text)+'</p><p class="summary-prose">'+escape(o.note)+'</p><button data-step-outcome="'+escape(o.taskId)+'" data-step-sequence="'+o.cardSequence+'">Review source outcome</button></article>').join('')+(s.project?'<p>Project: '+escape(s.project.title)+(s.project.missing?' · Unavailable':'')+'</p><p class="summary-prose">'+escape(s.project.excerpt)+'</p>':'')+'</details>';
}
export function outcomeSelectionHTML(row,saved,escape){
 return (row?outcomeSourceHTML(row.source,escape,'Current unresolved reports and project context'):'')+(saved.source&&saved.source.revision!==row?.source?.revision?'<div data-selection-source-comparison>'+outcomeSourceHTML(saved.source,escape,'Sources kept with your earlier selection')+'</div>':'');
}
