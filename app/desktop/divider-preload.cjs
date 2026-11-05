const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('dividerBridge',{
  begin:()=>ipcRenderer.invoke('workbench','panel-drag-begin'),
  drag:delta=>ipcRenderer.invoke('workbench','panel-resize',{delta}),
  end:()=>ipcRenderer.invoke('workbench','panel-drag-end')
});