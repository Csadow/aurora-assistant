// Poll only while the native desktop is running. Backend leases and acknowledgements
// prevent ordinary restart duplicates; a crash between show and acknowledgement can retry.
export class ReminderNotifier {
  constructor({origin,notify,fetchImpl=fetch,onError=()=>{},interval=15000}){Object.assign(this,{origin,notify,fetch:fetchImpl,onError,interval});this.running=false;this.busy=false;}
  start(){if(this.running)return;this.running=true;this.tick();this.timer=setInterval(()=>this.tick(),this.interval);this.timer.unref?.();}
  stop(){this.running=false;clearInterval(this.timer);this.controller?.abort();}
  async tick(){
    if(!this.running||this.busy)return;this.busy=true;const controller=new AbortController();this.controller=controller;
    try{
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]),bootstrap=await this.fetch(this.origin+'/api/bootstrap',{signal});if(!bootstrap.ok)throw new Error('Aurora is unavailable.');const {token}=await bootstrap.json();
      const post=async(path,data)=>{const response=await this.fetch(this.origin+path,{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':token},body:JSON.stringify(data),signal});const value=await response.json();if(!response.ok)throw new Error(value.error||'Reminder delivery failed.');return value;};
      const {delivery}=await post('/api/reminders/poll',{});if(!delivery||!this.running)return;
      await this.notify(delivery,signal);signal.throwIfAborted();await post('/api/reminders/ack',{id:delivery.id});
    }catch(e){if(this.running&&e.name!=='AbortError')this.onError(e.message);}
    finally{this.busy=false;if(this.controller===controller)this.controller=null;}
  }
}
