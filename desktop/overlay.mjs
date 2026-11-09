import {readFile} from 'node:fs/promises';
import {atomic} from '../src/vault.mjs';

export function overlaySize(height,area){
  const h=Math.max(240,Math.min(Math.round(height),area.height-24));
  return {height:h,width:Math.min(Math.round(h*.56),area.width)};
}
export function overlayBounds(size,area,position){
  const right=Number.isFinite(position?.right)?position.right:area.x+area.width-16;
  const top=Number.isFinite(position?.top)?position.top:area.y+area.height-size.height-16;
  // Allow the character to extend beyond every edge; retain a reachable patch
  // for Arrange controls and recovery after a monitor is disconnected.
  const visibleX=Math.min(96,size.width,area.width),visibleY=Math.min(96,size.height,area.height);
  return {...size,x:Math.round(Math.max(area.x-size.width+visibleX,Math.min(right-size.width,area.x+area.width-visibleX))),y:Math.round(Math.max(area.y-size.height+visibleY,Math.min(top,area.y+area.height-visibleY)))};
}
export function overlayViewport(bounds,area){
  const left=Math.max(bounds.x,area.x),top=Math.max(bounds.y,area.y);
  return {x:left-bounds.x,y:top-bounds.y,width:Math.max(0,Math.min(bounds.x+bounds.width,area.x+area.width)-left),height:Math.max(0,Math.min(bounds.y+bounds.height,area.y+area.height)-top)};
}
export class OverlaySettings{
  constructor(file){this.file=file;this.value={height:920,position:null};this.queue=Promise.resolve();}
  async init(){try{const v=JSON.parse(await readFile(this.file,'utf8'));if(Number.isInteger(v.height)&&v.height>=240&&v.height<=1200)this.value.height=v.height;if(v.position&&['right','top'].every(k=>Number.isFinite(v.position[k])&&Math.abs(v.position[k])<100000))this.value.position={right:v.position.right,top:v.position.top,monitor:String(v.position.monitor||'').slice(0,100)};}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}}
  save(){const content=JSON.stringify(this.value);const job=this.queue.then(()=>atomic(this.file,content));this.queue=job.catch(()=>{});return job;}
  async resize(height){if(!Number.isInteger(height)||height<240||height>1200)throw new Error('Choose a character height from 240 to 1200 pixels.');this.value.height=height;await this.save();}
  async remember(bounds,monitor=''){const next={right:Math.round(bounds.x+bounds.width),top:Math.round(bounds.y),monitor};if(JSON.stringify(next)!==JSON.stringify(this.value.position)){this.value.position=next;await this.save();}}
}
