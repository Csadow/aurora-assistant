import {isIP} from 'node:net';
import {lookup} from 'node:dns/promises';

export function publicAddress(address){
  const a=address.replace(/^\[|\]$/g,'');
  if(isIP(a)===4){const [x,y]=a.split('.').map(Number);return !(x===0||x===10||x===127||x===169&&y===254||x===172&&y>=16&&y<=31||x===192&&y===168||x===100&&y>=64&&y<=127||x>=224||x===198&&(y===18||y===19));}
  return isIP(a)===6&&/^[23][0-9a-f]{3}:/i.test(a);
}
export function webURL(value,testOrigin){
  if(typeof value!=='string'||value.length>8000)throw new Error('Enter an HTTP or HTTPS URL.');
  let u;try{u=new URL(value);}catch{throw new Error('Enter a complete HTTP or HTTPS URL.');}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Only HTTP/HTTPS pages without embedded credentials can be opened.');
  if(testOrigin&&u.origin===testOrigin)return u.href;
  const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||!host.includes('.')&&!isIP(host)||isIP(host)&&!publicAddress(host))throw new Error('Local services and private networks are excluded from browser automation.');
  return u.href;
}
export async function networkURL(value,testOrigin){
  const url=webURL(value,testOrigin),u=new URL(url);if(testOrigin&&u.origin===testOrigin)return url;
  const addresses=await lookup(u.hostname.replace(/^\[|\]$/g,''),{all:true});
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('This address resolves to a private network.');
  return url;
}
