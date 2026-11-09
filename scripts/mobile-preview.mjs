import http from 'node:http';
import {readFile} from 'node:fs/promises';
const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/core.js':'core.js','/tasks.js':'tasks.js','/timetable.js':'timetable.js','/calendar-options.js':'calendar-options.js','/task-links.js':'task-links.js','/planner-core.js':'planner-core.js','/planner.js':'planner.js','/storage.js':'storage.js','/style.css':'style.css'};
export function previewServer(){return http.createServer(async(req,res)=>{
  const host=`127.0.0.1:${res.socket.localPort}`;
  if(req.headers.host!==host || req.method!=='GET'){res.writeHead(403);return res.end();}
  const file=files[req.url];if(!file){res.writeHead(404);return res.end();}
  const content=await readFile(new URL('../mobile/web/'+file,import.meta.url));
  res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(content);
});}
if(process.argv[1]===new URL(import.meta.url).pathname){const server=previewServer();server.listen(4720,'127.0.0.1',()=>console.log('Aurora Mobile preview: http://127.0.0.1:4720 · isolated from desktop memory'));}
