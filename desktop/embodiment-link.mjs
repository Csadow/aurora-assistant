export class EmbodimentLink{
  constructor({origin,status,onChange,fetchImpl=fetch,interval=400}){Object.assign(this,{origin,status,onChange,fetchImpl,interval});}
  start(){if(this.controller)return;const controller=this.controller=new AbortController();let previous;
    const tick=async()=>{
      try{
        const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(2500)]);
        if(!this.token){const r=await this.fetchImpl(this.origin+'/api/bootstrap',{signal});if(!r.ok)throw new Error('Bootstrap unavailable');this.token=(await r.json()).token;}
        const r=await this.fetchImpl(this.origin+'/api/embodiment/poll',{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':this.token},body:JSON.stringify(this.status()),signal});
        if(!r.ok){this.token=null;throw new Error('Companion connection interrupted');}
        const value=await r.json(),key=JSON.stringify(value);
        if(!controller.signal.aborted&&key!==previous){previous=key;this.onChange(value);}
      }catch{if(!controller.signal.aborted){this.token=null;if(previous!==null){previous=null;this.onChange({available:false,phase:'idle',cue:null});}}}
      finally{if(!controller.signal.aborted)this.timer=setTimeout(tick,this.interval);}
    };tick();
  }
  stop(){this.controller?.abort();this.controller=null;clearTimeout(this.timer);}
}
