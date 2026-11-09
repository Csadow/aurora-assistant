import http from 'node:http';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {atomic,AppError} from './vault.mjs';

export const GOOGLE_SCOPES=['https://www.googleapis.com/auth/calendar.calendarlist.readonly','https://www.googleapis.com/auth/calendar.events'];
const TOKEN='https://oauth2.googleapis.com/token';
export class GoogleOAuth {
 constructor({data,fetchImpl=fetch,now=()=>Date.now()}){this.file=join(data,'google-calendar-auth.json');this.fetch=fetchImpl;this.now=now;this.value={};this.error=null;this.generation=0;}
 async init(){try{this.value=JSON.parse(await readFile(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
 status(){return {configured:!!this.value.client,connected:!!this.value.tokens?.refresh_token,connecting:!!this.pending,error:this.error};}
 async configure(document){
  if(this.value.tokens||this.pending)throw new AppError('Disconnect Google before replacing the desktop client.');
  const c=document?.installed;
  if(!c||typeof c.client_id!=='string'||!c.client_id.endsWith('.apps.googleusercontent.com')||c.client_id.length>250||typeof c.client_secret!=='string'||!c.client_secret||c.client_secret.length>250)throw new AppError('Choose a Google OAuth client JSON file with application type Desktop app.');
  this.value={client:{client_id:c.client_id,client_secret:c.client_secret}};await this.save();return this.status();
 }
 async save(){await atomic(this.file,JSON.stringify(this.value));}
 close(){this.generation++;if(this.pending){clearTimeout(this.pending.timer);this.pending.server.close();this.pending=null;}}
 async disconnect(){this.close();this.value={client:this.value.client};this.error=null;await this.save();}
 async exchange(fields){
  let r;try{r=await this.fetch(TOKEN,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...this.value.client,...fields})});}catch{throw new AppError('Google sign-in is unreachable. Check your connection and try again.',503);}
  if(!r.ok)throw new AppError('Google authorization expired or was rejected. Connect Google again.',401);
  const t=await r.json();if(!t.access_token||!Number.isFinite(t.expires_in)||t.expires_in<=0)throw new AppError('Google returned an incomplete authorization response.',502);
  if(t.scope&&!GOOGLE_SCOPES.every(s=>t.scope.split(' ').includes(s)))throw new AppError('Both calendar permissions are needed. Connect again and grant them, or leave sync disconnected.',403);
  return t;
 }
 async connect(){
  if(!this.value.client)throw new AppError('Add a Google Desktop app client JSON file first.');
  this.close();this.error=null;const generation=this.generation;
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
  const server=http.createServer(async(req,res)=>{
   const reply=(status,text)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'"});res.end(text);};
   const u=new URL(req.url,'http://127.0.0.1');const supplied=Buffer.from(u.searchParams.get('state')||''),expected=Buffer.from(state);
   if(req.method!=='GET'||req.headers.host!==`127.0.0.1:${server.address()?.port}`||u.pathname!=='/callback'||!this.pending||generation!==this.generation||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply(400,'Invalid or expired sign-in. Return to Aurora.');
   const pending=this.pending;clearTimeout(pending.timer);this.pending=null;server.close();
   try{
    if(u.searchParams.has('error')||!u.searchParams.get('code'))throw new AppError('Google sign-in was cancelled.');
    const tokens=await this.exchange({grant_type:'authorization_code',code:u.searchParams.get('code'),redirect_uri:pending.redirect,code_verifier:verifier});
    if(generation!==this.generation)throw new AppError('Sign-in was cancelled in Aurora.');
    if(!tokens.refresh_token)throw new AppError('Google did not grant offline access. Reconnect and approve access.');
    this.value.tokens={...tokens,expiresAt:this.now()+tokens.expires_in*1000};await this.save();this.error=null;reply(200,'Google Calendar connected. Close this tab and return to Aurora, then choose Refresh connection.');
   }catch(e){if(generation===this.generation)this.error=e.status?e.message:'Unable to save Google authorization. Try connecting again.';reply(400,'Sign-in did not finish. Return to Aurora for details.');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});server.unref();
  const redirect=`http://127.0.0.1:${server.address().port}/callback`;
  const timer=setTimeout(()=>{if(this.pending?.server===server){this.close();this.error='Google sign-in timed out. Try again.';}},600000);timer.unref();
  this.pending={server,timer,redirect};
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.search=new URLSearchParams({client_id:this.value.client.client_id,redirect_uri:redirect,response_type:'code',scope:GOOGLE_SCOPES.join(' '),access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  return {url:url.href};
 }
 async access(){
  if(!this.value.tokens?.refresh_token)throw new AppError('Connect Google Calendar first.',401);
  if(this.value.tokens.expiresAt>this.now()+60000)return this.value.tokens.access_token;
  if(!this.refreshing)this.refreshing=(async()=>{const generation=this.generation,t=await this.exchange({grant_type:'refresh_token',refresh_token:this.value.tokens.refresh_token});if(generation!==this.generation)throw new AppError('Google was disconnected.',409);this.value.tokens={...this.value.tokens,...t,expiresAt:this.now()+t.expires_in*1000};await this.save();return t.access_token;})().finally(()=>{this.refreshing=null;});
  return this.refreshing;
 }
 async request(path,{method='GET',body,etag,allowMissing=false}={}){
  if(!path.startsWith('/'))throw new AppError('Invalid Calendar API path.');
  const token=await this.access();let r;
  try{r=await this.fetch('https://www.googleapis.com/calendar/v3'+path,{method,redirect:'error',signal:AbortSignal.timeout(25000),headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{}),...(etag?{'If-Match':etag}:{})},...(body?{body:JSON.stringify(body)}:{})});}catch{throw new AppError('Google Calendar could not be reached. A write may have finished; retry this same review to reconcile it.',503);}
  if(allowMissing&&[404,410].includes(r.status))return null;
  if(r.status===412)throw new AppError('This Google event changed after your review. Prepare a fresh review.',409);
  if(r.status===401){this.value.tokens.expiresAt=0;throw new AppError('Google authorization needs refreshing. Try again or reconnect.',401);}
  if(!r.ok)throw new AppError(r.status===429?'Google Calendar rate limit reached. Wait and try again.':`Google Calendar request failed (${r.status}). Check access or retry.`,r.status===409?409:503);
  return r.status===204?null:r.json();
 }
}
