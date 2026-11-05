const {contextBridge,ipcRenderer}=require('electron');
// file:// 本地工作区页：完整 workbench 桥
if(location.protocol==='file:'){
  contextBridge.exposeInMainWorld('workbench',{
    invoke:(action,data)=>ipcRenderer.invoke('workbench',action,data),
    onState:fn=>ipcRenderer.on('workbench-state',(_,s)=>fn(s))
  });
}else if(location.protocol==='http:'){
  // localhost 管理页需要通过 IPC 驱动右侧内嵌 Arena 页面。
  // 只开放管理页实际需要的动作，避免把完整桌面权限暴露给 HTTP 内容。
  contextBridge.exposeInMainWorld('workbench',{
    invoke:(action,data)=>{
      if(!['open-session','panel-resize'].includes(action))return Promise.reject(new Error('不允许的面板操作'));
      return ipcRenderer.invoke('workbench',action,data);
    }
  });
  contextBridge.exposeInMainWorld('panelBridge',{
    resize:delta=>ipcRenderer.invoke('workbench','panel-resize',{delta})
  });
}
// 右缘拖条：拖拽调节左窗与官网宽度（原生 view 会盖住 shell DOM，只能放在页面内部）
function injectDivider(){
  if(document.getElementById('__panelDivider'))return;
  const win=window;
  const d=document.createElement('div');
  d.id='__panelDivider';
  d.style.cssText='position:fixed;top:0;bottom:0;right:0;width:7px;cursor:col-resize;z-index:2147483647;background:transparent;';
  const resize=delta=>{
    try{ if(win.panelBridge?.resize) win.panelBridge.resize(delta); else if(win.workbench?.invoke) win.workbench.invoke('panel-resize',{delta}); }catch(e){}
  };
  d.addEventListener('pointerdown',e=>{
    e.preventDefault();
    try{d.setPointerCapture(e.pointerId);}catch(_){}
    let last=e.clientX;
    const move=ev=>{
      const delta=ev.clientX-last; if(!delta)return;
      last=ev.clientX; resize(delta);
    };
    const up=ev=>{
      d.removeEventListener('pointermove',move);
      d.removeEventListener('pointerup',up);
      d.removeEventListener('pointercancel',up);
    };
    d.addEventListener('pointermove',move);
    d.addEventListener('pointerup',up);
    d.addEventListener('pointercancel',up);
  });
  (document.body||document.documentElement).appendChild(d);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',injectDivider);
else injectDivider();
