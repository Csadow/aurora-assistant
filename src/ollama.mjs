import { localEndpoint } from './config.mjs';
import { AppError } from './vault.mjs';
// Qwen3.5's published general-task defaults; preserve explicit per-request options.
// https://huggingface.co/Qwen/Qwen3.5-9B#best-practices
export const samplingOptions=(model,thinking)=>/^qwen3\.5(?::|$)/i.test(model)?{temperature:thinking?1:0.7,top_p:thinking?0.95:0.8,top_k:20,min_p:0,presence_penalty:1.5,repeat_penalty:1}:/^gemma4(?::|$)/i.test(model)?{temperature:1,top_p:0.95,top_k:64}:{temperature:0.25};
export class Ollama {
  constructor(url,model,fetchImpl=fetch) { this.url=localEndpoint(url);this.model=model;this.fetch=fetchImpl; }
  async request(path,body,signal) {
    const response=await this.fetch(this.url+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,redirect:'error',signal:signal||AbortSignal.timeout(5000)});
    if(!response.ok) throw new AppError(`Local model request failed (${response.status}). ${String((await response.text()).slice(0,300))}`,502);
    return response;
  }
  async status() {
    try { const data=await (await this.request('/api/tags')).json(); return {online:true,model:this.model,models:(data.models||[]).filter(m=>!m.remote_model&&!m.remote_host&&!/cloud/i.test(m.name)).map(m=>({name:m.name,size:m.size,...(m.capabilities?{capabilities:m.capabilities}:{}),...(m.details?.family?{family:m.details.family}:{})})),error:null}; }
    catch { return {online:false,model:this.model,models:[],error:'Ollama is offline. Start Aurora from the application launcher, or run node scripts/start.mjs.'}; }
  }
  async check({vision=false}={}) {
    const status=await this.status();
    if(!status.online) throw new AppError(status.error,503);
    if(!status.models.some(m=>m.name===this.model)) throw new AppError(`Local model ${this.model} is not installed.`,503);
    const info=await(await this.request('/api/show',{model:this.model})).json();
    if(info.remote_model||info.remote_host||info.details?.format!=='gguf'||!info.capabilities?.includes('completion')) throw new AppError('Choose an installed local text model.',400);
    if(vision&&!info.capabilities.includes('vision'))throw new AppError('The selected local model does not support images. Choose an installed vision model.',400);
  }
  async chat(messages,tools,signal,onChunk,options={}) {
    const {format,think=this.generationOptions?.think??false,onThinking,...modelOptions}=options;let thinkingSignaled=false;
    const response=await this.request('/api/chat',{...(format?{format}:{}),model:this.model,messages,tools,stream:true,think,keep_alive:'5m',options:{...samplingOptions(this.model,think),num_ctx:this.generationOptions?.num_ctx??12288,num_predict:this.generationOptions?.num_predict??1600,...modelOptions}},signal);
    const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='',content='',calls=[],done=false,metrics={};
    const consume=line=>{
      if(!line.trim())return;
      const item=JSON.parse(line);
      if(item.error){
        const error=new AppError(item.error,502);
        // Ollama can reject a malformed generated tool-call envelope after
        // streaming earlier chunks. The caller must discard the whole reply.
        if(/^XML syntax error on line \d+:/i.test(item.error))error.code='model_tool_parse_error';
        throw error;
      }
      if(item.message?.thinking&&!thinkingSignaled){thinkingSignaled=true;onThinking?.();}
      if(item.message?.content){content+=item.message.content;onChunk?.(item.message.content);}
      if(item.message?.tool_calls) calls.push(...item.message.tool_calls);
      if(item.done){done=true;metrics={tokens:item.eval_count,promptTokens:item.prompt_eval_count,seconds:Math.round((item.total_duration||0)/1e8)/10,model:this.model,thinking:!!think,doneReason:item.done_reason};}
    };
    try {
      while(true){const {value,done:end}=await reader.read();if(end)break;buffer+=decoder.decode(value,{stream:true});let idx;while((idx=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,idx));buffer=buffer.slice(idx+1);} }
      buffer+=decoder.decode();if(buffer.trim())consume(buffer);
      if(!done)throw new AppError('The local model disconnected before finishing. Please retry.',502);
      if(metrics.doneReason==='length')throw Object.assign(new AppError('The model reached its output limit before finishing. Review saved progress, narrow the task, or request stronger help. No partial tool call was executed.',422),{code:'model_output_limit',metrics});
      return {role:'assistant',content,...(calls.length?{tool_calls:calls}:{}),metrics};
    } finally { await reader.cancel().catch(()=>{}); }
  }
}
