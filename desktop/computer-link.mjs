export class ComputerLink {
  constructor({origin,execute,onPause}){Object.assign(this,{origin,execute,onPause});this.running=new Map();this.stopped=true;}
  async api(path,data){const r=await fetch(this.origin+path,{method:'POST',headers:{'Content-Type':'application/json','X-Aster-Token':this.token},body:JSON.stringify(data),signal:AbortSignal.timeout(4000)});const value=await r.json();if(!r.ok)throw new Error(value.error);return value;}
  async start(){
    this.stopped=false;const bootstrap=await (await fetch(this.origin+'/api/bootstrap')).json();this.token=bootstrap.token;
    this.lease=(await this.api('/api/computer/connect',{})).lease;this.tick();
  }
  async tick(){
    if(this.stopped)return;
    try{
      const {job,active,enabled}=await this.api('/api/computer/poll',{lease:this.lease});
      for(const [id,c] of this.running)if(!active.includes(id)||!enabled)c.abort();
      if(job&&enabled&&Date.now()<job.expires){
        const controller=new AbortController();this.running.set(job.id,controller);
        this.execute(job.method,job.input,controller.signal).then(result=>this.api('/api/computer/complete',{lease:this.lease,id:job.id,result}),e=>this.api('/api/computer/complete',{lease:this.lease,id:job.id,error:e.message})).catch(()=>{}).finally(()=>this.running.delete(job.id));
      }
    }catch{for(const c of this.running.values())c.abort();try{const b=await(await fetch(this.origin+'/api/bootstrap',{signal:AbortSignal.timeout(1500)})).json();this.token=b.token;this.lease=(await this.api('/api/computer/connect',{})).lease;}catch{}}
    if(!this.stopped)this.timer=setTimeout(()=>this.tick(),300);
  }
  async pause(){for(const c of this.running.values())c.abort();await this.api('/api/settings',{systemEnabled:false,computerEnabled:false});this.onPause?.();}
  stop(){this.stopped=true;clearTimeout(this.timer);for(const c of this.running.values())c.abort();}
}
