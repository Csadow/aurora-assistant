// Deterministic Google API substitute. No real credentials or external requests.
export function googleFixture(){
 const events=new Map(),calls=[];let count=0;const state={offline:false,loseReply:null,beforeWrite:null,pages:false};
 const calendar='personal@example.test',other='readonly@example.test';
 const put=(e,id=e.id||'event'+(++count))=>{const value={...structuredClone(e),id,etag:'"v'+(++count)+'"'};events.set(id,value);return value;};
 const fetchImpl=async(url,options={})=>{
  const u=new URL(url),method=options.method||'GET',body=options.body&&JSON.parse(options.body);calls.push({path:u.pathname,search:u.search,method,body,headers:options.headers});
  if(state.offline)throw Error('offline');
  const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
  if(u.pathname==='/calendar/v3/users/me/calendarList')return json({items:[{id:calendar,summary:'Personal',accessRole:'owner',primary:true},{id:other,summary:'Read only',accessRole:'reader'}]});
  const match=u.pathname.match(/\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);if(!match)throw Error('Unexpected fixture path: '+u.pathname);
  const id=match[2]&&decodeURIComponent(match[2]);
  if(method==='GET'){
   if(id)return events.has(id)?json(events.get(id)):json({},404);
   const all=[...events.values()].filter(e=>e.status!=='cancelled');
   if(state.pages&&!u.searchParams.has('pageToken'))return json({items:all.slice(0,1),nextPageToken:'second'});
   return json({items:state.pages?all.slice(1):all});
  }
  await state.beforeWrite?.({id,method,body});
  if(options.headers['If-Match']&&options.headers['If-Match']!==events.get(id)?.etag)return json({},412);
  let result;
  if(method==='POST'){if(events.has(body.id))return json({},409);result=put(body,body.id);}
  else if(method==='PATCH'){if(!events.has(id))return json({},404);result=put({...events.get(id),...body},id);}
  else if(method==='DELETE'){events.delete(id);result=null;}
  else throw Error('Unexpected method');
  if(state.loseReply===method){state.loseReply=null;throw Error('response lost after commit');}
  return result?json(result):new Response(null,{status:204});
 };
 return {events,calls,state,calendar,other,fetchImpl,put,writes:()=>calls.filter(c=>c.method!=='GET')};
}
