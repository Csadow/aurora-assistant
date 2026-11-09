import {spawn} from 'node:child_process';
import {access,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
const root=join(homedir(),'.local/share/aurora-voice/whisper.cpp');
const run=(program,args,cwd)=>new Promise((resolve,reject)=>{const child=spawn(program,args,{cwd,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(program+' failed')));});
try{await access(join(root,'CMakeLists.txt'));}catch{await mkdir(join(root,'..'),{recursive:true});await run('git',['clone','https://github.com/ggml-org/whisper.cpp.git',root]);await run('git',['checkout','d09f61a708f3487afa956ff578e60eae5e7a233c'],root);}
await run('cmake',['-S',root,'-B',join(root,'build'),'-DCMAKE_BUILD_TYPE=Release','-DGGML_CUDA=OFF','-DWHISPER_BUILD_TESTS=OFF','-DWHISPER_BUILD_SERVER=OFF']);
await run('cmake',['--build',join(root,'build'),'-j','4','--target','whisper-cli']);
for(const model of ['base','tiny.en']){try{await access(join(root,'models','ggml-'+model+'.bin'));}catch{await run('bash',['models/download-ggml-model.sh',model],root);}}
console.log('Local speech and wake recognition are installed.');
