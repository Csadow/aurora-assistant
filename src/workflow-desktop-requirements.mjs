import {beforeCheckpoint} from './workflow-checkpoint.mjs';
import {AppError} from './vault.mjs';

const object=(v,allowed)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>allowed.includes(k));
const literal=(s,max=500)=>typeof s==='string'&&!!s.trim()&&s.length<=max&&!/[\x00-\x1f\x7f]/.test(s);

// Explicit form values only. A tool result, skill or model verification phrase
// cannot replace these conditions. Omit absent fields for old task compatibility.
export function prepareDesktopRequirements(input){
  const result={};
  if(Object.hasOwn(input,'browser')){
    const b=input.browser;
    if(!object(b,['url','title'])||!literal(b.url,2000)||b.url!==b.url.trim()||Object.hasOwn(b,'title')&&!literal(b.title))throw new AppError('Browser requirements need an HTTP(S) URL and, optionally, an exact title of 1–500 characters.');
    let url;try{url=new URL(b.url);}catch{throw new AppError('Enter a complete HTTP(S) page URL.');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new AppError('Use an HTTP(S) page URL without embedded credentials.');
    result.browser={url:url.href,...Object.hasOwn(b,'title')?{title:b.title}:{}};
  }
  if(Object.hasOwn(input,'window')){
    const v=input.window;
    if(!object(v,['title','app'])||!literal(v.title)||Object.hasOwn(v,'app')&&!literal(v.app,200))throw new AppError('Window requirements need an exact title of 1–500 characters and an optional exact app identifier of 1–200 characters.');
    result.window={title:v.title,...Object.hasOwn(v,'app')?{app:v.app}:{}};
  }
  return result;
}

const successful=o=>o.status==='completed'&&!o.result?.error;
const observation=(o,kind)=>o.name==='computer_action'&&(kind==='browser'?['open_url','web_search','browser_read'].includes(o.arguments?.operation):o.arguments?.operation==='windows');
// Commands, file edits and native input may change either surface. Failed/interrupted
// executed actions count too: an absent acknowledgement is not proof of no effect.
const changesSurface=o=>o.status!=='superseded'&&(successful(o)||o.action&&['failed','interrupted'].includes(o.status))&&
  (['propose_command','propose_file_edit'].includes(o.name)||o.name==='computer_action'&&!['windows','browser_read'].includes(o.arguments?.operation));

export function desktopRequirementStatus(w){
  const checks=[];
  for(const kind of ['browser','window']){
    const rule=w.requirements?.[kind];if(!rule)continue;
    const ops=w.operations,index=ops.findLastIndex(o=>observation(o,kind)),op=ops[index],r=op?.result;
    const collect=kind==='browser'?'Read the current page in Aurora Browser.':'List current desktop windows.';
    let detail;
    if(!op||!successful(op))detail=collect;
    else if(beforeCheckpoint(w,op))detail='This observation predates the task interruption. '+collect;
    else if(ops.slice(index+1).some(changesSurface))detail='A later action may have changed this result. '+collect;
    else if(kind==='browser'){
      if(typeof r?.url!=='string'||typeof r.text!=='string')detail=collect;
      else if(r.url!==rule.url)detail='The observed page URL does not match the saved exact URL. If the goal requests navigation, open that page through normal controls and read it. A redirect needs a reviewed requirement change, not a weaker verification phrase.';
      else if(Object.hasOwn(rule,'title')&&r.title!==rule.title)detail='The observed page title does not match the saved exact title. '+collect;
    }else if(!Array.isArray(r?.windows))detail=collect;
    else if(!r.windows.some(x=>typeof x.id==='string'&&x.id&&x.title===rule.title&&(!Object.hasOwn(rule,'app')||x.app===rule.app)))detail='No single observed window matches the saved exact title'+(rule.app?' and app identifier':'')+'. This condition is still required. An absent window does not prove an app limitation. If the goal asks to open a file/app and that launch has not happened, open it through normal controls, then list windows. If an earlier launch is uncertain, ask for help instead of repeating it. Do not claim completion or relax the requirement.';
    checks.push({kind,...rule,passed:!detail,detail:detail||(kind==='browser'?'Fresh page snapshot matches the saved URL and any required title.':'Fresh window list contains the saved title and any required app identifier. This does not prove the document contents.'),...!detail?{evidence:op.id}:{}});
  }
  return checks;
}
