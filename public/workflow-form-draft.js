const key='aurora-workflow-form-draft';

export function workflowFormDraft({form,compose,read,apply,hasContent}){
  const status=document.querySelector('#workflow-draft-status');
  const controls=document.querySelector('#workflow-draft-controls');
  const reload=document.querySelector('#workflow-draft-reload');
  const discard=document.querySelector('#workflow-draft-discard');
  const useCurrent=document.querySelector('#workflow-draft-use-current');
  let expected=null,ready=false,restoring=false,blocked=false;

  function show(message,{recovery=false,saved=false}={}){
    status.hidden=!message;
    status.textContent=message;
    status.classList.toggle('error',recovery);
    controls.hidden=!recovery&&!saved;
    useCurrent.hidden=!recovery;
  }
  function stored(){return localStorage.getItem(key);}
  function save(){
    if(!ready||restoring||blocked)return false;
    try{
      const current=stored();
      if(current!==expected){blocked=true;show('This draft changed in another window. Your current form is still here. Reload the saved draft or explicitly keep this form.',{recovery:true});return false;}
      const data=read();
      if(hasContent(data)){
        const encoded=JSON.stringify({version:1,data});
        localStorage.setItem(key,encoded);expected=encoded;
        show('Draft saved on this desktop.',{saved:true});
      }else{
        localStorage.removeItem(key);expected=null;show('');
      }
      return true;
    }catch{
      show('Local draft storage is unavailable. Keep this window open until it recovers.',{recovery:true});
      return false;
    }
  }
  async function restore({manual=false}={}){
    if(manual&&!confirm('Replace the current form with the saved local draft?'))return;
    restoring=true;form.inert=true;
    try{
      const raw=stored();expected=raw;
      if(!raw){blocked=false;show('');return;}
      if(raw.length>200000)throw Error('Oversized workflow draft');
      const record=JSON.parse(raw);
      if(record?.version!==1||!record.data||typeof record.data!=='object'||Array.isArray(record.data))throw Error('Unreadable workflow draft');
      const warnings=await apply(record.data);
      compose.open=true;blocked=!!warnings.length;
      show(blocked?'Some saved selections are unavailable: '+warnings.join(', ')+'. Review the current form before replacing the saved draft.':'Unfinished workflow setup recovered on this desktop.',{recovery:blocked,saved:!blocked});
    }catch{
      blocked=true;compose.open=true;
      show('The saved workflow draft could not be read. Its original local record is retained. Reload it or explicitly replace it with this form.',{recovery:true});
    }finally{restoring=false;ready=true;form.inert=false;}
  }
  function beforeSubmit(){if(blocked)throw Error('Resolve the saved workflow draft before starting a new task.');}
  function clearAfterStart(){
    try{
      if(stored()===expected){localStorage.removeItem(key);expected=null;blocked=false;show('');return true;}
      blocked=true;show('Another window changed its workflow draft. The other draft was kept.',{recovery:true});return false;
    }catch{show('The new task was saved, but local draft storage could not be cleared. Review it on the next opening.',{recovery:true});return false;}
  }
  for(const event of ['input','change'])form.addEventListener(event,save);
  window.addEventListener('storage',event=>{if(event.key===key&&ready&&event.newValue!==expected){blocked=true;show('This draft changed in another window. Your current form is still here. Reload the saved draft or explicitly keep this form.',{recovery:true});}});
  reload.onclick=()=>{restore({manual:true}).catch(()=>{});};
  discard.onclick=()=>{
    if(!confirm('Discard this saved new-workflow draft? Saved tasks and reviews stay unchanged.'))return;
    try{if(stored()!==expected){blocked=true;show('The saved draft changed in another window. Reload before discarding it.',{recovery:true});return;}localStorage.removeItem(key);expected=null;blocked=false;show('');}catch{show('Local draft storage is unavailable. The saved draft was not cleared.',{recovery:true});}
  };
  useCurrent.onclick=()=>{
    if(!confirm('Replace the saved draft with the values currently visible in this form? Unavailable selections will be left out.'))return;
    try{expected=stored();blocked=false;save();}catch{show('Local draft storage is unavailable. The saved draft was not replaced.',{recovery:true});}
  };
  return {restore,save,beforeSubmit,clearAfterStart};
}
