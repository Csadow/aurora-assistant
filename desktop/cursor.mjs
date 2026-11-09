import {createConnection} from 'node:net';
import {join} from 'node:path';

// Hyprland and its clients use logical desktop coordinates, including display scale.
// Read the local socket directly: no screenshot, input interception, or subprocess per frame.
export function readHyprland(command,{socketPath,signal,timeout=750}={}){
  if(!['cursorpos','clients'].includes(command))throw new Error('Unsupported cursor query.');
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(signal.reason);
    const socket=createConnection(socketPath);let data='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.destroy();error?reject(error):resolve(value);};
    const abort=()=>finish(signal.reason||new Error('Cursor query stopped.'));
    const timer=setTimeout(()=>finish(new Error('Cursor query timed out.')),timeout);
    signal?.addEventListener('abort',abort,{once:true});
    socket.setEncoding('utf8');socket.once('connect',()=>socket.write('j/'+command));
    socket.on('data',chunk=>{data+=chunk;if(data.length>1024*1024)finish(new Error('Cursor response too large.'));});
    socket.once('error',error=>finish(error));
    socket.once('end',()=>{try{finish(null,JSON.parse(data));}catch(error){finish(error);}});
  });
}

export function relativeCursor(point,bounds){
  if(!point||!bounds||![point.x,point.y,bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite)||bounds.width<=0||bounds.height<=0)return null;
  // Keep off-window coordinates: the companion also looks towards other applications.
  return {x:(point.x-bounds.x)/bounds.width,y:(point.y-bounds.y)/bounds.height};
}

export function cursorSource({hyprland,screen,env=process.env,read=readHyprland}){
  const socketPath=hyprland?join(env.XDG_RUNTIME_DIR||`/run/user/${process.getuid()}`,'hypr',env.HYPRLAND_INSTANCE_SIGNATURE,'.socket.sock'):null;
  let cached,checked=0;
  return async(window,signal)=>{
    if(!hyprland){
      // Other Wayland compositors don't expose desktop coordinates through Electron.
      if(env.WAYLAND_DISPLAY)return null;
      return relativeCursor(screen.getCursorScreenPoint(),window.getBounds());
    }
    const title=window.getTitle(),now=Date.now();
    if(!cached||cached.title!==title||now-checked>250){
      const clients=await read('clients',{socketPath,signal});
      const client=clients.find(c=>c.pid===process.pid&&c.title===title&&c.mapped!==false&&!c.hidden);
      cached=client?{title,x:client.at?.[0],y:client.at?.[1],width:client.size?.[0],height:client.size?.[1]}:null;checked=now;
    }
    if(!cached)return null;
    const point=await read('cursorpos',{socketPath,signal});
    return relativeCursor(point,cached);
  };
}

export class CompanionCursor{
  constructor({sample,send,active,interval=50,onError=()=>{}}){Object.assign(this,{sample,send,active,interval,onError});this.controller=null;}
  start(){
    if(this.controller)return;
    const controller=this.controller=new AbortController();let previous,failed=false;
    const tick=async()=>{
      let delay=this.interval;
      try{
        if(!this.active()){this.stop();return;}
        const point=await this.sample(controller.signal);
        if(controller.signal.aborted||!this.active())return;
        const serialized=JSON.stringify(point);
        if(serialized!==previous){this.send(point);previous=serialized;}
        failed=false;
      }catch(error){
        if(!controller.signal.aborted){this.send(null);previous=undefined;if(!failed)this.onError(error);failed=true;delay=1000;}
      }finally{if(!controller.signal.aborted)this.timer=setTimeout(tick,delay);}
    };
    tick();
  }
  stop(){this.controller?.abort();this.controller=null;clearTimeout(this.timer);}
}
