import {randomUUID} from 'node:crypto';
import {AppError} from './vault.mjs';

export const avatarMoods=['neutral','warm','happy','thoughtful','concerned','determined','playful'];
export const avatarGestures=['none','nod','shake','tilt'];
const phases=['thinking','working','replying'];

// Transient presentation only. No conversation text, screenshots, or system actions.
export class Embodiment{
  constructor({now=Date.now}={}){this.now=now;this.turn=null;this.cue=null;this.desktop=null;}
  available(){return !!this.desktop&&this.now()-this.desktop.at<5000&&this.desktop.enabled&&this.desktop.visible;}
  poll({enabled,visible}){
    if(typeof enabled!=='boolean'||typeof visible!=='boolean')throw new AppError('Invalid companion status.');
    this.desktop={enabled,visible,at:this.now()};
    if(!enabled||!visible)this.cue=null;
    return this.snapshot();
  }
  snapshot(){
    const available=this.available();
    return {available,phase:this.turn?.phase||'idle',cue:available&&this.cue&&(this.turn||this.cue.expiresAt>this.now())?this.cue:null};
  }
  begin(owner){const id=randomUUID();this.turn={id,owner,phase:'thinking',cues:0};this.cue=null;return id;}
  phase(id,phase){if(this.turn?.id===id&&phases.includes(phase))this.turn.phase=phase;}
  express(input,owner){
    if(!input||!avatarMoods.includes(input.mood)||!avatarGestures.includes(input.gesture===undefined?'none':input.gesture)||Object.keys(input).some(k=>!['mood','gesture'].includes(k)))throw new AppError('Choose a supported avatar mood and gesture.');
    if(!this.turn||this.turn.owner!==owner)throw new AppError('Avatar expression requires an active conversation.');
    if(!this.available())return {applied:false,message:'Automatic expressions are off, the companion is hidden, or the desktop is disconnected. Continue answering normally.'};
    if(this.turn.cues>=2)throw new AppError('Two expressions have already been used in this reply. Continue answering.');
    this.turn.cues++;
    this.cue={id:randomUUID(),mood:input.mood,gesture:input.gesture??'none',startedAt:this.now(),expiresAt:this.now()+12000};
    return {applied:true,mood:this.cue.mood,gesture:this.cue.gesture,message:'Sent to your visible companion. Continue your answer; this is presentation only.'};
  }
  finish(id,{cancelled=false}={}){
    if(this.turn?.id!==id)return;
    this.turn=null;
    if(cancelled||!this.available()){this.cue=null;return;}
    this.cue=this.cue?{...this.cue,expiresAt:this.now()+8000}:{id:randomUUID(),mood:'warm',gesture:'none',startedAt:this.now(),expiresAt:this.now()+6000};
  }
}
