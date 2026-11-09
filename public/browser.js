const $=s=>document.querySelector(s),bridge=window.auroraBrowser;
const error=e=>$('#browser-status').textContent=e.message;
const update=value=>{if(document.activeElement!==$('#url'))$('#url').value=value.url;$('#back').disabled=!value.back;$('#forward').disabled=!value.forward;};
bridge.onState(update);bridge.control('state').then(update).catch(error);
$('#navigation').onsubmit=e=>{e.preventDefault();const value=$('#url').value.trim();bridge.control('go',value.includes('://')?value:'https://'+value).catch(error);};
for(const name of ['back','forward','reload'])$('#'+name).onclick=()=>bridge.control(name).catch(error);
