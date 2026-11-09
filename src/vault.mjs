import {viewList,freshReads} from './read-view.mjs';
import {validateTaskLinks} from '../mobile/web/task-links.js';
import { mkdir, readdir, readFile, writeFile, rename, lstat, unlink, open } from 'node:fs/promises';
import { join, dirname, resolve, basename, posix } from 'node:path';
import { taskLine, tasksIn } from './task-meta.mjs';
import { createHash, randomUUID } from 'node:crypto';
const timezone=process.env.AURORA_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const sha = text => createHash('sha256').update(text).digest('hex');
export const today = () => new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
export const slug = value => String(value).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 90) || 'Untitled';
export async function atomic(path, content, {mode=0o600,signal,beforeCommit}={}) {
  signal?.throwIfAborted();
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file=await open(temp,'wx',mode);
    try { await file.writeFile(content); await file.chmod(mode); await file.sync(); }
    finally { await file.close(); }
    await beforeCommit?.(); signal?.throwIfAborted(); await rename(temp, path);
    // Persist both the bytes and replacement directory entry before acknowledging
    // a saved action. Rename alone is atomic, but not durable after power loss.
    const directory=await open(dirname(path),'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  finally { await unlink(temp).catch(() => {}); }
}
export function parseNote(path, content) {
  const meta = {};
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const scalar=value=>{try{return JSON.parse(value);}catch{}return value.replace(/^'(.*)'$/,'$1').replace(/''/g,"'");};
  let listKey;
  for (const line of fm?.[1].split('\n') || []) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      let val=match[2].trim();listKey=!val?match[1]:null;
      if(listKey)meta[listKey]=[];
      else if(/^\[.*\]$/.test(val)){try{meta[match[1]]=JSON.parse(val);}catch{meta[match[1]]=val.slice(1,-1).split(',').map(v=>scalar(v.trim())).filter(Boolean);}}
      else meta[match[1]]=scalar(val);
    }else if(listKey){const item=line.match(/^\s*-\s+(.+)$/);if(item)meta[listKey].push(scalar(item[1].trim()));else if(line.trim())listKey=null;}
  }
  const body = fm ? content.slice(fm[0].length) : content;
  const title = String(meta.title || body.match(/^#\s+(.+)$/m)?.[1] || basename(path, '.md'));
  const links = [...body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim());
  const tags = [...new Set([...(Array.isArray(meta.tags) ? meta.tags : []), ...[...body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map(m => m[1])])];
  return {path, title, content, body, revision: sha(content), links, tags, aliases:Array.isArray(meta.aliases)?meta.aliases.map(String):[], status: meta.status || (path.startsWith('90 Journal/') ? 'journal' : 'confirmed'), pinned: meta.pinned === true, updated: meta.updated || '', kind: meta.kind || 'note', source: String(meta.source || '')};
}
export function markdown(title, body, meta = {}) {
  return `---\n${Object.entries({title, ...meta, updated: today()}).map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n# ${title}\n\n${body.trim()}\n`;
}

export class Vault {
  constructor(root) { this.root = resolve(root); this.queue = Promise.resolve(); }
  async init() {
    await mkdir(this.root, {recursive: true, mode: 0o700});
    for (const folder of ['00 Home','10 Profile','20 Projects','30 Knowledge','40 Tasks','50 Daily','60 Inbox','90 Journal','99 Archive','.aster/history','.aster/trash','.obsidian']) await mkdir(join(this.root,folder),{recursive:true,mode:0o700});
    const marker=await this.safe('.aster/Initialized.md',true);
    try{await readFile(marker);return;}catch(e){if(e.code!=='ENOENT')throw e;}
    const seeds = {
      '00 Home/Start here.md': markdown('Start here', 'This is your personal memory vault. Open this folder as a vault in Obsidian, or edit notes in Aurora.\n\n- [[10 Profile/About me|About me]] — preferences and context you want remembered\n- [[10 Profile/Assistant preferences|Assistant preferences]]\n- [[20 Projects/Example Project|Example Project]]\n- [[40 Tasks/Tasks|Tasks]]\n\nUse **Remember** for a fact, **New note** for knowledge, and **Today** for a daily note. Link notes with `[[note name]]`. Chat journals are history, not confirmed facts. Proposed memories are excluded from recall until you approve them.\n\nPinned notes are included in every conversation. Avoid putting passwords or tokens in your memory.', {kind:'guide',status:'reference'}),
      '10 Profile/About me.md': markdown('About me', 'This profile note is a template. Add details you want Aurora to remember.\n\n## Add your own context\n\nAdd your preferred name, current goals, interests, and constraints here when you are ready.\n\nRelated: [[Assistant preferences]]', {pinned:true,kind:'profile',status:'confirmed'}),
      '10 Profile/Assistant preferences.md': markdown('Assistant preferences', 'Help with everyday life, projects, learning, writing, and planning. Give practical next steps. Separate known facts from suggestions. Ask when important context is missing. Use my saved notes when relevant and cite the notes you used.\n\nMemory should be transparent and portable.\n\nRelated: [[About me]]', {pinned:true,kind:'profile',status:'confirmed'}),
      '20 Projects/Example Project.md': markdown('Example Project', 'This is an example project note. Replace it with a project you want Aurora to help with.\n\nProject directory: add a folder through your local configuration.\n\nReview project files before drawing conclusions about them.', {kind:'project',status:'reference',tags:['projects']}),
      '40 Tasks/Tasks.md': markdown('Tasks', 'Capture an actionable next step here, or use the task input in Aurora.\n\n## Tasks', {kind:'tasks',status:'confirmed'})
    };
    for (const [path, content] of Object.entries(seeds)) {
      const full = await this.safe(path);
      await writeFile(full, content, {flag:'wx',mode:0o600}).catch(e => { if(e.code !== 'EEXIST') throw e; });
    }
    await writeFile(join(this.root,'.obsidian/app.json'),JSON.stringify({alwaysUpdateLinks:true,newLinkFormat:'shortest',useMarkdownLinks:false},null,2),{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    await atomic(marker,'Vault initialized. Starter notes are never recreated automatically after this point.\n');
  }
  async safe(path, internal = false) {
    if (typeof path !== 'string' || !path || path.length > 220 || path.includes('\\') || /[\x00-\x1f]/.test(path) || path.startsWith('/') || !path.endsWith('.md')) throw new AppError('Choose a relative Markdown note path.');
    const parts = path.split('/');
    if(parts.some(p => !p || p === '..' || p === '.' || (!internal && p.startsWith('.')))) throw new AppError('That path is outside the note vault.');
    let current = this.root;
    for (const part of parts) {
      current = join(current,part);
      try { if((await lstat(current)).isSymbolicLink()) throw new AppError('Symbolic links are not supported in the vault.'); }
      catch(e) { if(e.code !== 'ENOENT') throw e; }
    }
    return current;
  }
  exclusive(fn) { const work = this.queue.then(fn); this.queue = work.catch(() => {}); return work; }
  async read(path) {
    const full = await this.safe(path);
    try {
      const stat = await lstat(full);
      if(!stat.isFile() || stat.size > 1024 * 512) throw new AppError('Notes must be text files smaller than 512 KB.');
      return parseNote(path, await readFile(full,'utf8'));
    } catch(e) { if(e.code === 'ENOENT') throw new AppError('Note not found.',404); throw e; }
  }
  async list() { return viewList(this,'notes',()=>this.readList()); }
  async readList() {
    const notes = [];
    const walk = async (dir, depth=0) => {
      if(depth > 12) return;
      for(const ent of await readdir(join(this.root,dir),{withFileTypes:true})) {
        if(ent.name.startsWith('.') || ent.isSymbolicLink()) continue;
        const path = dir ? `${dir}/${ent.name}` : ent.name;
        if(ent.isDirectory()) await walk(path, depth+1);
        else if(ent.isFile() && ent.name.endsWith('.md')) { try { notes.push(await this.read(path)); } catch(e) { if(![400,404].includes(e.status)) throw e; } }
      }
    };
    await walk(''); return notes.sort((a,b) => a.path.localeCompare(b.path));
  }
  async save(path, content, revision, {beforeCommit,taskSource} = {}) {
    return freshReads(()=>this.exclusive(async () => {
      if(typeof content !== 'string' || Buffer.byteLength(content) > 512*1024) throw new AppError('A note must be text smaller than 512 KB.');
      const full = await this.safe(path);
      let old; try { old = await this.read(path); } catch(e) { if(e.status !== 404) throw e; }
      if(old ? revision !== old.revision : revision != null) throw new AppError('This note changed outside this editor. Your draft is kept. Reload the note and merge your changes.',409);
      if(old && old.content !== content) await this.snapshot(old);
      const tracked=this.taskHistory&&(tasksIn(old?[old]:[]).length||tasksIn([parseNote(path,content)]).length);
      const receipt=tracked?await this.taskHistory.prepare(path,content,taskSource):null;
      await atomic(full,content,{beforeCommit:async()=>{let latest;try{latest=await this.read(path);}catch(e){if(e.status!==404)throw e;}if((latest?.revision??null)!==(old?.revision??null))throw new AppError('The note changed during saving. Refresh before retrying.',409);await beforeCommit?.();}});
      if(receipt)try{await this.taskHistory.committed(receipt);}catch(e){throw new AppError('The note was saved, but its task-history receipt is pending. Refresh task history before retrying. '+e.message,503);}
      return parseNote(path,content);
    }));
  }
  async snapshot(note) {
    const historyPath = `.aster/history/${sha(note.path)}/${Date.now()}-${randomUUID()}.md`;
    const full = await this.safe(historyPath,true);
    await atomic(full,note.content);
  }
  async history(path) {
    await this.safe(path);
    const dir = join(this.root,'.aster/history',sha(path));
    const entries = await readdir(dir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    return entries.filter(e=>/^\d+-[\w-]+\.md$/.test(e)).sort().reverse();
  }
  async version(path, id) {
    if(!/^\d+-[\w-]+\.md$/.test(id)) throw new AppError('Invalid version.');
    await this.safe(path);
    return readFile(await this.safe(`.aster/history/${sha(path)}/${id}`,true),'utf8');
  }
  async trash(path, revision) {
    return freshReads(()=>this.exclusive(async()=>{
      const note = await this.read(path);
      if(note.revision !== revision) throw new AppError('The note changed. Reload before moving it to trash.',409);
      await this.snapshot(note);
      const trashPath = `.aster/trash/${Date.now()}-${randomUUID()}-${basename(path)}`;
      const receipt=tasksIn([note]).length?await this.taskHistory?.prepare(path,null):null;
      await rename(await this.safe(path),await this.safe(trashPath,true));
      if(receipt)try{await this.taskHistory.committed(receipt);}catch(e){throw new AppError('The note was moved to trash, but its task-history receipt is pending. Refresh task history. '+e.message,503);}
      return {trashed: path, recovery: trashPath};
    }));
  }
  async daily() {
    const path = `50 Daily/${today()}.md`;
    try { return await this.read(path); } catch(e) { if(e.status!==404) throw e; }
    return this.save(path, markdown(today(),'## Focus\n\nWhat matters most today?\n\n## Notes\n\n\n## Reflection\n\nRelated: [[Tasks]]',{kind:'daily',status:'confirmed'}),null);
  }
  async tasks() { return tasksIn(await this.list()); }
  async addTask(text,options={}) {
    const line=taskLine(text,options);let n;
    try{n=await this.read('40 Tasks/Tasks.md');}catch(e){if(e.status!==404)throw e;n={path:'40 Tasks/Tasks.md',content:markdown('Tasks','## Tasks',{kind:'tasks',status:'confirmed'}),revision:null};}
    const content=`${n.content.trimEnd()}\n- [ ] ${line}\n`;
    const verify=async()=>{const notes=await this.list(),next=parseNote(n.path,content),tasks=tasksIn([...notes.filter(x=>x.path!==n.path),next]),task=tasksIn([next]).at(-1);validateTaskLinks(tasks,task,notes);};
    await verify();return this.save(n.path,content,n.revision,{beforeCommit:verify});
  }
  async scheduleTask({path,line,revision,requireReady=false,...changes}) {
    const n=await this.read(path);if(n.revision!==revision)throw new AppError('Tasks changed. Close this editor and reopen the task to review its current schedule.',409);
    const task=tasksIn([n]).find(t=>t.line===line);if(!task)throw new AppError('Task not found.',404);
    if(task.scheduleError)throw new AppError('This task has invalid scheduling metadata. Fix it in the Markdown note first.');
    const lines=n.content.split('\n');lines[line]=lines[line].replace(/^(\s*[-*] \[[ xX]\] ).+$/,(_,prefix)=>prefix+taskLine(changes.text??task.text,{...task,...changes},task.id||undefined));
    const content=lines.join('\n'),changed=['project','parent','dependsOn'].some(k=>Object.hasOwn(changes,k)&&JSON.stringify(changes[k]??null)!==JSON.stringify(task[k]??null));
    const verify=async()=>{const notes=await this.list(),next=parseNote(path,content),tasks=tasksIn([...notes.filter(x=>x.path!==path),next]),after=tasksIn([next]).find(t=>t.line===line);validateTaskLinks(tasks,after,notes,{changed,requireReady});};
    await verify();return this.save(path,content,revision,{beforeCommit:verify});
  }
  async toggleTask(path,line,revision,done) {
    const n=await this.read(path); if(n.revision!==revision) throw new AppError('Tasks changed. Refresh and try again.',409);
    const lines=n.content.split('\n');
    if(!Number.isInteger(line) || !/^\s*[-*] \[[ xX]\] /.test(lines[line]||'') || typeof done!=='boolean') throw new AppError('Task not found.');
    lines[line]=lines[line].replace(/\[[ xX]\]/,done?'[x]':'[ ]');
    return this.save(path,lines.join('\n'),revision);
  }
}

const stop = new Set('the a an to of and or is are my me i you your what how do does can could would should please about with for from in on it this that tell help want need remember'.split(' '));
export const tokens = value => String(value).toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)?.filter(t => !stop.has(t)) || [];
export function chunks(text,size=1600){
  const out=[];for(let i=0;i<text.length;i+=size-160)out.push(text.slice(i,i+size));return out.length?out:[''];
}
export function resolveLink(link, notes, from='') {
  const clean = link.replace(/\.md$/i,'');
  const exact = notes.find(n => n.path.slice(0,-3).toLowerCase()===clean.toLowerCase());
  if(exact) return exact.path;
  const relative = posix.normalize(posix.join(posix.dirname(from),clean));
  const same = notes.find(n=>n.path.slice(0,-3).toLowerCase()===relative.toLowerCase());
  if(same) return same.path;
  const matches = notes.filter(n=>basename(n.path,'.md').toLowerCase()===clean.toLowerCase() || n.title.toLowerCase()===clean.toLowerCase() || n.aliases?.some(a=>a.toLowerCase()===clean.toLowerCase()));
  return matches.length===1 ? matches[0].path : null;
}
export function retrieve(notes, query, limit=7, budget=14000, semantic=new Map()) {
  const available=notes.filter(n=>n.kind!=='memory-correction' && !['draft','journal','archived'].includes(n.status) && !n.path.startsWith('99 Archive/')&&!n.path.startsWith('70 Skills/'));
  const terms=[...new Set(tokens(query))];
  const docs=available.map(n=>({n,words:tokens(`${n.title} ${n.tags.join(' ')} ${n.body}`)}));
  const avg=docs.reduce((a,d)=>a+d.words.length,0)/Math.max(1,docs.length);
  const scored=docs.map(({n,words})=>{
    let score=0;
    for(const t of terms) {
      const tf=words.filter(w=>w===t).length;
      const df=docs.filter(d=>d.words.includes(t)).length;
      const idf=Math.log(1+(docs.length-df+0.5)/(df+0.5));
      score+=idf*tf*2.2/(tf+1.2*(0.25+0.75*words.length/(avg||1)));
      if(tokens(n.title).includes(t)) score+=2;
      if(n.tags.includes(t)) score+=1.5;
    }
    const meaning=semantic.get(n.path);
    if(meaning?.score>0.3)score+=(meaning.score-0.3)*12;
    return {...n,score,semantic:meaning};
  }).sort((a,b)=>b.score-a.score || a.path.localeCompare(b.path));
  const chosen=[...scored.filter(n=>n.pinned),...scored.filter(n=>!n.pinned&&n.score>0).slice(0,limit)];
  for(const n of [...chosen]) for(const link of n.links) {
    const path=resolveLink(link,available,n.path);
    const next=scored.find(x=>x.path===path);
    if(next && chosen.length<limit+2 && !chosen.some(x=>x.path===path)) chosen.push({...next,linked:true});
  }
  let remaining=budget;
  return chosen.filter((n,i,a)=>a.findIndex(x=>x.path===n.path)===i).slice(0,limit+2).flatMap(n=>{
    if(remaining<100) return [];
    const ranked=chunks(n.body,1000).map((text,index)=>({text,index,score:terms.reduce((s,t)=>s+tokens(text).filter(w=>w===t).length,0)})).sort((a,b)=>b.score-a.score||a.index-b.index);
    const excerpt=(n.body.length<=2200?n.body:n.semantic?.score>0.3?n.semantic.text:ranked.slice(0,2).sort((a,b)=>a.index-b.index).map(c=>c.text).join('\n[…]\n')).slice(0,Math.min(2400,remaining));
    remaining-=excerpt.length;
    return [{path:n.path,title:n.title,excerpt,revision:n.revision,source:n.source,pinned:n.pinned,linked:!!n.linked,status:n.status,score:n.score}];
  }).map((n,i)=>({...n,id:`M${i+1}`}));
}
