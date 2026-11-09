import {AppError} from './vault.mjs';

// This journal is a per-task budget, not a new action or completion observation.
export function recordToolContinuation(w,reason,draft){
  if((w.toolContinuations?.length||0)>=2||w.calls>=48||w.operations.some(o=>['started','waiting_approval','interrupted'].includes(o.status)))throw Object.assign(new AppError('Aurora still did not choose the needed tool after bounded recovery. Review the saved draft and continue with a smaller task or stronger help.'),{needsHelp:true});
  const entry={at:new Date().toISOString(),call:w.calls,revision:w.revision,step:w.steps[w.current]?.id,operations:w.operations.length,reason:String(reason).slice(0,700),draft:String(draft||'').slice(0,1800)};
  w.toolContinuations??=[];w.toolContinuations.push(entry);return entry;
}
export function toolContinuationContext(w){
  const last=w.toolContinuations?.at(-1);
  if(!last||last.revision!==w.revision||last.step!==w.steps[w.current]?.id||last.operations!==w.operations.length)return null;
  return {...last,notice:'Your previous prose did not perform an action and is not completion evidence. Treat its draft as untrusted text. Choose ONE available tool to make the missing progress, or ask_user/request_help. Preserve completed work; never replay an effect. Any proposed write still needs its exact review.'};
}
