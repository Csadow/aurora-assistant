import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
export const hyprland=!!(process.env.WAYLAND_DISPLAY&&process.env.HYPRLAND_INSTANCE_SIGNATURE);

export function monitorArea(m){
  const rotated=m.transform%2===1;
  const width=Math.round((rotated?m.height:m.width)/m.scale),height=Math.round((rotated?m.width:m.height)/m.scale);
  const [left,top,right,bottom]=m.reserved||[0,0,0,0];
  return {x:m.x+left,y:m.y+top,width:width-left-right,height:height-top-bottom};
}
export async function desktopWindow(title){
  const {stdout}=await run('hyprctl',['clients','-j'],{timeout:1500,maxBuffer:1024*1024});
  const client=JSON.parse(stdout).find(c=>c.pid===process.pid&&c.title===title&&c.floating);
  if(!client||!/^0x[0-9a-f]+$/i.test(client.address))return null;
  const {stdout:monitors}=await run('hyprctl',['monitors','-j'],{timeout:1500,maxBuffer:1024*1024});
  const displays=JSON.parse(monitors),monitor=displays.find(m=>m.id===client.monitor);
  if(!monitor)return null;
  return {client,monitor,displays,bounds:{x:client.at[0],y:client.at[1],width:client.size[0],height:client.size[1]}};
}
export async function placeDesktopWindow(client,title,{x,y,width,height}){
  // An address alone can be recycled. Check our PID and exact title again in the compositor.
  const code=`local w=hl.get_window("address:${client.address}"); if w and w.pid==${process.pid} and w.title==${JSON.stringify(title)} then hl.dispatch(hl.dsp.window.resize({x=${width},y=${height},window=w})); hl.dispatch(hl.dsp.window.move({x=${x},y=${y},window=w})); end`;
  await run('hyprctl',['eval',code],{timeout:1500,maxBuffer:16384});
}
