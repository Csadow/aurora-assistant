// Speech starts only from explicit button clicks. Loading/rendering replies is silent.
const bridge=window.asterDesktop;
let settingsUnsubscribe;
export const stopSpeech=()=>bridge?.speech('stop').catch(()=>{});
export function readAloudButton(text,onError){
  if(!bridge?.speech||!text?.trim())return null;
  const button=document.createElement('button');button.type='button';button.className='read-aloud';button.textContent='Read aloud';
  button.onclick=async()=>{button.disabled=true;try{await bridge.speech('say',{text});}catch(e){onError(e.message);}finally{button.disabled=false;}};
  return button;
}
export function speechControls(host,onError){
  if(!host||!bridge?.speech)return;
  host.hidden=false;host.classList.add('speech-controls');
  host.innerHTML='<span class="speech-state" role="status">Read aloud is manual</span><button type="button" class="speech-stop" hidden>Stop speaking</button><button type="button" class="speech-mute" aria-pressed="false">Mute voice</button>';
  const status=host.querySelector('.speech-state'),stop=host.querySelector('.speech-stop'),mute=host.querySelector('.speech-mute');let muted=false;
  const update=value=>{muted=value.settings.muted;stop.hidden=!value.busy;mute.textContent=muted?'Unmute voice':'Mute voice';mute.setAttribute('aria-pressed',String(muted));status.textContent=value.error||(muted?'Voice muted':value.state==='synthesizing'?'Preparing local voice…':value.state==='speaking'?'Speaking'+(value.truncated?' · shortened; full reply in chat':''):'Read aloud is manual');};
  bridge.onSpeech(update);bridge.speech('status').then(update).catch(e=>onError(e.message));
  stop.onclick=()=>stopSpeech();mute.onclick=()=>bridge.speech('configure',{muted:!muted}).catch(e=>onError(e.message));
}
export async function speechSettings(host,onError){
  if(!bridge?.speech)return;
  settingsUnsubscribe?.();
  const value=await bridge.speech('status'),section=document.createElement('section');section.id='speech-settings';
  section.innerHTML='<h4>Spoken replies</h4><p class="settings-help">Read aloud only · replies never speak automatically.</p><p class="settings-help">Jenny (Dioco) · English · local Piper voice. <a href="https://github.com/dioco-group/jenny-tts-dataset" target="_blank" rel="noreferrer">Voice credit</a></p><p class="speech-availability settings-help"></p><label class="check-row"><input id="speech-muted" type="checkbox">Mute spoken replies</label><label class="check-row"><input id="speech-lips" type="checkbox">Move her mouth with speech</label><div class="settings-grid"><label>Voice speed<input id="speech-rate" type="number" min="0.8" max="1.3" step="0.05"></label><label>Voice volume<input id="speech-volume" type="range" min="0" max="1" step="0.05"></label></div><div class="action-buttons"><button type="button" id="speech-save">Save voice settings</button><button type="button" id="speech-preview">Preview voice</button><button type="button" id="speech-settings-stop">Stop speaking</button></div><p class="settings-help">Talk stops playback before recording. Wake listening pauses while she speaks; use Talk or Stop speaking to interrupt her. Long replies are shortened; code blocks and tables stay in chat.</p>';
  host.append(section);const $=s=>section.querySelector(s),populate=s=>{$('#speech-muted').checked=s.muted;$('#speech-lips').checked=s.lipSync;$('#speech-rate').value=s.rate;$('#speech-volume').value=s.volume;};populate(value.settings);
  settingsUnsubscribe=bridge.onSpeech(value=>{$('#speech-muted').checked=value.settings.muted;});
  $('.speech-availability').textContent=value.available?'Ready on this laptop. Text and generated audio stay in memory.':value.error;
  $('#speech-preview').disabled=!value.available;
  const save=async()=>{const saved=await bridge.speech('configure',{muted:$('#speech-muted').checked,lipSync:$('#speech-lips').checked,rate:Number($('#speech-rate').value),volume:Number($('#speech-volume').value)});populate(saved.settings);return saved;};
  $('#speech-save').onclick=()=>save().then(()=>onError('Voice settings saved.')).catch(e=>onError(e.message));
  // Mute is immediate, including before the user presses Save.
  $('#speech-muted').onchange=()=>bridge.speech('configure',{muted:$('#speech-muted').checked}).catch(e=>onError(e.message));
  $('#speech-preview').onclick=async()=>{try{await save();await bridge.speech('say',{text:"I'm Aurora. I'm here to help you think clearly and take the next step."});}catch(e){onError(e.message);}};
  $('#speech-settings-stop').onclick=()=>stopSpeech();
}
