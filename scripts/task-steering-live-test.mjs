import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir,access} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {homedir} from 'node:os';
import {config} from '../src/config.mjs';
import {atomic,sha} from '../src/vault.mjs';
const base=`http://127.0.0.1:${config.port}`,boot=await(await fetch(base+'/api/bootstrap')).json();
const request=async(path,data)=>{const r=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-Aster-Token':boot.token},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error(await r.text());return r;};
const api=async(...args)=>(await request(...args)).json();
assert.equal(boot.version,'1.12.0');assert.equal((await api('/api/computer')).online,true);
const dir=await mkdtemp(join(homedir(),'.cache/aurora-steering-live-')),original=join(dir,'original.txt'),destination=join(dir,'aurora-review-'+basename(dir)+'.txt');
const c=await api('/api/conversations',{}),start=Date.now();let id,record,steered=false,approvals=0,memory,originalProposalMatched;
const output=new URL('../artifacts/task-steering-live-results.json',import.meta.url);
try{
  const goal=`Open https://example.com in Aurora Browser and read its actual page title. Save exactly that title and a newline to ${original}, read it back, then open that file in its default app for review and check that the editor window opened. Verify the page title and window outcome using fresh evidence. Only change this disposable file; do not run commands, type into apps, send messages, or use cloud help.`;
  const events=(await(await request('/api/chat',{id:c.id,message:goal,mode:'act'})).text()).trim().split('\n').map(JSON.parse);id=events.find(e=>e.type==='workflow')?.workflow.id;assert(id);let last='';
  await atomic(new URL('../artifacts/task-steering-live-checkpoint.json',import.meta.url).pathname,JSON.stringify({id,conversation:c.id,dir,original,destination}));
  while(Date.now()-start<1200000){
    record=await api('/api/workflow?id='+id);const progress=JSON.stringify([record.status,record.revision,record.current,record.calls,record.operations.at(-1)?.name]);if(progress!==last){console.log(progress);last=progress;}
    if(['completed','paused','needs_verification','cancelled','waiting_input'].includes(record.status))break;
    for(const op of record.operations.filter(o=>o.status==='waiting_approval'&&o.action)){
      const a=await api('/api/action?id='+op.action);if(a.status!=='pending')continue;
      assert.equal(a.kind,'write','Only a disposable file edit can be approved');assert.equal(a.workflow.id,id);
      if(!steered){assert.equal(a.payload.path,original);
        // The old proposal is being retired, never approved. Record formatting
        // errors and request exact formatting along with the destination change.
        originalProposalMatched=a.payload.content==='Example Domain\n';
        const reply=(await(await request('/api/chat',{id:c.id,workflowId:id,mode:'steer',message:`Save to ${destination} instead. Do not create ${original}. The file must contain exactly the verified page title followed by one newline, as originally requested. Keep the browser evidence already collected, read back the new file, then open the new file in its default app for review and verify its window.`})).text()).trim().split('\n').map(JSON.parse);
        assert.equal(reply.at(-1).type,'done');assert.equal((await api('/api/action?id='+a.id)).status,'dismissed');steered=true;
      }else{assert.equal(a.payload.path,destination);assert.equal(a.payload.content,'Example Domain\n');await api('/api/action-decide',{id:a.id,decision:'approve',digest:a.digest});approvals++;}
    }
    await new Promise(r=>setTimeout(r,500));
  }
  assert.equal(record.status,'completed',record.error||record.question||'Task timed out');assert(steered);assert.equal(approvals,1);await assert.rejects(access(original));assert.equal(await readFile(destination,'utf8'),'Example Domain\n');
  assert(record.operations.some(o=>o.name==='verify_outcome'&&o.status==='completed'&&o.arguments.kind==='browser_title'));
  assert(record.operations.some(o=>o.name==='computer_action'&&o.status==='completed'&&o.arguments.operation==='open_path'&&o.arguments.path===destination));
  assert(record.operations.some(o=>o.name==='verify_outcome'&&o.status==='completed'&&o.arguments.kind==='window_title'));
  const draft=await api('/api/workflow-memory',{id});assert.match(draft.body,/Results/);memory=await api('/api/workflow-memory',{id,title:'Disposable Aurora steering acceptance',body:draft.body});assert.equal(memory.status,'pending');
  await assert.rejects(access(join(config.vault,memory.path)));await api('/api/proposal',{id:memory.id,action:'accept'});assert.match(await readFile(join(config.vault,memory.path),'utf8'),/workflow:/);
  const result={ok:true,seconds:Math.round((Date.now()-start)/1000),model:boot.model,approvals,steered,originalProposalMatched,memoryReviewed:true,record};await atomic(output.pathname,JSON.stringify(result,null,2));console.log(JSON.stringify({ok:true,seconds:result.seconds,approvals,originalProposalMatched}));
}catch(e){await atomic(output.pathname,JSON.stringify({ok:false,error:e.message,steered,approvals,originalProposalMatched,record},null,2));throw e;}
finally{
  if(id){const w=await api('/api/workflow?id='+id).catch(()=>null);if(w&&!['completed','cancelled'].includes(w.status))await api('/api/workflow-control',{id,operation:'cancel'});await new Promise(r=>setTimeout(r,1000));}
  // Close only a window whose observed title contains this fixture's unique name.
  const windows=record?.operations.filter(o=>o.name==='computer_action'&&o.arguments.operation==='windows'&&o.status==='completed').at(-1)?.result?.windows||[];
  for(const win of windows.filter(w=>w.title?.includes(basename(destination)))){
    try{const a=await api('/api/action-propose',{kind:'computer',conversation:c.id,input:{operation:'close_window',windowId:win.id,reason:'Close this disposable acceptance-test editor'}});assert(a.payload.target.title.includes(basename(destination)));await api('/api/action-decide',{id:a.id,decision:'approve',digest:a.digest});let state;do{await new Promise(r=>setTimeout(r,100));state=await api('/api/action?id='+a.id);}while(state.status==='running');}catch(e){console.log('Fixture editor cleanup:',e.message);}
  }
  for(const kind of ['actions','proposals'])for(const name of await readdir(join(config.data,kind))){if(!name.endsWith('.json'))continue;const path=join(config.data,kind,name),r=JSON.parse(await readFile(path,'utf8'));if(r.conversation===c.id||id&&(r.workflow?.id===id||r.workflow===id))await rm(path);}
  if(id)await rm(join(config.data,'workflows',id+'.json'),{force:true});await rm(join(config.data,'conversations',c.id+'.json'),{force:true});
  for(const path of [`90 Journal/${c.created.slice(0,10)} ${c.id}.md`,...(memory?[memory.path]:[])]){await rm(join(config.vault,path),{force:true});await rm(join(config.vault,'.aster/history',sha(path)),{recursive:true,force:true});}
  await rm(dir,{recursive:true,force:true});
}
