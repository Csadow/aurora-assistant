import { readdir, lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError, tokens } from './vault.mjs';
const extensions=/\.(md|txt|js|mjs|ts|tsx|jsx|py|rs|go|css|html|json|yaml|yml|toml|sh)$/i;
const skip=new Set(['node_modules','venv','__pycache__','dist','build','artifacts','vendor','data']);
export class Projects {
  constructor(items){this.items=items;}
  project(name){const p=this.items.find(p=>p.name===name);if(!p)throw new AppError('Unknown project.');return p;}
  async files(name){
    const p=this.project(name),files=[];
    const walk=async(dir,depth)=>{
      if(depth>5||files.length>=1500)return;
      for(const ent of await readdir(join(p.root,dir),{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
        if(ent.name.startsWith('.')||ent.isSymbolicLink()||skip.has(ent.name)||/lock|secret|credential/i.test(ent.name))continue;
        const path=dir?`${dir}/${ent.name}`:ent.name;
        if(ent.isDirectory())await walk(path,depth+1);
        else if(ent.isFile()&&extensions.test(ent.name))files.push(path);
      }
    };await walk('',0);return files.slice(0,1500);
  }
  async read(name,path){
    const p=this.project(name);
    if(typeof path!=='string'||!path||path.startsWith('/')||path.split(/[\\/]/).some(s=>!s||s.startsWith('.')||skip.has(s))||/secret|credential|lock/i.test(path)||!extensions.test(path))throw new AppError('This file is outside the allowed project documents.');
    let full=resolve(p.root);
    for(const part of path.split('/')){full=join(full,part);if((await lstat(full)).isSymbolicLink())throw new AppError('Project symlinks cannot be read.');}
    const stat=await lstat(full);if(!stat.isFile()||stat.size>300000)throw new AppError('Project file is too large.');
    return {project:name,path,content:(await readFile(full,'utf8')).slice(0,10000)};
  }
  async search(name,query){
    const words=tokens(query);const hits=[];
    for(const path of await this.files(name)){
      try{const file=await this.read(name,path);const text=file.content.toLowerCase();const score=words.reduce((s,w)=>s+(text.includes(w)?1:0)+(path.toLowerCase().includes(w)?3:0),0);if(score)hits.push({path,score,excerpt:file.content.split('\n').filter(l=>words.some(w=>l.toLowerCase().includes(w))).slice(0,5).join('\n').slice(0,900)});}catch{}
    }
    return hits.sort((a,b)=>b.score-a.score).slice(0,6);
  }
}
