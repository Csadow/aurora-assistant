import {AppError} from './vault.mjs';

// Keep complete Responses output items, including reasoning and call items,
// for the next tool round trip. The HTTP plan route cannot use previous_response_id.
export class ChatGPTChat {
 constructor(plan,{fetchImpl=fetch}={}){this.plan=plan;this.fetch=fetchImpl;this.sessions=new WeakMap();}
 appendMessage(state,message){
  // Saved workflow prompts replay bounded observations from previous model calls.
  // They have no original Responses call ID, so pair each synthetic call and
  // result with a fresh stable ID within this request.
  if(message.role==='assistant'&&message.tool_calls?.length){
   if(message.content)state.input.push({role:'assistant',content:message.content});
   for(const call of message.tool_calls){const callId=call.id||`aurora_replay_${++state.replay}`;state.pending.push(callId);state.input.push({type:'function_call',call_id:callId,name:call.function.name,arguments:typeof call.function.arguments==='string'?call.function.arguments:JSON.stringify(call.function.arguments||{})});}
   return;
  }
  if(message.role==='tool'){
   const callId=message.tool_call_id||state.pending.shift();if(!callId)throw new AppError('A ChatGPT tool reply is missing its call reference.',500);
   if(message.tool_call_id){const index=state.pending.indexOf(callId);if(index>=0)state.pending.splice(index,1);}
   state.input.push({type:'function_call_output',call_id:callId,output:message.content});return;
  }
  state.input.push({role:message.role==='system'?'developer':message.role,content:message.content||''});
 }
 async chat(messages,tools,signal,onChunk,options={}){
  const account=this.plan.active();if(!account?.model)throw new AppError('Choose a ChatGPT model in Settings before using ChatGPT chat.',409);
  if(options.expectedAccount&&account.clientId!==options.expectedAccount||options.expectedModel&&account.model!==options.expectedModel)throw new AppError('This workflow belongs to another ChatGPT account or model. Select its saved account and model in Settings.',409);
  let state=this.sessions.get(messages);if(!state){state={input:[],cursor:0,pending:[],replay:0};this.sessions.set(messages,state);}
  for(const message of messages.slice(state.cursor))this.appendMessage(state,message);
  state.cursor=messages.length;
  const definitions=tools?.map(t=>({type:'function',name:t.function.name,description:t.function.description,parameters:t.function.parameters,strict:false}));
  const advertised=new Set(definitions?.map(t=>t.name)||[]);
  // A required tool is only valid for the one explicitly requested read-only
  // lookup. This guard prevents callers from forcing a write-capable function.
  if(options.requireReadTool&&(options.requireReadTool!=='search_memory'||definitions?.length!==1||!advertised.has(options.requireReadTool)))throw new AppError('A required read-only tool must be the only advertised tool.',500);
  const body={model:account.model,input:state.input,store:false,stream:true,...(definitions?.length?{tools:[{type:'namespace',name:'aurora',description:'Aurora memory, planning and reviewed laptop tools',tools:definitions}]}:{}),...(options.requireReadTool?{tool_choice:'required',parallel_tool_calls:false}:{}),...(options.format?{text:{format:{type:'json_schema',name:'aurora_workflow_result',schema:options.format,strict:false}}}:{})};
  const token=await this.plan.access();if(this.plan.active()?.clientId!==account.clientId||this.plan.active()?.model!==account.model)throw new AppError('ChatGPT account or model changed before sending. Retry with the current selection.',409);let response;
  try{response=await this.fetch('https://api.openai.com/v1/responses',{method:'POST',redirect:'error',signal,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});}catch(e){if(signal?.aborted)throw e;throw new AppError('ChatGPT could not be reached. The request was not retried.',503);}
  if(!response.ok){const help=response.status===401?'Reconnect ChatGPT in Settings.':response.status===403?'This account or workspace cannot use the selected model.':response.status===429?'ChatGPT usage limit was reached. Try again later or choose Local.':'Check the model and connection in Settings.';throw new AppError('ChatGPT request failed ('+response.status+'). '+help,502);}
  if(!response.body)throw new AppError('ChatGPT returned no response stream.',502);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',answer='',completed=null,terminal=false;
  const startedItems=new Set(),finishedItems=new Map();
  const event=line=>{
   if(!line.startsWith('data:'))return;const data=line.slice(5).trim();if(!data||data==='[DONE]')return;
   let value;try{value=JSON.parse(data);}catch{throw new AppError('ChatGPT returned an unreadable stream event.',502);}
   if(value.type==='response.output_text.delta'&&typeof value.delta==='string'){answer+=value.delta;onChunk?.(value.delta);}
   if(value.type==='response.output_item.added'&&Number.isSafeInteger(value.output_index)){
    if(value.output_index<0||startedItems.has(value.output_index))throw new AppError('ChatGPT returned duplicate or invalid output items. No tool was executed.',502);
    startedItems.add(value.output_index);
   }
   if(value.type==='response.output_item.done'){
    const index=value.output_index,item=value.item;
    if(!Number.isSafeInteger(index)||index<0||!item||typeof item!=='object'||finishedItems.has(index)||item.status&&item.status!=='completed')throw new AppError('ChatGPT returned an invalid completed output item. No tool was executed.',502);
    finishedItems.set(index,item);
   }
   if(value.type==='response.completed'){completed=value.response;terminal=true;}
   if(value.type==='response.failed'||value.type==='response.incomplete'){terminal=true;throw new AppError(value.response?.error?.message||'ChatGPT did not complete the response. No partial tool call was executed.',502);}
  };
  try{while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});if(buffer.length>2000000)throw new AppError('ChatGPT stream event was too large.',502);let i;while((i=buffer.indexOf('\n'))>=0){event(buffer.slice(0,i).trimEnd());buffer=buffer.slice(i+1);}}buffer+=decoder.decode();if(buffer.trim())event(buffer.trim());}finally{await reader.cancel().catch(()=>{});}
  if(!terminal||!completed||completed.status!=='completed')throw new AppError('ChatGPT disconnected before completing. No partial tool call was executed.',502);
  // The ChatGPT plan stream can omit `response.output` in its terminal event.
  // Only fully finished stream items may be executed or replayed.
  const terminalOutput=Array.isArray(completed.output)?completed.output:[];
  if(!terminalOutput.length&&[...startedItems].some(index=>!finishedItems.has(index)))throw new AppError('ChatGPT did not finish all output items. No tool was executed.',502);
  const output=terminalOutput.length?terminalOutput:[...finishedItems].sort(([a],[b])=>a-b).map(([,item])=>item);
  if(output.some(item=>item.type==='message'&&(item.content||[]).some(c=>c.type==='refusal')))throw new AppError('ChatGPT declined this request. Review the task before continuing.',422);
  const text=output.flatMap(item=>item.type==='message'?(item.content||[]).filter(c=>c.type==='output_text').map(c=>c.text||''):[]).join('');
  if(!answer&&text){answer=text;onChunk?.(text);}else if(text&&text!==answer)throw new AppError('ChatGPT stream text did not match the completed response.',502);
  const ids=new Set();
  const calls=output.filter(item=>item.type==='function_call').map(item=>{
   const name=item.name?.replace(/^aurora\./,'');let args;
   try{args=JSON.parse(item.arguments);}catch{throw new AppError('ChatGPT returned unreadable tool arguments. No tool was executed.',502);}
   if(!advertised.has(name)||typeof item.call_id!=='string'||!item.call_id||ids.has(item.call_id)||!args||typeof args!=='object'||Array.isArray(args))throw new AppError('ChatGPT returned an unexpected tool call. No tool was executed.',502);
   ids.add(item.call_id);return {id:item.call_id,function:{name,arguments:item.arguments}};
  });
  if(options.requireReadTool&&!calls.some(call=>call.function.name===options.requireReadTool))throw new AppError('ChatGPT did not call the explicitly requested memory search. No tool was executed.',502);
  state.input.push(...output);state.cursor=messages.length+1;
  const usage=completed.usage||{};
  return {role:'assistant',content:answer,tool_calls:calls,metrics:{model:account.model,provider:'chatgpt',tokens:usage.output_tokens,promptTokens:usage.input_tokens}};
 }
}
