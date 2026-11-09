// Deterministic native UI fixture. No microphone or speaker is opened by this test.
export function fixtureSpeech(speech){
  const calls=[];
  speech.check=async()=>({available:true,voice:'Jenny (Dioco)',engine:'Piper · fixture'});
  speech.synth=async(text,_settings,signal)=>{signal.throwIfAborted();calls.push(text);return {pcm:Buffer.alloc(22050),sampleRate:22050};};
  speech.play=async(_audio,settings,signal,onLevel)=>{
    signal.throwIfAborted();const tick=()=>onLevel(settings.lipSync&&settings.volume>0 ? .65 : 0);tick();const timer=setInterval(tick,40);
    try{await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}finally{clearInterval(timer);onLevel(0);}
  };
  return calls;
}
