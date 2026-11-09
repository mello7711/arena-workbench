const {contextBridge,ipcRenderer}=require('electron');

// file:// 本地工作区页（保留兼容）：完整 workbench 桥
// http:// 工作区页（20147，由 main.cjs 内置提供服务）：同样给完整桥。
//   历史原因：面板视图停在 http://127.0.0.1:20140/ 时无法导航到 file://
//   （Chromium 拒绝 http 页面跳 file 页面），导致「工作区」页签点了没反应。
//   修复方式：工作区页改走 http://127.0.0.1:20147/，面板只做 http->http 跳转。
const WORKSPACE_ACTIONS = [
  'home-open','integration-open','integration-control',
  'pelican-send','pelican-ref',
  'pelican-auto-start','pelican-auto-stop','pelican-auto-status',
  'pelican-archive','pelican-archive-list','pelican-open-folder','pelican-archive-one','pelican-archive-unscored','pelican-score-one',
  'coldstart-copy','coldstart-send','coldstart-backup-copy','coldstart-backup-send',
  'relay-list','relay-send','relay-copy',
  'session-export','session-import',
  'panel-resize'
];

function exposeFull(){
  contextBridge.exposeInMainWorld('workbench',{
    invoke:(action,data)=>ipcRenderer.invoke('workbench',action,data),
    onState:fn=>ipcRenderer.on('workbench-state',(_,s)=>fn(s))
  });
}

function exposeWorkspaceHttp(){
  contextBridge.exposeInMainWorld('workbench',{
    invoke:(action,data)=>{
      if(!WORKSPACE_ACTIONS.includes(action))return Promise.reject(new Error('不允许的面板操作'));
      return ipcRenderer.invoke('workbench',action,data);
    }
  });
  contextBridge.exposeInMainWorld('panelBridge',{
    resize:delta=>ipcRenderer.invoke('workbench','panel-resize',{delta})
  });
}

if(location.protocol==='file:'){
  exposeFull();
}else if(location.protocol==='http:'){
  // 20147 是工作区页，需要完整本地能力；20140 管理页原本只开放最小权限。
  // 20147 死结修复（2026-11-09）：鹈鹕「开始连抽」按钮在 20140 管理页上，执行
  // 逻辑的 20147 工作区页和它不能同时开，server.mjs 转发时永远找不到 20147。
  // 所以 20140 页也放行 pelican-auto-*/pelican-archive*，让管理页直接调 IPC，
  // 其余操作仍只放行 open-session / panel-resize。
  if(location.port==='20147')exposeWorkspaceHttp();
  else{
    const ADMIN_ACTIONS=['open-session','panel-resize','pelican-ref',
      'pelican-auto-start','pelican-auto-stop','pelican-auto-status',
      'pelican-archive','pelican-archive-list','pelican-open-folder','pelican-archive-one','pelican-archive-unscored','pelican-score-one'];
    contextBridge.exposeInMainWorld('workbench',{
      invoke:(action,data)=>{
        if(!ADMIN_ACTIONS.includes(action))return Promise.reject(new Error('不允许的面板操作'));
        return ipcRenderer.invoke('workbench',action,data);
      }
    });
    contextBridge.exposeInMainWorld('panelBridge',{
      resize:delta=>ipcRenderer.invoke('workbench','panel-resize',{delta})
    });
  }
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
