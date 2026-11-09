export async function companionView({bridge}){
  const $=s=>document.querySelector(s),frame=$('#live2d-frame');let state='idle',generation=0,nonce='',ready=false,cursor=null,automatic=true,performance=null;
  const post=data=>{if(ready&&!frame.hidden)frame.contentWindow.postMessage(data,'aster://avatar');};
  // Audio amplitudes are independent of automatic expressions and cursor tracking.
  bridge.onMouth(value=>post({type:'mouth',active:value.active,level:value.level}));
  const gaze=()=>{const rect=frame.getBoundingClientRect();post({type:'gaze',point:cursor&&rect.width&&rect.height?{x:(cursor.x*innerWidth-rect.x)/rect.width,y:(cursor.y*innerHeight-rect.y)/rect.height}:null});};
  bridge.onCursor(value=>{cursor=value;gaze();});addEventListener('resize',gaze);
  const perform=()=>{
    const cue=performance?.available?performance.cue:null;
    const mood=cue?.mood||(['thinking','working','preparing'].includes(state)?'thoughtful':['listening','replying','speaking'].includes(state)?'warm':'neutral');
    $('#avatar-automatic').checked=automatic;$('#avatar-performance').textContent=automatic?'Aurora is in control · '+mood:'Manual expression';
    post({type:'state',state:automatic?state:'idle'});
    post({type:'performance',automatic,mood,gesture:cue?.gesture||'none',id:cue?.id||'state:'+state,startedAt:cue?.startedAt||0});
  };
  $('#avatar-automatic').onchange=async()=>{try{await bridge.companion($('#avatar-automatic').checked?'automatic-on':'automatic-off');}catch(e){$('#avatar-error').hidden=false;$('#avatar-error').textContent=e.message;perform();}};
  $('#companion-ask').onclick=()=>bridge.quick('open');
  $('#companion-voice').onclick=()=>bridge.quick('voice');$('#companion-screen').onclick=()=>bridge.quick('screen');
  bridge.onPresence(value=>{state=value.state;performance=value.performance;document.body.dataset.state=state;$('#companion-state').textContent=value.label;$('#companion-screen-state').hidden=!value.screenActive;perform();});
  const fallback=(message,unload=true)=>{ready=false;bridge.overlay('model-ready',{ready:false}).catch(()=>{});document.body.dataset.avatar='fallback';frame.hidden=true;if(unload)frame.removeAttribute('src');$('#builtin-avatar').removeAttribute('hidden');$('.expression-control').hidden=true;$('#avatar-error').hidden=!message;$('#avatar-error').textContent=message;};
  async function load(){const current=++generation;const status=await bridge.companion('status');if(current!==generation)return;automatic=status.automatic!==false;fallback('');perform();$('#avatar-expression').replaceChildren(new Option('Neutral','-1'));for(const [i,name] of (status.expressions||[]).entries())$('#avatar-expression').add(new Option(name,String(i)));
    if(status.enabled&&status.hasModel&&status.hasRuntime){nonce=String(current);frame.src='aster://avatar/?generation='+nonce;frame.hidden=false;document.body.dataset.avatar='loading';}
    else if(status.enabled&&status.hasModel)fallback('Model ready. Add the Cubism runtime in Settings to bring her to life.');
  }
  $('#avatar-expression').onchange=async()=>{const index=Number($('#avatar-expression').value);try{await bridge.companion('automatic-off');automatic=false;perform();post({type:'expression',index});}catch(e){$('#avatar-error').hidden=false;$('#avatar-error').textContent=e.message;}};
  window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!=='aster://avatar'||event.data?.generation!==nonce)return;
    if(event.data.type==='ready'){ready=true;document.body.dataset.avatar='ready';bridge.overlay('model-ready',{ready:true}).catch(()=>{});bridge.overlay('ready').catch(()=>{});$('#builtin-avatar').setAttribute('hidden','');$('.expression-control').hidden=$('#avatar-expression').options.length<2;perform();gaze();}
    if(event.data.type==='expression-error'){$('#avatar-error').hidden=false;$('#avatar-error').textContent='This expression could not load. Choose Neutral or another one.';}
    if(event.data.type==='error')fallback('Her model could not load. The assistant still works; try reselecting Live2D in Settings.',false);
  });
  bridge.onAvatar(value=>{if(value?.type==='automatic'){automatic=value.enabled;perform();return;}load().catch(()=>fallback('Could not read the model settings.'));});
  await load();
}
