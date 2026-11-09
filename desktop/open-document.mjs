import {access,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,join} from 'node:path';
import {homedir} from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
const editors={'nvim.desktop':'nvim','vim.desktop':'vim','nano.desktop':'nano'};
// xdg-open can start Terminal=true editors without a terminal on bare Wayland
// desktops. User overrides can also incorrectly say Terminal=false. Recognize
// the exact commands of these terminal editors; never evaluate desktop Exec text.
export async function documentOpener(path,{execute=run,home=homedir(),read=readFile,check=access}={}){
  const fallback={kind:'default'};let handler;
  try{
    const options={timeout:2500,maxBuffer:16000};
    const mime=(await execute('/usr/bin/xdg-mime',['query','filetype',path],options)).stdout.trim();
    if(!/^[\w.+-]+\/[\w.+-]+$/.test(mime))return fallback;
    handler=(await execute('/usr/bin/xdg-mime',['query','default',mime],options)).stdout.trim();fallback.handler=handler;
  }catch{return fallback;}
  const editor=editors[handler];if(!editor)return fallback;
  let entry;
  for(const dir of [join(home,'.local/share/applications'),'/usr/local/share/applications','/usr/share/applications']){
    try{entry=await read(join(dir,handler),'utf8');break;}catch(e){if(e.code!=='ENOENT')return fallback;}
  }
  const section=entry?.match(/^\[Desktop Entry\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1]||'';
  const value=key=>section.match(new RegExp('^'+key+'=(.*)$','m'))?.[1]?.trim();
  if(!new RegExp('^(?:/usr/bin/)?'+editor+' %(?:f|F)$').test(value('Exec')||''))return fallback;
  await check('/usr/bin/'+editor,constants.X_OK);
  const title=basename(path);
  for(const [command,args] of [
    ['/usr/bin/foot',['--title='+title,'--app-id=aurora-document','/usr/bin/'+editor,'--',path]],
    ['/usr/bin/kitty',['--title',title,'--class','aurora-document','/usr/bin/'+editor,'--',path]],
  ]){
    try{await check(command,constants.X_OK);}catch{continue;}
    return {kind:'terminal',handler,command,args};
  }
  throw new Error('The default editor needs a terminal. Install Foot or Kitty, or choose a graphical default editor.');
}

export async function openDocument(path,opener,signal,{launch=spawn,openPath}={}){
  signal?.throwIfAborted();
  if(opener.kind==='terminal'){
    await new Promise((resolve,reject)=>{
      const child=launch(opener.command,opener.args,{detached:true,stdio:'ignore'});
      child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
    });
  }else{
    openPath??=(await import('electron')).shell.openPath;
    signal?.throwIfAborted();const error=await openPath(path);if(error)throw new Error(error);
  }
  return {content:'Requested opening '+path+' in its default application. Inspect windows to verify it opened.'};
}
