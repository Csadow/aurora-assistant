import { readFile, writeFile, mkdir, lstat, realpath, rename, rm } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function assetPath(value){
  if(typeof value!=='string'||!value||value.length>220||/[\\:%?#\x00-\x1f]/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.')))throw new Error('Model assets must be ordinary relative files inside the model folder.');
  return value;
}
async function localFile(root,path,limit){
  let full=root;for(const part of assetPath(path).split('/')){full=join(full,part);if((await lstat(full)).isSymbolicLink())throw new Error('Symbolic links are not allowed in an avatar.');}
  const stat=await lstat(full);if(!stat.isFile()||stat.size>limit)throw new Error('Avatar file is missing or too large.');return readFile(full);
}
export async function collectModel(file){
  if(!file.endsWith('.model3.json'))throw new Error('Choose an exported Cubism .model3.json file.');
  const root=await realpath(dirname(file)),raw=await localFile(root,basename(file),1000000);let model;
  try{model=JSON.parse(raw);}catch{throw new Error('Invalid model JSON.');}
  const refs=model.FileReferences;if(model.Version!==3||!refs||typeof refs.Moc!=='string'||!Array.isArray(refs.Textures)||!refs.Textures.length||refs.Textures.length>16)throw new Error('This is not a supported Cubism model export.');
  const paths=new Set();const add=(path,extension)=>{assetPath(path);if(!extension.test(path))throw new Error('Unexpected avatar asset type.');paths.add(path);return path;};
  add(refs.Moc,/\.moc3$/i);refs.Textures.forEach(p=>add(p,/\.(png|jpg|jpeg)$/i));
  for(const key of ['Physics','Pose','DisplayInfo','UserData'])if(refs[key])add(refs[key],/\.json$/i);
  if(refs.Expressions){if(!Array.isArray(refs.Expressions)||refs.Expressions.length>100)throw new Error('Too many expressions.');refs.Expressions.forEach(e=>add(e.File,/\.json$/i));}
  if(refs.Motions){for(const group of Object.values(refs.Motions)){if(!Array.isArray(group)||group.length>100)throw new Error('Too many motions.');for(const motion of group){add(motion.File,/\.json$/i);delete motion.Sound;}}}
  if(paths.size>220)throw new Error('The avatar contains too many assets.');
  const files=new Map();let total=0;
  for(const path of paths){const bytes=await localFile(root,path,32000000);total+=bytes.length;if(total>100000000)throw new Error('Avatars must be smaller than 100 MB.');if(path===refs.Moc&&bytes.subarray(0,4).toString()!=='MOC3')throw new Error('Invalid moc3 model data.');files.set(path,bytes);}
  // Reconstruct FileReferences: unknown URL-bearing fields are discarded.
  model.FileReferences=Object.fromEntries(['Moc','Textures','Physics','Pose','DisplayInfo','UserData','Expressions','Motions'].filter(k=>refs[k]!=null).map(k=>[k,refs[k]]));
  files.set('model.model3.json',Buffer.from(JSON.stringify(model)));return {name:basename(file,'.model3.json'),files,expressions:(refs.Expressions||[]).map((e,i)=>String(e.Name||'Expression '+(i+1)).slice(0,80))};
}
export class AvatarStore {
  constructor(root){this.root=root;this.config={visible:false,enabled:false,automatic:true};this.assets=new Set();this.expressions=[];this.queue=Promise.resolve();}
  async init(){await mkdir(this.root,{recursive:true,mode:0o700});try{const config=JSON.parse(await readFile(join(this.root,'avatar.json'),'utf8'));this.config={visible:config.visible===true,enabled:config.enabled===true,automatic:config.automatic!==false,...(/^[0-9a-f-]{36}$/.test(config.id)?{id:config.id,name:String(config.name).slice(0,100)}:{})};if(this.config.id){const imported=await collectModel(join(this.root,this.config.id,'model.model3.json'));this.assets=new Set(imported.files.keys());this.expressions=imported.expressions;}}catch{this.config.enabled=false;}}
  save(){const work=this.queue.then(async()=>{const path=join(this.root,'avatar.json');await writeFile(path+'.tmp',JSON.stringify(this.config),{mode:0o600});await rename(path+'.tmp',path);return this.status();});this.queue=work.catch(()=>{});return work;}
  async status(){let runtime=false;try{runtime=(await lstat(join(this.root,'live2dcubismcore.min.js'))).isFile();}catch{}return {visible:this.config.visible,enabled:this.config.enabled,automatic:this.config.automatic,name:this.config.name||null,hasModel:!!this.config.id&&this.assets.size>0,hasRuntime:runtime,expressions:this.expressions};}
  async importModel(file){const model=await collectModel(file),id=randomUUID(),dir=join(this.root,id);await mkdir(dir,{mode:0o700});try{for(const [path,bytes] of model.files){await mkdir(dirname(join(dir,path)),{recursive:true,mode:0o700});await writeFile(join(dir,path),bytes,{mode:0o600});}this.assets=new Set(model.files.keys());this.expressions=model.expressions;this.config={...this.config,id,name:model.name,enabled:true};return this.save();}catch(e){await rm(dir,{recursive:true,force:true});throw e;}}
  async importCore(file){if(basename(file)!=='live2dcubismcore.min.js')throw new Error('Choose live2dcubismcore.min.js from your official Cubism SDK.');const core=await localFile(await realpath(dirname(file)),basename(file),4000000);if(!core.toString().includes('Live2DCubismCore'))throw new Error('This does not look like the Cubism Core runtime.');await writeFile(join(this.root,'live2dcubismcore.min.js'),core,{mode:0o600});return this.status();}
  async asset(path){if(path==='core.js')return {bytes:await localFile(this.root,'live2dcubismcore.min.js',4000000),type:'text/javascript'};assetPath(path);if(!this.config.enabled||!this.config.id||!this.assets.has(path))throw new Error('Unknown model asset.');return {bytes:await localFile(join(this.root,this.config.id),path,32000000),type:({'.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'})[extname(path).toLowerCase()]||'application/octet-stream'};}
}
