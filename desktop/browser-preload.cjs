const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('auroraBrowser',Object.freeze({control:(action,value)=>ipcRenderer.invoke('aurora:browser',action,value),onState:callback=>ipcRenderer.on('aurora:browser-state',(_event,value)=>callback(value))}));
