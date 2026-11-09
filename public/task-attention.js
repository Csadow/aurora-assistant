export function taskAttentionPanel(items){
 const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const panel=node('section');panel.className='planner-attention';panel.setAttribute('aria-label','Planner tasks needing your attention');
 const waiting=items.filter(i=>i.attention);panel.append(node('h2','Needs your attention · '+waiting.length));
 if(!waiting.length){panel.append(node('p','No linked planner tasks need a decision right now.'));return panel;}
 panel.append(node('p','Open an item to review its current state. Work starts only through the existing workflow controls.'));
 for(const i of waiting.slice(0,40)){const a=i.attention,row=node('article');row.className='action-card';row.dataset.attentionItem=i.id;
  const title=node('button',i.text);title.type='button';title.className='planner-attention-title';title.dataset.plannerLink=i.id;title.setAttribute('aria-label','Open task execution: '+i.text);
  row.append(title,node('p',a.detail),node('small',(i.workflowId?'Attempt '+i.attempt+' of '+i.attemptCount+' · ':'')+i.path));
  const button=node('button',a.label);button.type='button';button.dataset.plannerAttention=i.id;row.append(button);panel.append(row);
 }
 if(waiting.length>40)panel.append(node('p','Showing 40 items. Other links remain available beside their planner tasks.'));
 return panel;
}
