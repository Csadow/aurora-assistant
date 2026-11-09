import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function projectContinuitySmoke({backend,evaluate,wait,report}){
  const previous=backend.assistant.ollama.chat,path=join(backend.config.data,'..','native-target.txt');
  backend.assistant.ollama.chat=async(m,_t,_s,_c,options)=>{
    if(options?.format?.properties.steps)return {content:JSON.stringify({steps:[{title:'Inspect and verify the target',check:'Read the final text.'}]})};
    const c=JSON.parse(m.at(-1).content),ops=c.recentEvidence.map(JSON.parse),last=ops.at(-1);
    if(!last||last.name==='propose_file_edit')return {tool_calls:[{function:{name:'read_system_file',arguments:{path}}}]};
    if(!ops.some(o=>o.name==='propose_file_edit'))return {tool_calls:[{function:{name:'propose_file_patch',arguments:{path,evidence:c.evidenceForCompletion[0].id,edits:[{before:'left',after:'right'}],reason:'Change the unique marker'}}}]};
    return {tool_calls:[{function:{name:'finish_step',arguments:{summary:'Verified the current target.',evidence:c.evidenceForCompletion.map(o=>o.id)}}}]};
  };
  try{
    await evaluate('document.querySelector("[data-view=workflows]").click()');
    if(report.phase==='first'){
      await writeFile(path,'Header\r\nleft marker\r\nFooter\r\n');const task=await backend.workflows.start({goal:'Native targeted edit fixture',scope:path});
      await wait(async()=>(await backend.store.get('workflows',task.id)).status==='waiting_approval'&&!backend.workflows.running.has(task.id),'native patch ready');
      await wait(()=>evaluate(`!!document.querySelector('[data-workflow-open="${task.id}"]')`),'native patch task');await evaluate(`document.querySelector('[data-workflow-open="${task.id}"]').click()`);const actionId=(await backend.workflows.read(task.id)).operations.at(-1).action;await wait(()=>evaluate(`!!document.querySelector('[data-workflow-action="${actionId}"]')`),'native patch link');await evaluate(`document.querySelector('[data-workflow-action="${actionId}"]').click()`);await wait(()=>evaluate('document.querySelector("#action-review-dialog").open&&document.querySelector("#action-patch")?.textContent.includes("right")'),'native exact diff');assert(await evaluate('document.querySelector("#action-patch").textContent.includes("right")'));await evaluate('document.querySelector("#action-approve").click()');await wait(async()=>(await backend.store.get('workflows',task.id)).status==='completed','native patch complete');assert.equal(await readFile(path,'utf8'),'Header\r\nright marker\r\nFooter\r\n');report.checks.push('native targeted replacement review preserves untouched CRLF text and requires approval');
      await wait(()=>evaluate('!!document.querySelector("#handoff-prepare")'),'native handoff control');await evaluate('document.querySelector("#handoff-prepare").click()');await wait(()=>evaluate('!!document.querySelector("#workflow-handoff-save")'),'native handoff draft');await evaluate('document.querySelector("#workflow-handoff-save").requestSubmit()');await wait(()=>evaluate('!!document.querySelector("#handoff-use")'),'native handoff saved');assert.equal((await backend.workflows.handoffs.list()).length,1);report.checks.push('native project handoff saves reviewed Markdown without starting a new task');
    }else{
      const h=(await backend.workflows.handoffs.list())[0];assert(h);await evaluate('document.querySelector("#workflow-handoff-refresh").click()');await wait(()=>evaluate(`!!document.querySelector('#workflow-handoff option[value="${h.id}"]')`),'restored handoff option');await evaluate(`document.querySelector('#workflow-handoff').value=${JSON.stringify(h.id)};document.querySelector('#workflow-handoff').dispatchEvent(new Event('change'));`);await wait(()=>evaluate('document.querySelector("#workflow-handoff-preview").textContent.includes("Previous context")'),'native handoff preview');
      await evaluate('document.querySelector("#workflow-goal").value="Native handoff continuation";document.querySelector("#workflow-scope").value="Review current state";document.querySelector("#workflow-form").requestSubmit()');let child;await wait(async()=>{child=(await backend.store.list('workflows')).find(w=>w.goal==='Native handoff continuation');return child?.status==='plan_review';},'native handoff plan review');assert.equal(child.handoff.sourceId,h.sourceId);assert.equal(child.operations.length,0);await backend.workflows.control(child.id,'cancel');report.checks.push('saved handoff survives native restart and new work pauses for a fresh plan review');
    }
  }finally{backend.assistant.ollama.chat=previous;await evaluate('document.querySelector("#workflow-goal").value="";document.querySelector("#workflow-scope").value="";document.querySelector("[data-view=chat]").click()');}
}
