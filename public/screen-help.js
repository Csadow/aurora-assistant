import {renderMarkdown} from './markdown.js';
export function screenHelp({bridge,onBusy,onIdle}){
  const $=s=>document.querySelector(s);let frame,live=false,busy=false,changing=false,controller,timer,lastDigest,lastQuestion,epoch=0,access={active:false,persistent:false,resumeOnStart:false};
  const note=text=>$('#screen-status').textContent=text;
  const description=()=>!access.active?'Screen access off · local only · no screenshots saved':`● ${access.scope==='desktop'?'Entire desktop':'Selected region'} · ${access.persistent?'until you turn it off':'expires in 5 minutes'} · local only`;
  function controls(){
    $('#screen-access-state').textContent=access.active?(access.scope==='desktop'?'DESKTOP ACCESS ON':'REGION ACCESS ON'):'ACCESS OFF';
    $('#screen-ask').disabled=!access.active||busy||changing;$('#screen-live').disabled=!access.active||changing;
    for(const id of ['#screen-select','#screen-desktop','#screen-persistent'])$(id).disabled=busy||changing;
    $('#screen-resume').disabled=busy||changing||!access.persistent;$('#screen-stop').hidden=!access.active;
    $('#screen-live').textContent=live?'Pause live guide':'Start live guide';
  }
  function cancel(){epoch++;live=false;clearTimeout(timer);controller?.abort();frame=null;lastDigest=null;$('#screen-preview').removeAttribute('src');$('#screen-preview').hidden=true;$('#screen-result').replaceChildren();controls();}
  function update(status){const changed=access.scope!==status.scope||access.region!==status.region;access=status;if(!status.active||changed)cancel();$('#screen-persistent').checked=status.persistent;$('#screen-resume').checked=status.resumeOnStart;controls();if(!busy&&!live)note(description());}
  async function stop(){cancel();try{update(await bridge.screen('stop'));}catch(e){note(e.message);}}
  async function configure(){if(busy||changing)return;changing=true;controls();try{update(await bridge.screen('configure',{persistent:$('#screen-persistent').checked,resumeOnStart:$('#screen-persistent').checked&&$('#screen-resume').checked}));}catch(e){note(e.message);update(await bridge.screen('status'));}finally{changing=false;controls();}}
  $('#screen-persistent').onchange=configure;$('#screen-resume').onchange=configure;
  async function preview(){const current=epoch;const result=await bridge.screen('capture');if(current!==epoch||!access.active)return;frame=result;$('#screen-preview').src='data:image/jpeg;base64,'+frame.image;$('#screen-preview').hidden=false;}
  async function enable(action){
    if(busy||changing)return;cancel();changing=true;controls();$('#screen-panel').hidden=false;note(action==='select'?'Drag a rectangle to share. Escape cancels.':'Enabling access to the entire desktop…');
    try{update(await bridge.screen(action));await preview();note(description());$('#screen-question').focus();}
    catch(e){update(await bridge.screen('status'));note(e.message.includes('Command failed')?'Selection cancelled, or grim/slurp is unavailable.':e.message);}
    finally{changing=false;controls();}
  }
  async function answer(){
    if(busy||changing||!access.active)return;const question=$('#screen-question').value.trim();if(!question){note('Describe what you want help with first.');return;}
    const current=epoch;busy=true;onBusy();controls();controller=new AbortController();
    try{
      await preview();if(current!==epoch||!frame)return;
      if(live&&lastDigest===frame.digest&&lastQuestion===question){note('● Live guide · screen unchanged · checking again shortly');return;}
      note('● Reading your screen locally…');
      const bootstrap=await(await fetch('/api/bootstrap')).json();
      const response=await fetch('/api/screen-guide',{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':bootstrap.token},body:JSON.stringify({frame,question}),signal:controller.signal});
      const result=await response.json();if(!response.ok)throw new Error(result.error);if(current!==epoch)return;lastDigest=frame.digest;lastQuestion=question;
      $('#screen-result').innerHTML=renderMarkdown(result.content);note(`● ${live?'Live guide':'Screen access on'} · last answer ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})} · ${result.metrics?.seconds||'?'}s · local only`);
    }catch(e){if(current===epoch){live=false;note(e.name==='AbortError'?'Screen analysis stopped.':e.message);}}
    finally{busy=false;onIdle();controls();if(current===epoch&&live)timer=setTimeout(answer,12000);}
  }
  $('#screen-select').onclick=()=>enable('select');$('#screen-desktop').onclick=()=>enable('desktop');$('#screen-ask').onclick=answer;$('#screen-stop').onclick=stop;
  $('#screen-live').onclick=()=>{if(live){epoch++;live=false;clearTimeout(timer);controller?.abort();controls();note('Live guide paused · screen access remains on');}else if(access.active&&!busy){live=true;lastDigest=null;controls();answer();}};
  function suspend(){cancel();note(description());}
  $('#screen-close').onclick=async()=>{suspend();update(await bridge.screen('detach'));$('#screen-panel').hidden=true;};
  bridge.onScreen?.(update);bridge.screen('status').then(update).catch(e=>note(e.message));
  window.addEventListener('beforeunload',()=>{controller?.abort();bridge.screen('detach');});
  return {voice(text,handsFree){$('#screen-question').value=text;if(handsFree&&!busy&&access.active)answer();},async open(){ $('#screen-panel').hidden=false;$('#screen-question').focus();try{update(await bridge.screen('status'));}catch(e){note(e.message);}},stop,suspend,isBusy:()=>busy};
}
