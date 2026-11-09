import {AsyncLocalStorage} from 'node:async_hooks';

const views=new AsyncLocalStorage();
// Only explicitly read-only overview renders enter this scope. Nothing survives
// the render; writes and approval/commit verification do not enter it.
export async function readView(fn){
 if(views.getStore()?.active)return fn();
 const scope={active:true,lists:new Map()};
 return views.run(scope,async()=>{try{return await fn();}finally{scope.active=false;scope.lists.clear();}});
}
export async function viewList(owner,key,read){
 const scope=views.getStore();if(!scope?.active)return read();
 let entries=scope.lists.get(owner);if(!entries){entries=new Map();scope.lists.set(owner,entries);}
 if(!entries.has(key))entries.set(key,Promise.resolve().then(read));
 // Reports may annotate their own objects. Never share mutable returned records.
 return structuredClone(await entries.get(key));
}
// Defensive invalidation if a future read path deliberately writes a record.
export function freshReads(fn){
 const parent=views.getStore();parent?.lists.clear();
 return views.run(undefined,async()=>{try{return await fn();}finally{parent?.lists.clear();}});
}
