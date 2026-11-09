import {spawn} from 'node:child_process';
import {access,mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';

const root=join(homedir(),'.local/share/aurora-voice/piper');
const revision='c10ece1aade47bb51c153c893d14e5bf8e5b7117';
const model='en_GB-jenny_dioco-medium.onnx';
const hash='469c630d209e139dd392a66bf4abde4ab86390a0269c1e47b4e5d7ce81526b01';
const base=`https://huggingface.co/rhasspy/piper-voices/resolve/${revision}/en/en_GB/jenny_dioco/medium/`;
const run=(program,args)=>new Promise((resolve,reject)=>{const child=spawn(program,args,{stdio:'inherit'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(program+' failed')));});
await mkdir(root,{recursive:true,mode:0o700});
const python=join(root,'venv/bin/python');
try{await access(python);}catch{await run('uv',['venv','--python','3.12',join(root,'venv')]);}
await run('uv',['pip','install','--python',python,'piper-tts==1.8.0']);
for(const file of [model,model+'.json','MODEL_CARD']){
  const path=join(root,file),expected=file===model?hash:null;
  if(expected){try{if(createHash('sha256').update(await readFile(path)).digest('hex')===expected)continue;}catch{}}
  const response=await fetch(base+file,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error('Voice download failed: '+response.status);
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>80000000)throw new Error('Voice download exceeded its size limit.');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);if(expected&&createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Voice checksum did not match.');
  try{await writeFile(path+'.part',bytes,{mode:0o600});await rename(path+'.part',path);}finally{await rm(path+'.part',{force:true});}
}
await writeFile(join(root,'voice.json'),JSON.stringify({voice:'Jenny (Dioco)',language:'English',engine:'Piper 1.8.0',revision,sha256:hash,source:'https://huggingface.co/rhasspy/piper-voices',attribution:'https://github.com/dioco-group/jenny-tts-dataset',engineLicense:'GPL-3.0',engineSource:'https://github.com/OHF-Voice/piper1-gpl'},null,2)+'\n',{mode:0o600});
console.log('Local voice ready: Jenny (Dioco), English, Piper 1.8.0.');
