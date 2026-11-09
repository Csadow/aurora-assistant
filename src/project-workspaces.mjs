import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {relative,isAbsolute} from 'node:path';
import {AppError} from './vault.mjs';
import {prepareRequirements} from './workflow-requirements.mjs';

const inside=(root,path)=>{const r=relative(root,path);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('../');};
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max;
export class ProjectWorkspaces {
  constructor({store,vault,system}){Object.assign(this,{store,vault,system});this.saving=false;}
  async validate(input){
    if(!text(input.name,100)||!text(input.notePath,4096)||!Array.isArray(input.folders)||!input.folders.length||input.folders.length>4||!Array.isArray(input.checks)||input.checks.length>2)throw new AppError('Choose a project name, an existing note, one to four folders and up to two saved checks.');
    const note=await this.vault.read(input.notePath);
    if(['draft','journal','archived'].includes(note.status)||note.kind==='handoff')throw new AppError('Choose an active project or reference note, not a draft or handoff.');
    const folders=[];
    for(const path of input.folders){const resolved=await this.system.path(path);if(!(await stat(resolved)).isDirectory())throw new AppError('Project folders must be existing directories.');if(folders.includes(resolved))throw new AppError('List each project folder only once.');folders.push(resolved);}
    const checks=[];
    for(const c of input.checks){
      if(!text(c.name,80)||checks.some(x=>x.name===c.name.trim()))throw new AppError('Give each saved check a distinct name (up to 80 characters).');
      const {commands}=await prepareRequirements({files:[],commands:[{program:c.program,args:c.args,cwd:c.cwd,outputIncludes:c.outputIncludes}]},this.system);
      if(!folders.some(f=>inside(f,commands[0].cwd)))throw new AppError('A saved check must run in a project folder.');
      checks.push({name:c.name.trim(),...commands[0]});
    }
    await prepareRequirements({files:[],commands:checks.map(({name,...c})=>c)},this.system);
    return {name:input.name.trim(),notePath:note.path,folders,checks};
  }
  list(){return this.store.list('project-workspaces');}
  read(id){return this.store.get('project-workspaces',id);}
  async save(input){
    if(this.saving)throw new AppError('Project settings are being saved. Try again.',409);
    this.saving=true;
    try{
      const old=input.id?await this.read(input.id):null;
      if(old&&input.revision!==old.revision)throw new AppError('Project settings changed. Your draft is kept; reload the saved settings before saving again.',409);
      const value=await this.validate(input),all=await this.list();
      if(all.some(p=>p.id!==old?.id&&p.notePath===value.notePath))throw new AppError('This note already has a project workspace. Open its settings.');
      if(!old&&all.length>=30)throw new AppError('Up to 30 project workspaces are supported.');
      return this.store.put('project-workspaces',{id:old?.id||randomUUID(),...value,revision:(old?.revision||0)+1,created:old?.created||new Date().toISOString(),updated:new Date().toISOString()});
    }finally{this.saving=false;}
  }
  async bind(id,revision,checkNames){
    if(!id){if(revision!==undefined||checkNames!==undefined)throw new AppError('Choose the project again.');return null;}
    const p=await this.read(id);
    if(p.revision!==revision)throw new AppError('Project settings changed. Select the project again and review its folders and checks.',409);
    if(!Array.isArray(checkNames)||new Set(checkNames).size!==checkNames.length||checkNames.some(n=>!p.checks.some(c=>c.name===n)))throw new AppError('Select saved checks from the current project settings.');
    const current=await this.validate(p);
    if(JSON.stringify(current)!==JSON.stringify({name:p.name,notePath:p.notePath,folders:p.folders,checks:p.checks}))throw new AppError('Project paths changed. Review and save its settings again.',409);
    return {...p,checks:p.checks.filter(c=>checkNames.includes(c.name))};
  }
  async target(project,path,{missing=false}={}){
    if(!project)return;
    // Fail closed if a saved root was replaced by a symlink since selection.
    for(const root of project.folders)if(await this.system.path(root)!==root)throw new AppError('A project folder changed. Start a new task after reviewing project settings.',409);
    const resolved=await this.system.path(path,{missing});
    if(!project.folders.some(root=>inside(root,resolved)))throw new AppError('This target is outside this task’s saved project folders. Start a new task with the intended project settings.');
  }
  async requirements(project,requirements){
    if(!project)return;
    for(const r of requirements.files)await this.target(project,r.path,{missing:true});
    for(const r of requirements.commands)await this.target(project,r.cwd);
  }
  async action(project,kind,payload){
    if(kind==='write')await this.target(project,payload.path,{missing:true});
    if(kind==='command')await this.target(project,payload.cwd);
  }
  async dashboard(id,handoffs){
    const project=await this.read(id),all=await this.store.list('workflows');
    const tasks=all.filter(w=>w.project?.id===id).map(w=>({id:w.id,goal:w.goal,status:w.status,updated:w.updated,current:w.current,steps:w.steps.length,projectRevision:w.project.revision,sourceId:w.handoff?.sourceId,result:w.result?.slice(0,2500),error:w.error,children:all.filter(c=>c.handoff?.sourceId===w.id).map(c=>({id:c.id,goal:c.goal}))}));
    const ids=new Set(tasks.map(w=>w.id));
    return {project,tasks,handoffs:(await handoffs.list()).filter(h=>ids.has(h.sourceId))};
  }
}
