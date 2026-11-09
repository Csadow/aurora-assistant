import http from 'node:http';
import {createHash,createPublicKey,randomBytes,randomUUID,timingSafeEqual,verify} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {atomic,AppError} from './vault.mjs';

const issuer='https://auth.openai.com';
const resource='https://api.openai.com/v1';
const scope='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const b64=()=>randomBytes(32).toString('base64url');
const same=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
const fail=message=>new AppError(message,401);
export async function verifyIdentity(jwt,{clientId,nonce,fetchImpl=fetch,now=Date.now()}){
 const parts=String(jwt||'').split('.');if(parts.length!==3)throw fail('ChatGPT returned an invalid identity token.');
 let header,claims;try{header=JSON.parse(Buffer.from(parts[0],'base64url'));claims=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{throw fail('ChatGPT returned an invalid identity token.');}
 if(header.alg!=='RS256'||typeof header.kid!=='string'||!header.kid)throw fail('ChatGPT identity signing format is unsupported.');
 const discovery=await fetchImpl(issuer+'/.well-known/openid-configuration',{redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!discovery.ok)throw new AppError('ChatGPT identity verification is unavailable. Try again.',503);
 const meta=await discovery.json();if(meta.issuer!==issuer||typeof meta.jwks_uri!=='string'||!meta.jwks_uri.startsWith(issuer+'/'))throw fail('ChatGPT identity metadata did not match the expected issuer.');
 const keysResponse=await fetchImpl(meta.jwks_uri,{redirect:'error',signal:AbortSignal.timeout(15000)});if(!keysResponse.ok)throw new AppError('ChatGPT signing keys are unavailable. Try again.',503);
 const jwk=(await keysResponse.json()).keys?.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(k.use===undefined||k.use==='sig'));
 if(!jwk||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw fail('ChatGPT identity signature could not be verified.');
 if(claims.iss!==issuer||!(claims.aud===clientId||Array.isArray(claims.aud)&&claims.aud.includes(clientId))||Array.isArray(claims.aud)&&claims.aud.length>1&&claims.azp!==clientId||typeof claims.sub!=='string'||!claims.sub||claims.nonce!==nonce||!Number.isFinite(claims.exp)||claims.exp*1000<now-5000||!Number.isFinite(claims.iat)||claims.iat*1000>now+5000)throw fail('ChatGPT identity did not match this sign-in attempt.');
 return {subject:claims.sub,email:typeof claims.email==='string'?claims.email:'',name:typeof claims.name==='string'?claims.name:''};
}
export class ChatGPTPlan {
 constructor({data,fetchImpl=fetch,now=()=>Date.now()}){this.file=join(data,'chatgpt-plan-auth.json');this.fetch=fetchImpl;this.now=now;this.value={hostId:null,active:null,accounts:{}};this.pending=null;this.error=null;this.generation=0;this.refreshing=null;}
 async init(){try{const saved=JSON.parse(await readFile(this.file,'utf8'));if(saved?.hostId&&saved?.accounts)this.value=saved;}catch(e){if(e.code!=='ENOENT')throw e;}}
 async save(){await atomic(this.file,JSON.stringify(this.value,null,2));}
 active(){return this.value.accounts[this.value.active]||null;}
 status(){const a=this.active(),reconnectRequired=!!a?.reconnectRequired;return {connected:!!a?.refreshToken&&!reconnectRequired,reconnectRequired,connecting:!!this.pending,error:this.error||(reconnectRequired?'ChatGPT session expired. Reconnect this account in Settings.':null),account:a?{clientId:a.clientId,email:a.email,name:a.name,subject:a.subject,model:a.model||''}:null,accounts:Object.values(this.value.accounts).map(v=>({clientId:v.clientId,email:v.email,name:v.name,connected:!!v.refreshToken&&!v.reconnectRequired,active:v.clientId===this.value.active}))};}
 close(){this.generation++;if(this.pending){clearTimeout(this.pending.timer);this.pending.server.close();this.pending=null;}}
 async connect(clientId){
  this.close();this.error=null;const generation=this.generation,existing=clientId?this.value.accounts[clientId]:null;
  if(clientId&&!existing)throw new AppError('Choose a saved ChatGPT account.');
  if(!this.value.hostId){this.value.hostId='urn:uuid:'+randomUUID();await this.save();}
  const state=b64(),nonce=b64(),verifier=randomBytes(48).toString('base64url');
  const server=http.createServer(async(req,res)=>{
   const reply=(status,text)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'"});res.end(text);};
   const u=new URL(req.url,'http://127.0.0.1');
   if(req.method!=='GET'||req.headers.host!==`127.0.0.1:${server.address()?.port}`||u.pathname!=='/auth/callback'||!this.pending||generation!==this.generation||!same(u.searchParams.get('state'),state))return reply(400,'Invalid or expired ChatGPT sign-in. Return to Aurora.');
   const pending=this.pending;clearTimeout(pending.timer);this.pending=null;server.close();
   try{
    if(u.searchParams.has('error')||!u.searchParams.get('code'))throw fail('ChatGPT sign-in was cancelled or declined.');
    const issued=existing?existing.clientId:u.searchParams.get('client_id');
    if(!issued||issued==='dynamic_agent_client'||existing&&u.searchParams.has('client_id')&&u.searchParams.get('client_id')!==existing.clientId)throw fail('ChatGPT registration did not return the expected client.');
    const tokens=await this.exchange({grant_type:'authorization_code',client_id:issued,code:u.searchParams.get('code'),code_verifier:verifier,redirect_uri:pending.redirect,resource});
    const identity=await verifyIdentity(tokens.id_token,{clientId:issued,nonce,fetchImpl:this.fetch,now:this.now()});
    if(existing&&existing.subject!==identity.subject)throw fail('A different ChatGPT account was selected. The saved account is unchanged.');
    if(!tokens.scope?.split(' ').includes('chatgpt.tokens.use.direct')||!tokens.refresh_token)throw fail('ChatGPT plan use was not granted for Aurora.');
    if(generation!==this.generation)throw fail('ChatGPT sign-in was cancelled in Aurora.');
    const next={...existing,clientId:issued,...identity,idToken:tokens.id_token,accessToken:tokens.access_token,refreshToken:tokens.refresh_token,scopes:tokens.scope.split(' '),expiresAt:this.now()+tokens.expires_in*1000,model:existing?.model||'',reconnectRequired:false};
    this.value.accounts[issued]=next;this.value.active=issued;await this.save();this.error=null;reply(200,'ChatGPT connected to Aurora. Return to Aurora and refresh the connection.');
   }catch(e){if(generation===this.generation)this.error=e.status?e.message:'ChatGPT sign-in could not be verified. Try again.';reply(400,'ChatGPT sign-in did not finish. Return to Aurora for details.');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});server.unref();
  const redirect=`http://127.0.0.1:${server.address().port}/auth/callback`;
  const timer=setTimeout(()=>{if(this.pending?.server===server){this.close();this.error='ChatGPT sign-in timed out. Try again.';}},600000);timer.unref();this.pending={server,timer,redirect};
  const url=new URL(issuer+'/api/accounts/authorize');url.search=new URLSearchParams({client_id:existing?.clientId||'dynamic_agent_client',...(existing?{}:{agent_name_hint:'Aurora'}),ext_agent_host_id:this.value.hostId,response_type:'code',redirect_uri:redirect,scope,resource,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),...(existing?.idToken?{id_token_hint:existing.idToken}:{}),...(existing?.email?{login_hint:existing.email}:{})});
  return {url:url.href};
 }
 async exchange(fields){let r;try{r=await this.fetch(issuer+'/api/accounts/oauth/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});}catch{throw new AppError('ChatGPT authorization is unreachable. Try again.',503);}
  if(!r.ok)throw r.status===400||r.status===401||r.status===403?fail('ChatGPT authorization was rejected. Connect again.'):new AppError('ChatGPT authorization is temporarily unavailable. Try again.',503);const t=await r.json();if(!t.access_token||!Number.isFinite(t.expires_in)||t.expires_in<=0)throw new AppError('ChatGPT returned an incomplete authorization. Try again.',503);return t;}
 async access(){const a=this.active();if(!a?.refreshToken)throw fail('Connect ChatGPT in Settings first.');if(a.reconnectRequired)throw fail('ChatGPT session expired. Reconnect this account in Settings.');if(a.expiresAt>this.now()+60000)return a.accessToken;
  if(!this.refreshing)this.refreshing=(async()=>{const generation=this.generation;let t;try{t=await this.exchange({grant_type:'refresh_token',client_id:a.clientId,refresh_token:a.refreshToken,resource});}catch(e){if(e.status===401&&generation===this.generation&&this.active()===a){a.reconnectRequired=true;this.error='ChatGPT session expired. Reconnect this account in Settings.';await this.save();}throw e;}if(generation!==this.generation||this.active()!==a)throw fail('ChatGPT account changed during refresh.');if(!t.refresh_token)throw new AppError('ChatGPT did not renew the session. Try again.',503);Object.assign(a,{accessToken:t.access_token,refreshToken:t.refresh_token,expiresAt:this.now()+t.expires_in*1000,scopes:t.scope?.split(' ')||a.scopes,reconnectRequired:false});this.error=null;await this.save();return a.accessToken;})().finally(()=>{this.refreshing=null;});return this.refreshing;
 }
 async models(){const token=await this.access();let r;try{r=await this.fetch(resource+'/models',{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new AppError('ChatGPT model catalog is unreachable. Try again.',503);}if(!r.ok)throw new AppError('ChatGPT model catalog could not be loaded. Reconnect or try again.',r.status===401?401:503);
  const data=await r.json();return (data.models||[]).filter(m=>m.visibility==='list'&&typeof m.slug==='string').map(m=>({id:m.slug,name:m.display_name||m.slug}));}
 async select(model){const clientId=this.value.active;if(typeof model!=='string'||!model||model.length>150)throw new AppError('Choose a ChatGPT model.');const available=await this.models();if(!available.some(m=>m.id===model))throw new AppError('Choose a model from this ChatGPT account.');if(this.value.active!==clientId)throw new AppError('ChatGPT account changed. Choose a model for the current account.',409);this.active().model=model;await this.save();return this.status();}
 async switchAccount(clientId){if(!this.value.accounts[clientId]?.refreshToken||this.value.accounts[clientId]?.reconnectRequired)throw fail('Reconnect this ChatGPT account first.');this.value.active=clientId;this.error=null;await this.save();return this.status();}
 async signOut(){this.close();const a=this.active();if(!a)return this.status();let revoked=false;try{const meta=await(await this.fetch(issuer+'/.well-known/openid-configuration',{redirect:'error',signal:AbortSignal.timeout(15000)})).json();if(meta.issuer===issuer&&meta.revocation_endpoint?.startsWith(issuer+'/')){const r=await this.fetch(meta.revocation_endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:a.refreshToken,token_type_hint:'refresh_token',client_id:a.clientId})});revoked=r.ok;}}catch{}
  delete a.accessToken;delete a.refreshToken;delete a.idToken;delete a.expiresAt;delete a.reconnectRequired;this.value.active=null;this.error=null;await this.save();return {...this.status(),revoked};}
}
