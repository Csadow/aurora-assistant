import {readFile} from 'node:fs/promises';
import {atomic} from '../src/vault.mjs';

export function quickBounds(value,area){
  const width=Math.min(value.width,area.width),height=Math.min(value.height,area.height);
  const x=Number.isFinite(value.position?.x)?value.position.x:area.x+(area.width-width)/2;
  const y=Number.isFinite(value.position?.y)?value.position.y:area.y+(area.height-height)/2;
  return {width,height,x:Math.round(Math.max(area.x,Math.min(x,area.x+area.width-width))),y:Math.round(Math.max(area.y,Math.min(y,area.y+area.height-height)))};
}
export class QuickWindowSettings{
  constructor(file){this.file=file;this.value={width:460,height:680,position:null};this.queue=Promise.resolve();}
  async init(){
    try{const v=JSON.parse(await readFile(this.file,'utf8'));
      for(const [key,min] of [['width',340],['height',360]])if(Number.isInteger(v[key])&&v[key]>=min&&v[key]<=8000)this.value[key]=v[key];
      if(v.position&&['x','y'].every(k=>Number.isFinite(v.position[k])&&Math.abs(v.position[k])<100000))this.value.position={x:v.position.x,y:v.position.y,monitor:String(v.position.monitor||'').slice(0,100)};
    }catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
  }
  async remember(bounds,monitor=''){
    const next={width:Math.round(bounds.width),height:Math.round(bounds.height),position:{x:Math.round(bounds.x),y:Math.round(bounds.y),monitor}};
    if(JSON.stringify(next)===JSON.stringify(this.value))return;
    this.value=next;const content=JSON.stringify(next);
    const job=this.queue.then(()=>atomic(this.file,content));this.queue=job.catch(()=>{});await job;
  }
}
