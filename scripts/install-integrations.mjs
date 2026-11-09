import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
const home=homedir(),root=fileURLToPath(new URL('../',import.meta.url));
const file=join(home,'.config/hypr/custom/keybinds.lua');let content=await readFile(file,'utf8');
if(!content.includes('-- Aurora quick access')){await copyFile(file,file+'.before-aurora');content+=`\n-- Aurora quick access\nhl.bind("CTRL + SUPER + A", hl.dsp.exec_cmd('/usr/bin/node "${join(root,'scripts/start-desktop.mjs')}" --quick'), {description = "Aurora: Quick ask"})\nhl.bind("SUPER + ALT + V", hl.dsp.exec_cmd('/usr/bin/node "${join(root,'scripts/start-desktop.mjs')}" --voice'), {description = "Aurora: Talk"})\n`;await writeFile(file,content);}
if(!content.includes('-- Aurora arrange shortcut')){await copyFile(file,file+'.before-arrange');content+=`
-- Aurora arrange shortcut
hl.bind("CTRL + SUPER + M", hl.dsp.exec_cmd('/usr/bin/node "${join(root,'scripts/start-desktop.mjs')}" --arrange'), {description = "Aurora: Move / resize"})
`;await writeFile(file,content);}
if(!content.includes('-- Aurora emergency control pause')){await copyFile(file,file+'.before-control');content+=`
-- Aurora emergency control pause
hl.bind("CTRL + SUPER + Escape", hl.dsp.exec_cmd('/usr/bin/node "${join(root,'scripts/start-desktop.mjs')}" --pause-control --background'), {description = "Aurora: Pause computer control"})
`;await writeFile(file,content);}
for(const [name,block] of [['execs.lua',`\n-- Aurora login listener\nhl.on("hyprland.start", function()\n  hl.exec_cmd('/usr/bin/node "${join(root,'scripts/start-desktop.mjs')}" --background')\nend)\n`]]){const path=join(home,'.config/hypr/custom',name);let value='';try{value=await readFile(path,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(!value.includes('-- Aurora ')){if(value)await copyFile(path,path+'.before-aurora');await writeFile(path,value+block);}}
await mkdir(join(home,'.config/autostart'),{recursive:true});await writeFile(join(home,'.config/autostart/aurora-listener.desktop'),`[Desktop Entry]\nType=Application\nName=Aurora voice listener\nComment=Local wake listening and quick access\nExec=/usr/bin/node "${join(root,'scripts/start-desktop.mjs')}" --background\nIcon=${join(root,'public/icon.svg')}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
const desktop=join(home,'.local/share/applications/aurora-assistant.desktop');let entry=await readFile(desktop,'utf8');if(!entry.includes('Actions=QuickAsk;Voice;')){entry+=`Actions=QuickAsk;Voice;\n\n[Desktop Action QuickAsk]\nName=Quick ask\nExec=/usr/bin/node "${join(root,'scripts/start-desktop.mjs')}" --quick\n\n[Desktop Action Voice]\nName=Talk to Aurora\nExec=/usr/bin/node "${join(root,'scripts/start-desktop.mjs')}" --voice\n`;await writeFile(desktop,entry);}
console.log('Installed quick-access shortcuts, application actions, and login wake listener. Existing keybindings have a .before-aurora backup.');

const companionRules=join(home,'.config/hypr/custom/rules.lua');let companionConfig='';try{companionConfig=await readFile(companionRules,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
const lines=companionConfig.split('\n'),retained=[];
for(let i=0;i<lines.length;i++){if(/^-- Aurora (quick window|companion window|floating model window|desktop overlay|idle overlay input)$/.test(lines[i])&&lines[i+1]?.includes('hl.window_rule')&&lines[i+1].includes('Aurora')){i++;continue;}retained.push(lines[i]);}
const nextRules=retained.join('\n').trimEnd()+`

-- Aurora desktop overlay
hl.window_rule({match = {class = "^aurora-assistant$", title = "^Aurora · (Companion|Overlay|Arrange)$"}, float = true, pin = true, border_size = 0, rounding = 0, no_shadow = true, no_blur = true, no_anim = true})
-- Aurora idle overlay input
hl.window_rule({match = {class = "^aurora-assistant$", title = "^Aurora · Overlay$"}, no_focus = true})
-- Aurora quick window
hl.window_rule({match = {class = "^aurora-assistant$", title = "^Aurora · Quick ask$"}, float = true, pin = true, border_size = 0, rounding = 0, no_shadow = true, no_blur = true, no_anim = true})
`;
if(nextRules!==companionConfig){if(companionConfig)await copyFile(companionRules,companionRules+'.before-model-view');await writeFile(companionRules,nextRules);}
