import {randomUUID} from 'node:crypto';
const uuid=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export function workspaceRequest(data={}){
 if(!data||typeof data!=='object'||Array.isArray(data)||!['chat','actions','inbox','overview','review','workflows'].includes(data.view||'chat')||[data.conversation,data.workflow].some(id=>id!=null&&!uuid(id)))throw Error('Invalid workspace request.');
 if(data.taskId!==undefined||data.taskView!==undefined){
  if(!uuid(data.taskId)||!['task-detail','first-step'].includes(data.taskView)||data.view!=='overview'||data.conversation!=null||data.workflow!=null)throw Error('Invalid captured-task request.');
  return {view:'overview',taskId:data.taskId,taskView:data.taskView};
 }
 return {view:data.view||'chat',...(data.conversation?{conversation:data.conversation}:{}),...(data.workflow?{workflow:data.workflow}:{})};
}
export class WorkspaceNavigation {
 constructor({send,timeout=20000}){this.send=send;this.timeout=timeout;this.pending=new Map();}
 open(data){return new Promise((resolve,reject)=>{const navigationId=randomUUID(),timer=setTimeout(()=>{this.pending.delete(navigationId);reject(Error('The workspace did not confirm opening. Your task is saved; reopen Aurora and retry.'));},this.timeout);this.pending.set(navigationId,{resolve,reject,timer});try{this.send({...data,navigationId});}catch(e){clearTimeout(timer);this.pending.delete(navigationId);reject(e);}});}
 finish(id,result){const p=this.pending.get(id);if(!p)return false;clearTimeout(p.timer);this.pending.delete(id);if(result?.ok===true)p.resolve({opened:true});else p.reject(Error(typeof result?.error==='string'?result.error.slice(0,600):'The workspace could not open this task. Finish or recover its current editor, then retry.'));return true;}
 close(){for(const [id,p]of this.pending){clearTimeout(p.timer);p.reject(Error('The workspace closed before confirming. Your captured task remains saved.'));this.pending.delete(id);}}
}
