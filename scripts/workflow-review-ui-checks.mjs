import assert from 'node:assert/strict';

export async function workflowReviewUIChecks({evaluate,check}){
 const result=await evaluate(`(async()=>{
  const {workflowReviewUI}=await import('/workflow-review.js');
  const container=document.createElement('section');document.body.append(container);
  const waiting=[],errors=[],api=path=>new Promise((resolve,reject)=>waiting.push({path,resolve,reject}));
  const escape=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const ui=workflowReviewUI({api,escape,toast:message=>errors.push(message)}),workflow=id=>({id,operations:[]});
  const data=text=>({at:new Date().toISOString(),notice:text,files:[]});
  const mount=id=>{const host=ui.render(workflow(id));container.replaceChildren(host);return host;};
  const refresh=host=>{const button=host.querySelector('[data-refresh-changes]');return button.onclick({currentTarget:button});};
  try{
   let host=mount('first'),response=refresh(host);host=mount('first');
   const busyAfterRender=host.querySelector('button').disabled;if(busyAfterRender)await refresh(host);const oneRequest=waiting.length===1;
   waiting.shift().resolve(data('Readback <img src=x>'));await response;
   const rendered=host.textContent.includes('Readback <img src=x>')&&!host.querySelector('img')&&!host.querySelector('button').disabled;
   response=refresh(host);const other=mount('second');waiting.shift().resolve(data('Updated first workflow'));await response;
   const selectionRetained=container.firstElementChild===other&&!other.textContent.includes('Updated first workflow');
   host=mount('first');const cached=host.textContent.includes('Updated first workflow');
   response=refresh(host);host=mount('first');waiting.shift().reject(Error('Readback unavailable'));await response;
   const retryReady=!host.querySelector('button').disabled&&host.textContent.includes('Updated first workflow')&&errors.join()==='Readback unavailable';
   response=refresh(host);waiting.shift().resolve(data('Retry succeeded'));await response;
   return {busyAfterRender,oneRequest,rendered,selectionRetained,cached,retryReady,retried:host.textContent.includes('Retry succeeded')};
  }finally{container.remove();}
 })()`);
 assert(result.busyAfterRender&&result.oneRequest&&result.rendered,JSON.stringify(result));check('a file-review response updates the replacement workflow panel, escapes source text and prevents duplicate reads during polling');
 assert(result.selectionRetained&&result.cached);check('a late file review keeps another workflow selected and retains the result for its original workflow');
 assert(result.retryReady&&result.retried);check('a failed file review retains the previous observation and enables retry on the currently rendered panel');
}
