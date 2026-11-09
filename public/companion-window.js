import {companionView} from './companion.js';
const $=s=>document.querySelector(s),bridge=window.asterDesktop;
const error=e=>{$('#avatar-error').hidden=false;$('#avatar-error').textContent=e?.message||String(e);};
$('#overlay-done').onclick=()=>bridge.overlay('done').catch(error);
$('#overlay-reset').onclick=()=>bridge.overlay('reset').catch(error);
$('#overlay-size').oninput=()=>$('#overlay-size-label').textContent=$('#overlay-size').value+' px';
$('#overlay-size').onchange=()=>bridge.overlay('resize',{height:Number($('#overlay-size').value)}).catch(error);
for(const [id,delta] of [['overlay-smaller',-80],['overlay-larger',80]])$('#'+id).onclick=()=>bridge.overlay('resize',{height:Math.max(240,Math.min(1200,Number($('#overlay-size').value)+delta))}).catch(error);
bridge.onCommand(command=>{
  if(command?.type==='overlay-viewport'){
    if([command.x,command.y,command.width,command.height].every(Number.isFinite))Object.assign($('#overlay-edit').style,{left:command.x+'px',top:command.y+'px',width:command.width+'px',height:command.height+'px',right:'auto',bottom:'auto'});
    return;
  }
  if(command?.type!=='layout')return;
  document.body.dataset.arranging=String(command.editing===true);$('#overlay-edit').hidden=!command.editing;
  $('#overlay-size').value=command.height||920;$('#overlay-size-label').textContent=(command.height||920)+' px';
});
document.addEventListener('keydown',e=>{
  if(document.body.dataset.arranging!=='true')return;
  if(e.key==='Escape'){e.preventDefault();bridge.overlay('done').catch(error);return;}
  const moves={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
  if(moves[e.key]&&!e.target.matches('input,select,textarea')){
    e.preventDefault();const [x,y]=moves[e.key],n=e.shiftKey?40:10;bridge.overlay('nudge',{dx:x*n,dy:y*n}).catch(error);
  }
});
try{await companionView({bridge});document.body.dataset.ready='true';await bridge.overlay('ready');}catch(e){error(e);}
