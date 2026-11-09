import {randomUUID} from 'node:crypto';
import {AppError} from './vault.mjs';
import {prepareDesktopRequirements} from './workflow-desktop-requirements.mjs';

const keys=(v,allowed)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>allowed.includes(k));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const stale=()=>new AppError('The page, window or desktop connection changed. Refresh the preview and review it again.',409);

// Authenticated, user-invoked metadata reads. No model tool, action approval,
// workflow evidence or persisted record is created by previewing/selecting.
export class DesktopOutcomePicker {
  constructor(computer,{now=Date.now,ttl=120000,limit=12}={}){Object.assign(this,{computer,now,ttl,limit});this.previews=new Map();}
  drop(id){const p=this.previews.get(id);if(p)clearTimeout(p.timer);this.previews.delete(id);}
  close(){for(const id of this.previews.keys())this.drop(id);}
  connection(){this.computer.enabled();if(!this.computer.status().online)throw new AppError('Open the Aurora desktop app to preview a page or window.',503);return this.computer.lease;}
  async observe(kind,signal){
    const lease=this.connection();
    let result;try{result=await this.computer.request('outcome_targets',{kind},signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000));}
    catch(e){if(e.message==='Unknown desktop request.')throw new AppError('Save your draft, quit Aurora from the tray and relaunch to load the updated desktop picker.',409);throw e;}
    if(this.connection()!==lease)throw stale();
    if(kind==='browser'){
      const p=result?.page;if(!p||!Number.isSafeInteger(p.navigation)||p.navigation<0||typeof p.title!=='string')throw new AppError('The desktop did not return a complete page preview. Refresh and try again.');
      const rule=prepareDesktopRequirements({browser:{url:p.url,...p.title?{title:p.title}:{}}}).browser;
      return {lease,targets:[{key:'page',...rule,navigation:p.navigation}]};
    }
    if(!Array.isArray(result?.windows)||result.windows.length>80)throw new AppError('The desktop did not return a valid window list. Refresh and try again.');
    const targets=result.windows.map(w=>{
      if(!w||typeof w.id!=='string'||!/^0x[0-9a-f]+$/i.test(w.id)||!Number.isSafeInteger(w.pid)||w.pid<=0)throw new AppError('The desktop returned an incomplete window identity. Refresh and try again.');
      const rule=prepareDesktopRequirements({window:{title:w.title,...w.app?{app:w.app}:{}}}).window;
      return {key:w.id,pid:w.pid,...rule};
    });
    if(new Set(targets.map(t=>t.key)).size!==targets.length)throw new AppError('The desktop returned duplicate window identities. Refresh and try again.');
    return {lease,targets,omitted:Number.isSafeInteger(result.omitted)&&result.omitted>=0?Math.min(result.omitted,10000):0};
  }
  async preview(input,signal){
    if(!keys(input,['kind'])||!['browser','window'].includes(input.kind))throw new AppError('Choose a browser page or app window preview.');
    const snapshot=await this.observe(input.kind,signal);signal?.throwIfAborted();
    for(const [id,p] of this.previews)if(p.expires<=this.now())this.drop(id);
    while(this.previews.size>=this.limit)this.drop(this.previews.keys().next().value);
    const id=randomUUID(),expires=this.now()+this.ttl,timer=setTimeout(()=>this.drop(id),this.ttl);timer.unref?.();
    this.previews.set(id,{...snapshot,kind:input.kind,expires,timer});
    return {id,kind:input.kind,expires,observedAt:this.now(),targets:snapshot.targets.map(({pid,navigation,...t})=>t),omitted:snapshot.omitted||0};
  }
  async select(input,signal){
    if(!keys(input,['id','target','includeTitle','includeApp'])||typeof input.id!=='string'||typeof input.target!=='string'||['includeTitle','includeApp'].some(k=>Object.hasOwn(input,k)&&typeof input[k]!=='boolean'))throw new AppError('Choose a target from the current preview.');
    const p=this.previews.get(input.id);if(!p||p.expires<=this.now()){this.drop(input.id);throw new AppError('This preview expired. Refresh it before copying a requirement.',409);}
    this.drop(input.id); // Consume before awaiting: a double click cannot reuse it.
    if(this.connection()!==p.lease)throw stale();
    const selected=p.targets.find(t=>t.key===input.target);if(!selected)throw new AppError('Choose a target from the displayed preview.');
    const fresh=await this.observe(p.kind,signal);signal?.throwIfAborted();
    const current=fresh.targets.find(t=>t.key===selected.key);
    // A user who omits the title is explicitly selecting only this URL. Still
    // bind the document generation: a reload/redirect is a new preview target.
    const matches=p.kind==='browser'&&!input.includeTitle?current&&current.url===selected.url&&current.navigation===selected.navigation:same(selected,current);
    if(this.now()>=p.expires||fresh.lease!==p.lease||!matches)throw stale();
    const requirement=p.kind==='browser'?{url:selected.url,...input.includeTitle&&selected.title?{title:selected.title}:{}}:{title:selected.title,...input.includeApp&&selected.app?{app:selected.app}:{}};
    return {kind:p.kind,requirement};
  }
}
