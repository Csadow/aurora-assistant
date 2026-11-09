import {emptyState, LIMIT} from './core.js';
const opened = new Promise((resolve,reject) => {
  const req=indexedDB.open('aurora-mobile',1);
  req.onupgradeneeded=()=>req.result.createObjectStore('workspace');
  req.onsuccess=()=>resolve(req.result);
  req.onerror=()=>reject(Error('Device storage could not be opened.'));
});
export async function transact(change) {
  const db=await opened;
  return new Promise((resolve,reject) => {
    const tx=db.transaction('workspace',change?'readwrite':'readonly'), store=tx.objectStore('workspace'); let result, error;
    const req=store.get('state');
    req.onsuccess=()=>{
      try {
        const state=req.result || emptyState();
        result=change?change(state):state;
        if (change) {
          if (new TextEncoder().encode(JSON.stringify(state)).length > LIMIT * .75) throw Error('Local workspace is full (3 MB). Export a backup before adding more content.');
          store.put(state,'state');
        }
      } catch(e) { error=e; tx.abort(); }
    };
    tx.oncomplete=()=>resolve(result);
    tx.onabort=tx.onerror=()=>reject(error || Error('Could not save to device storage. Your draft has been kept.'));
  });
}
