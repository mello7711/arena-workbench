const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('workbench',{
  invoke:(action,data)=>ipcRenderer.invoke('workbench',action,data),
  onState:fn=>ipcRenderer.on('workbench-state',(_,s)=>fn(s))
});
