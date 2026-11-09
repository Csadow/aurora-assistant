import { randomUUID } from 'node:crypto';
import { AppError, sha } from './vault.mjs';
import { runCommand } from './system.mjs';
import {automaticComputerOperations} from './computer.mjs';
import {executeTestCopy,cleanupInterruptedCopy} from './workflow-test-copy.mjs';

export class Actions {
  constructor({store,settings,system,cloud,computer,execute=runCommand}){Object.assign(this,{store,settings,system,cloud,computer,execute});this.running=new Map();this.locks=new Set();}
  async init(){for(const a of await this.store.list('actions'))if(a.status==='running'){a.status='interrupted';const cleaned=a.kind==='test_copy'?await cleanupInterruptedCopy(a.payload).catch(()=>false):false;a.result={...(a.kind==='test_copy'?a.result||{}:{}),content:'Aurora restarted during this action. Check the actual result before creating another request; it will not be retried automatically.',...(a.kind==='test_copy'?{cleanedUp:cleaned,...(!cleaned?{cleanupRequired:a.payload.directory}:{}),notice:'Partial copy-test receipts are historical. No original edit was approved.'}:{})};await this.store.put('actions',a);}}
  enabled(){if(!this.settings.value.systemEnabled)throw new AppError('System access is paused in Settings.',403);}
  async routine(name,value,conversation){
    this.enabled();if(!this.settings.value.routineEnabled)throw new AppError('Automatic routine actions are disabled. Propose a command for review instead.',403);
    const payload=await this.system.routine(name,value),a=await this.propose('command',{...payload,reason:`Routine action: ${name}`},conversation);
    a.approval='automatic routine policy';await this.store.put('actions',a);await this.decide(a.id,'approve',a.digest);
    const until=Date.now()+12000;while(this.running.has(a.id)&&Date.now()<until)await new Promise(r=>setTimeout(r,50));const result=await this.store.get('actions',a.id);return {id:a.id,status:result.status,kind:'command',result:result.result};
  }
  async computerAction(input,conversation,signal){
    signal?.throwIfAborted();const a=await this.propose('computer',input,conversation,signal);
    if(!automaticComputerOperations.has(a.payload.operation)||!this.settings.value.routineEnabled)return {id:a.id,kind:a.kind,status:'pending',reason:a.reason,message:'Review this exact computer action in Actions. It has not run.'};
    a.approval='automatic routine policy';await this.store.put('actions',a);signal?.throwIfAborted();await this.decide(a.id,'approve',a.digest);
    const abort=()=>this.running.get(a.id)?.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{while(this.running.has(a.id)){await new Promise(r=>setTimeout(r,40));}signal?.throwIfAborted();const done=await this.store.get('actions',a.id);return {id:a.id,kind:a.kind,status:done.status,result:done.result};}finally{signal?.removeEventListener('abort',abort);}
  }
  async propose(kind,input,conversation,signal,workflow){
    if(conversation)await this.store.get('conversations',conversation);
    if((await this.store.list('actions')).filter(a=>a.status==='pending').length>=20)throw new AppError('Review or dismiss existing actions before requesting more.');
    let payload;
    if(kind==='command'){this.enabled();payload=await this.system.prepareCommand(input.program,input.args,input.cwd);}
    else if(kind==='test_copy'){this.enabled();if(!workflow||!this.prepareTestCopy)throw new AppError('Copy tests must belong to a reviewed project workflow.',403);payload=await this.prepareTestCopy(input,workflow);}
    else if(kind==='write'){this.enabled();if(input.edits!==undefined&&input.content!==undefined)throw new AppError('Supply targeted replacements or complete content, not both.');payload=input.edits!==undefined?await this.system.preparePatch(input.path,input.revision,input.edits):await this.system.prepareWrite(input.path,input.content);}
    else if(kind==='computer'){this.enabled();payload=await this.computer.prepare(input,signal);}
    else if(kind==='cloud')payload=this.cloud.prepare(input.question,input.context,input.reason);
    else throw new AppError('Unknown action.');
    if(workflow&&this.workflowPreflight){const checked=await this.workflowPreflight(kind,payload,workflow);if(checked)payload.requirementsCheck=checked;}
    if(workflow&&kind==='write'&&payload.before===payload.content)throw new AppError('The file already matches this edit. Read it to verify, then use the saved evidence; no new action is needed.');
    const action={id:randomUUID(),kind,conversation:conversation||null,payload,reason:String(input.reason||'').slice(0,600),status:'pending',created:new Date().toISOString(),expires:new Date(Date.now()+(kind==='computer'?2:30)*60000).toISOString()};
    if(workflow)action.workflow=workflow;
    action.digest=sha(JSON.stringify({kind,payload}));await this.store.put('actions',action);
    return action;
  }
  async decide(id,decision,digest){
    if(this.deciding)throw new AppError('Another action decision is being processed. Try again.',409);
    if(this.locks.has(id))throw new AppError('Action is already being handled.',409);this.deciding=true;this.locks.add(id);
    try{
      const a=await this.store.get('actions',id);if(a.status!=='pending')throw new AppError('This action has already been handled. It cannot run again.',409);
      if(!['approve','dismiss'].includes(decision))throw new AppError('Invalid action decision.');
      if(decision==='dismiss'){a.status='dismissed';a.updated=new Date().toISOString();return await this.store.put('actions',a);}
      if(a.workflow){if(!this.workflowGuard)throw new AppError('Workflow coordinator is unavailable. Resume after restarting Aurora.',409);await this.workflowGuard(a);}
      if(a.digest!==digest||a.digest!==sha(JSON.stringify({kind:a.kind,payload:a.payload})))throw new AppError('The action changed. Reload its preview.',409);
      if(Date.parse(a.expires)<Date.now())throw new AppError('This request expired. Ask Aurora for a new proposal.',409);
      if(this.running.size)throw new AppError('Wait for the current action to finish, or stop it.',409);
      if(a.kind!=='cloud')this.enabled();if(a.kind==='computer')this.computer.enabled();
      if(a.kind==='cloud'){
        if(a.payload.revision!==this.settings.cloudRevision()||!this.settings.value.cloud.enabled)throw new AppError('Cloud settings changed. Request a new consultation.',409);
        const day=new Date().toISOString().slice(0,10);const used=(await this.store.list('actions')).filter(x=>x.kind==='cloud'&&x.started?.startsWith(day)).length;
        if(used>=this.settings.value.cloud.dailyLimit)throw new AppError('Today’s cloud request limit has been reached. Attempts count even if they fail.',429);
        const reserved=(await this.store.list('actions')).filter(x=>x.kind==='cloud'&&x.started?.startsWith(day)).reduce((n,x)=>n+(x.payload.maxTokens||0),0);
        if(reserved+a.payload.maxTokens>(this.settings.value.cloud.dailyOutputLimit??32768))throw new AppError('Today’s cloud output-token allowance is exhausted. Each attempt reserves its full maximum, including failed or stopped requests.',429);
      }
      if(a.workflow)await this.workflowGuard?.(a);
      const controller=new AbortController();this.running.set(id,controller);a.status='running';a.started=a.updated=new Date().toISOString();
      try{await this.store.put('actions',a);this.finish(a,controller).catch(()=>{});}catch(e){this.running.delete(id);throw e;}
      return a;
    }finally{this.locks.delete(id);this.deciding=false;}
  }
  async finish(a,controller){
    try{
      a.result=a.kind==='test_copy'?await executeTestCopy(this.system,a.payload,{signal:controller.signal,onProgress:async result=>{a.result=structuredClone(result);await this.store.put('actions',a);}}):a.kind==='computer'?await this.computer.execute(a.payload,controller.signal):a.kind==='cloud'?await this.cloud.ask(a.payload,controller.signal):a.kind==='write'?await this.system.write(a.payload,a.id,controller.signal):await this.execute(a.payload,{signal:controller.signal});
      a.status=a.result.committed?'completed':controller.signal.aborted||a.result.stopped?'stopped':a.kind==='test_copy'&&a.result.error||a.kind==='command'&&a.result.code!==0?'failed':'completed';
    }catch(e){a.status=controller.signal.aborted?'stopped':'failed';a.result={content:e.status?e.message:'Action failed. Check the result before trying again.'};}
    a.updated=new Date().toISOString();try{await this.store.put('actions',a);}finally{this.running.delete(a.id);}
  }
  stop(id){const controller=this.running.get(id);if(!controller)throw new AppError('No running action with that ID.',404);controller.abort();return {stopping:true};}
  stopAll(){for(const c of this.running.values())c.abort();}
}
