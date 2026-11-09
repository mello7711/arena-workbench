const {app,BrowserWindow,WebContentsView,ipcMain,session,safeStorage,clipboard,dialog,shell,nativeImage}=require('electron');
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawn}=require('node:child_process');
const httpmod=require('node:http');
const net=require('node:net');const {execFile}=require('node:child_process');const {parseNodes,chooseNode}=require('./proxy-pool.cjs');const {ProxyRuntime}=require('./proxy-runtime.cjs');
const ROOT=path.resolve(__dirname,'..'),DATA=path.join(ROOT,'.arena-gui');
const HOME=path.dirname(ROOT),TUNNEL_DIR=path.join(HOME,'隧道与MCP'),EXAM_DIR=path.join(HOME,'选妃资料');
// 2026-11-04 修正：上一版曾指向 HOME（工作台根目录），但 txt 一直在 隧道与MCP 里，导致按钮报「未找到打通教程」
const COLDSTART_DIR=TUNNEL_DIR;  // 主版/备用版 txt 就在 隧道与MCP 下
const CDP_PORT=String(process.env.ARENA_DESKTOP_CDP_PORT||'20145');

// ---- 工作区 HTTP 服务（修复：面板停在 http 页面时无法跳到 file:// 的 workspace.html）----
// Chromium 不允许 http 页面导航到 file 页面，所以把工作区页也改成 http 提供，
// 面板只做 http -> http 跳转。只监听 127.0.0.1。
const WORKSPACE_PORT=20147;
let workspaceServer=null;
function startWorkspaceServer(){
  const dir=__dirname;
  const files={
    '/':['workspace.html','text/html; charset=utf-8'],
    '/workspace':['workspace.html','text/html; charset=utf-8'],
    '/workspace.html':['workspace.html','text/html; charset=utf-8'],
    '/workspace.js':['workspace.js','application/javascript; charset=utf-8'],
    '/shell.css':['shell.css','text/css; charset=utf-8']
  };
  workspaceServer=httpmod.createServer((req,res)=>{
    try{
      const {pathname}=new URL(req.url,'http://127.0.0.1');
      const hit=files[pathname];
      if(!hit){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('not found');}
      const body=fs.readFileSync(path.join(dir,hit[0]));
      res.writeHead(200,{'Content-Type':hit[1],'Cache-Control':'no-store','Content-Length':body.length});
      return res.end(body);
    }catch(error){
      trace('workspace server error: '+String(error.message||error));
      try{res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});res.end('error');}catch{}
    }
  });
  workspaceServer.on('error',error=>trace('workspace server listen error: '+String(error.message||error)));
  workspaceServer.listen(WORKSPACE_PORT,'127.0.0.1',()=>trace('workspace server on '+WORKSPACE_PORT));
}

fs.mkdirSync(DATA,{recursive:true});
function trace(message){fs.appendFileSync(path.join(DATA,'desktop-shell.log'),new Date().toISOString()+' '+message+'\n');}
trace('process started');
// Software rendering is the stable default for embedded native views on Windows.
// Opt-in only after validating the local GPU driver.
if(process.env.ARENA_ENABLE_GPU!=='1')app.disableHardwareAcceleration();
app.setPath('userData',path.join(DATA,'desktop-profile'));
app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port',CDP_PORT);
app.commandLine.appendSwitch('lang','zh-CN');
if(!app.requestSingleInstanceLock()){app.quit();return;}
const PIPE='\\\\.\\pipe\\arena-workbench-'+crypto.createHash('sha256').update(ROOT.toLowerCase()).digest('hex').slice(0,16);
let win,panel,arena,mail,divider,backend,settings={},mailboxes=[],activeMail='',currentView='arena',modal=false,apiEnv={},quitting=false;
let proxyData={nodes:[],bindings:{},enabled:false},proxyRuntime,proxyError='';
const PROXY_VAULT=path.join(DATA,'proxies.dpapi');
const VAULT=path.join(DATA,'mailboxes.dpapi'),SETTINGS=path.join(DATA,'desktop-settings.json');
function envFile(){const env={};for(const line of fs.readFileSync(path.join(DATA,'.env'),'utf8').split(/\r?\n/)){const m=line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);if(m)env[m[1]]=m[2];}return env;}
function saveSettings(){fs.writeFileSync(SETTINGS,JSON.stringify(settings,null,2),'utf8');}
function loadVault(){if(!fs.existsSync(VAULT))return [];if(!safeStorage.isEncryptionAvailable()){trace('safeStorage unavailable, vault starts empty');return [];}try{return JSON.parse(safeStorage.decryptString(fs.readFileSync(VAULT)));}catch(error){trace('vault decrypt failed ('+String(error.message||error)+'), starting empty; file kept at '+VAULT);return [];}}
function saveVault(){if(!safeStorage.isEncryptionAvailable())throw new Error('系统凭据加密不可用');const tmp=VAULT+'.tmp';fs.writeFileSync(tmp,safeStorage.encryptString(JSON.stringify(mailboxes)));fs.renameSync(tmp,VAULT);}
function state(){return {collapsed:!!settings.collapsed,panelWidth:px(settings.panelWidth),arenaAccounts:settings.arenaAccounts||[],proxyPool:{error:proxyError,enabled:proxyData.enabled,nodes:proxyData.nodes.map(n=>({id:n.id,name:n.node.name,type:n.node.type,check:n.check||null})),bindings:proxyData.bindings},view:currentView,arenaUrl:arena&&!arena.webContents.isDestroyed()?arena.webContents.getURL():'',mailUrl:mail&&!mail.webContents.isDestroyed()?mail.webContents.getURL():'',proxy:settings.proxy||'',email:settings.arenaEmail||'',apiBase:'http://127.0.0.1:20140/v1',accounts:mailboxes.map(a=>({email:a.email,hasPassword:!!a.password,hasToken:!!(a.clientId&&a.refreshToken)})),activeMail};}
function publish(){if(win&&!win.isDestroyed())win.webContents.send('workbench-state',state());}
function hideViews(){for(const view of [panel,arena,mail,divider])if(view&&!view.webContents.isDestroyed())view.setVisible(false);}
function disposeView(view){if(!view)return;try{view.setVisible(false);win?.contentView.removeChildView(view);}catch{}if(!view.webContents.isDestroyed())view.webContents.close({waitForBeforeUnload:false});}
function layout(){if(!win||!panel)return;if(win.isMinimized()||!win.isVisible()){hideViews();return;}const [width,height]=win.getContentSize();if(width<800||height<300)return;const top=92,left=settings.collapsed?0:Math.min(px(settings.panelWidth)||Math.min(510,Math.max(360,Math.round(width*.32))),Math.round(width*.7));
  panel.setBounds({x:0,y:top,width:left,height:Math.max(1,height-top)});
  for(const view of [arena,mail])if(view)view.setBounds({x:left+1,y:top,width:Math.max(1,width-left-1),height:Math.max(1,height-top)});
  if(divider)divider.setBounds({x:left,y:top,width:10,height:Math.max(1,height-top)});
  panel.setVisible(!modal&&!settings.collapsed);arena?.setVisible(!modal&&currentView==='arena');mail?.setVisible(!modal&&currentView==='mail');if(divider)divider.setVisible(!modal&&!settings.collapsed);}
function secureView(view){view.webContents.setWindowOpenHandler(({url})=>{
  if(!/^https:\/\//i.test(url))return {action:'deny'};
  return {action:'allow',overrideBrowserWindowOptions:{parent:win,width:1000,height:760,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,session:view.webContents.session}}};
});view.webContents.on('will-navigate',(event,url)=>{if(!/^https:\/\//i.test(url))event.preventDefault();});
 view.webContents.on('did-navigate',publish);view.webContents.on('did-navigate-in-page',publish);
 view.webContents.on('render-process-gone',(_,details)=>trace('site renderer gone: '+details.reason));
 view.webContents.on('will-prevent-unload',event=>event.preventDefault());
 view.webContents.session.setPermissionRequestHandler((_,__,callback)=>callback(false));
}
function px(value){return Number.isFinite(value)&&value>=300?Math.round(value):0;}
function resizePanel(delta){settings.panelWidth=Math.max(300,Math.min(900,(px(settings.panelWidth)||Math.round((win.getContentSize()[0])*.32))+delta));saveSettings();layout();return state();}
async function applyProxy(ses,email=settings.arenaEmail){if(proxyData.enabled){await ses.setProxy({mode:'fixed_servers',proxyRules:'http://127.0.0.1:1'});let node=proxyData.nodes.find(n=>n.id===proxyData.bindings[email]);if(!node){node=chooseNode(proxyData.nodes,proxyData.bindings);if(!node)throw Error('没有可用节点，请导入或检测节点');proxyData.bindings[email]=node.id;saveProxyVault();}await ses.setProxy({mode:'fixed_servers',proxyRules:'http://127.0.0.1:1'});const port=await proxyRuntime.start(email,node.node);await ses.setProxy({mode:'fixed_servers',proxyRules:'http://127.0.0.1:'+port,proxyBypassRules:'<local>'});await ses.closeAllConnections();return;} const value=String(settings.proxy||'').trim();await ses.setProxy(value?{mode:'fixed_servers',proxyRules:value,proxyBypassRules:'<local>'}:{mode:'direct'});await ses.closeAllConnections();}
async function bridgeRequest(route,body){const response=await fetch('http://127.0.0.1:20140'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+apiEnv.ARENA_AGENT_BRIDGE_KEY,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'本地服务不可用');return result;}
async function openMail(email){const a=mailboxes.find(x=>x.email===email);if(!a)throw new Error('请先选择邮箱');activeMail=email;
 if(mail){disposeView(mail);mail=null;}
 const partition='persist:mail-'+crypto.createHash('sha256').update(email).digest('hex').slice(0,20);
 const ses=session.fromPartition(partition);await applyProxy(ses,email);
 mail=new WebContentsView({webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true}});secureView(mail);win.contentView.addChildView(mail);
 const {mailboxWebUrl}=await import('./mail.mjs');currentView='mail';layout();await mail.webContents.loadURL(mailboxWebUrl(email)).catch(()=>{});publish();
}
async function main(){
 trace('main ready');
  try{const ctrl=new AbortController();setTimeout(()=>ctrl.abort(),2000);const r=await fetch('http://127.0.0.1:'+CDP_PORT+'/json/list',{signal:ctrl.signal}); if(!r.ok) throw new Error('cdp not ok');}catch(e){const base=Number(CDP_PORT)||20145; if(base<20155){const next=String(base+1); trace('cdp zombie on '+CDP_PORT+', relaunching on '+next); try{spawn(process.execPath,[__filename,...process.argv.slice(2)],{env:{...process.env,ARENA_DESKTOP_CDP_PORT:next},detached:true,stdio:'ignore'}).unref();}catch{} app.quit(); return;}}
 apiEnv=envFile();try{settings=JSON.parse(fs.readFileSync(SETTINGS,'utf8'));}catch{settings={proxy:apiEnv.ARENA_AGENT_PROXY||''};}
 mailboxes=loadVault();proxyRuntime=new ProxyRuntime(DATA);if(fs.existsSync(PROXY_VAULT)){try{proxyData=JSON.parse(safeStorage.decryptString(fs.readFileSync(PROXY_VAULT)));}catch(error){trace('proxy vault decrypt failed ('+String(error.message||error)+'), starting empty');}}
 const {CredentialStore}=await import('../src/credentials.mjs');
 const credentials=new CredentialStore({filePath:path.join(DATA,'credentials.json'),secret:apiEnv.STORAGE_ENCRYPTION_KEY});credentials.load();
 const account=credentials.primary();if(account&&!settings.arenaEmail)settings.arenaEmail=account.email;settings.arenaAccounts||=[];settings.partitions||={};if(account&&!settings.arenaAccounts.includes(account.email)){settings.arenaAccounts.push(account.email);settings.partitions[account.email]='';}saveSettings();
 win=new BrowserWindow({show:false,width:1560,height:1000,minWidth:1100,minHeight:720,title:'Arena 工作台',backgroundColor:'#f3f8f4',autoHideMenuBar:true,
  webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
 win.once('ready-to-show',()=>{win?.show();win?.focus();layout();});
 win.on('unresponsive',()=>trace('native window unresponsive'));win.on('responsive',()=>trace('native window responsive'));
 win.webContents.on('render-process-gone',(_,details)=>trace('shell renderer gone: '+details.reason));
 win.webContents.on('console-message',(_event,...args)=>{const detail=args[0];if(detail&&typeof detail==='object'&&detail.level==='error')trace('shell console error: '+String(detail.message).slice(0,300));});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 panel=new WebContentsView({webPreferences:{preload:path.join(__dirname,'workspace-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
 divider=new WebContentsView({webPreferences:{preload:path.join(__dirname,'divider-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
 const browserSession=session.fromPartition(settings.partitions[settings.arenaEmail]||'');try{await applyProxy(browserSession);}catch(error){proxyError=String(error.message||error);trace('account proxy unavailable; management remains open');}
 if(account&&account.email===settings.arenaEmail){const existing=await browserSession.cookies.get({url:'https://arena.ai'});if(!existing.some(c=>c.name.startsWith('arena-auth-prod-v1'))){
   const {cookieHeaderToObjects}=await import('../src/cookie.mjs');for(const c of cookieHeaderToObjects(account.cookieHeader)){await browserSession.cookies.set({url:'https://arena.ai',name:c.name,value:c.value,path:'/',secure:true}).catch(()=>{});}
 }}
 arena=new WebContentsView({webPreferences:{session:browserSession,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});secureView(arena);
 win.contentView.addChildView(panel);win.contentView.addChildView(arena);
 divider.setBackgroundColor('#00000000');divider.setBounds({x:0,y:0,width:10,height:1});divider.webContents.loadFile(path.join(__dirname,'divider.html'));
 win.contentView.addChildView(divider);
 win.on('resize',layout);win.on('restore',layout);win.on('show',layout);win.on('minimize',hideViews);win.on('hide',hideViews);win.on('close',()=>{for(const view of [panel,arena,mail,divider])disposeView(view);panel=arena=mail=divider=null;});win.on('closed',()=>{win=null;app.quit();});
 startWorkspaceServer();
 await win.loadFile(path.join(__dirname,'shell.html'));layout();
 trace('shell loaded');
 await panel.webContents.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="font:14px sans-serif;color:#708579;padding:24px;background:#f3f8f4">本地管理面板启动中…</body>'));
 arena.webContents.loadURL('https://arena.ai/agent').catch(()=>{});
 const output=fs.openSync(path.join(DATA,'desktop-backend.log'),'a');
 backend=spawn(process.env.ARENA_NODE_PATH||'C:\\Program Files\\nodejs\\node.exe',['src/index.mjs'],{cwd:ROOT,windowsHide:true,
   env:{...process.env,...apiEnv,DATA_DIR:DATA,ARENA_DESKTOP_CDP_URL:`http://127.0.0.1:${CDP_PORT}`,ARENA_DESKTOP_ACTIVE_EMAIL:settings.arenaEmail||'',ARENA_DESKTOP_SWITCH_PENDING:settings.needsSync?'1':'0'},stdio:['ignore',output,output]});fs.closeSync(output);
 backend.on('error',error=>trace('backend spawn error: '+error.message));
 backend.on('exit',(code,signal)=>{trace(`backend exit code=${code} signal=${signal}`);if(!quitting&&win)win.webContents.send('workbench-error','API 服务退出：'+code+'。请查看桌面日志。');});
 for(let i=0;i<100;i++){try{const r=await fetch('http://127.0.0.1:20140/health');if(r.ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 await panel.webContents.loadURL('http://127.0.0.1:20140/').catch(error=>trace('panel awaiting API: '+error.message));
 trace('panel loaded');
 await panel.webContents.insertCSS('.topbar,.banner,#accountLoginForm{display:none!important}.wrap{padding:8px 10px!important}.layout{grid-template-columns:1fr!important}.brand p{white-space:normal}.tabs{position:static!important;display:flex!important;gap:4px;padding:6px 10px;background:#fff;border-bottom:1px solid var(--line)}.stats{gap:6px!important;margin:0 0 8px!important}.stat{padding:7px 10px!important;min-width:0!important;flex:1 1 0!important}.stat .v{font-size:17px!important}.stat .sub{display:none!important}.panel{padding:11px!important}.side{gap:8px!important}.layout{gap:8px!important}.card{padding:10px!important;margin-bottom:6px!important}.card .sc-actions{gap:6px!important}.card .sc-url{margin-top:6px!important;padding:7px 9px!important}.selbar{gap:6px!important;margin-bottom:6px!important}.poolbar{gap:6px!important;margin-bottom:6px!important}.form-row{gap:8px!important;margin-bottom:8px!important}.field{margin-bottom:8px!important}.row{gap:6px!important;margin-bottom:6px!important}.hint{padding:8px 10px!important}.code-block{margin-bottom:8px!important}.separator{margin:16px 0!important}');
 panel.webContents.executeJavaScript('window.scrollTo(0,0)').catch(()=>{});
 publish();
}
ipcMain.handle('workbench',async(event,action,data={})=>{
 if(!win||(event.sender!==win.webContents&&event.sender!==panel?.webContents&&event.sender!==divider?.webContents))throw new Error('无效的控制来源');
 try{
 switch(action){
 case 'state':return state();
 case 'health':{try{const r=await fetch('http://127.0.0.1:20140/health');const h=await r.json();return {ready:!!h.ready};}catch{return {ready:false};}}
 case 'view':currentView=data.view==='mail'?'mail':'arena';if(currentView==='mail'&&!mail&&activeMail)await openMail(activeMail);layout();publish();return state();
 case 'collapse':settings.collapsed=!settings.collapsed;saveSettings();layout();publish();return state();
 case 'panel':modal=false;settings.collapsed=false;saveSettings();layout();publish();if(!['archive','harvest','workspace'].includes(data.page))throw new Error('无效页面');if(data.page==='workspace'){await panel.webContents.loadURL('http://127.0.0.1:'+WORKSPACE_PORT+'/').catch(error=>trace('panel workspace load failed: '+error.message));await panel.webContents.executeJavaScript('window.scrollTo(0,0)').catch(()=>{});return {ok:true};}await panel.webContents.loadURL('http://127.0.0.1:20140/').catch(()=>{});await panel.webContents.executeJavaScript(`switchPage(${JSON.stringify(data.page)})`);panel.webContents.executeJavaScript('window.scrollTo(0,0)').catch(()=>{});return {ok:true};
 case 'panel-resize':{return resizePanel(Number(data.delta)||0);}
 case 'panel-drag-begin':{if(divider&&!settings.collapsed){const b=divider.getBounds();divider.setBounds({x:b.x,y:b.y,width:40,height:b.height});}return {ok:true};}
 case 'panel-drag-end':{layout();return {ok:true};}
 case 'panel-workspace':{await panel.webContents.loadURL('http://127.0.0.1:'+WORKSPACE_PORT+'/').catch(error=>trace('panel-workspace load failed: '+error.message));return {ok:true};}
 case 'modal':modal=!!data.open;layout();return {ok:true};
 case 'navigate':{const target=currentView==='mail'?mail:arena;if(!target)return {ok:true};if(data.command==='reload')target.webContents.reload();else if(data.command==='back'&&target.webContents.navigationHistory.canGoBack())target.webContents.navigationHistory.goBack();return {ok:true};}
 case 'open-session':{const url=String(data.url||'');if(!/^https:\/\/arena\.ai\/agent\/[a-f0-9-]{36}(\?.*)?$/i.test(url))throw Error('无效的会话地址');const email=String(data.email||'').trim().toLowerCase();if(email&&settings.arenaEmail&&email!==String(settings.arenaEmail).toLowerCase())throw Error('该会话属于 '+email+'，请先在「账号 / 同步」切换到该账号再打开');if(!arena)throw Error('官网页面尚未就绪');currentView='arena';modal=false;layout();trace('open-session: '+url);
  let loadError=null;
  for(let attempt=1;attempt<=2;attempt+=1){
    loadError=null;
    try{await arena.webContents.loadURL(url);break;}
    catch(e){loadError=e;trace('open-session load attempt '+attempt+' failed: '+e.message);if(attempt<2)await new Promise(w=>setTimeout(w,900));}
  }
  if(loadError)throw Error('打开失败：'+loadError.message+'（右侧页面可能还在加载，请重试一次）');
  publish();return state();}
 case 'proxy-save':{await bridgeRequest('/api/desktop/idle', {});const proxy=String(data.proxy||'').trim();if(proxy){const url=new URL(proxy);if(!['http:','https:','socks5:','socks4:'].includes(url.protocol)||url.username||url.password)throw new Error('请输入HTTP/SOCKS代理地址；此版本请使用本地无认证代理');}settings.proxy=proxy;saveSettings();await applyProxy(arena.webContents.session);if(mail)await applyProxy(mail.webContents.session,activeMail);publish();return {ok:true};}
 case 'proxy-test':{const response=await arena.webContents.session.fetch('https://arena.ai/',{signal:AbortSignal.timeout(15000)});return {ok:response.ok,status:response.status};}
 case 'sync':{const email=String(data.email||'').trim().toLowerCase();if(settings.arenaEmail&&email!==settings.arenaEmail.toLowerCase())throw Error('请先切换到该邮箱的独立登录环境，再同步');const result=await bridgeRequest('/api/desktop/sync',{email});settings.arenaEmail=email;settings.needsSync=false;if(!settings.arenaAccounts.includes(email))settings.arenaAccounts.push(email);if(settings.partitions[email]===undefined)settings.partitions[email]=arena.webContents.session===session.defaultSession?'':'persist:arena-'+crypto.createHash('sha256').update(email).digest('hex').slice(0,20);saveSettings();if(panel) try{const r=panel.webContents.reload();if(r&&r.catch)r.catch(()=>{});}catch{};publish();return result;}
 case 'account-switch':{const email=String(data.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('请输入Arena账号邮箱');await bridgeRequest('/api/desktop/transition',{email});settings.needsSync=true;saveSettings();const partition=settings.partitions[email]??('persist:arena-'+crypto.createHash('sha256').update(email).digest('hex').slice(0,20));const ses=session.fromPartition(partition);await applyProxy(ses,email);disposeView(arena);arena=new WebContentsView({webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});secureView(arena);win.contentView.addChildView(arena);settings.arenaEmail=email;for(const key of [...proxyRuntime.jobs.keys()])if(key!==email&&key!==activeMail)await proxyRuntime.stop(key);settings.partitions[email]=partition;if(!settings.arenaAccounts.includes(email))settings.arenaAccounts.push(email);saveSettings();currentView='arena';modal=false;layout();await arena.webContents.loadURL('https://arena.ai/agent');if(panel) try{const r=panel.webContents.reload();if(r&&r.catch)r.catch(()=>{});}catch{};publish();return state();}
 case 'proxy-import-file':{const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'节点配置',extensions:['yaml','yml','json','txt']}]});if(r.canceled)return {imported:0};const file=r.filePaths[0];if(fs.statSync(file).size>4194304)throw Error('配置超过4MB');const rows=parseNodes(fs.readFileSync(file,'utf8'));for(const n of rows)if(!proxyData.nodes.some(a=>a.id===n.id))proxyData.nodes.push(n);saveProxyVault();publish();return {imported:rows.length};}
 case 'proxy-import':{const incoming=parseNodes(data.text);for(const n of incoming)if(!proxyData.nodes.some(a=>a.id===n.id))proxyData.nodes.push(n);saveProxyVault();publish();return {imported:incoming.length};}
 case 'proxy-subscribe':{const u=new URL(String(data.url||''));if(u.protocol!=='https:')throw Error('订阅仅支持HTTPS');const r=await arena.webContents.session.fetch(u.href,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('订阅读取失败');if(Number(r.headers.get('content-length'))>4194304)throw Error('订阅超过4MB');const incoming=parseNodes(await r.text());for(const n of incoming)if(!proxyData.nodes.some(a=>a.id===n.id))proxyData.nodes.push(n);saveProxyVault();publish();return {imported:incoming.length};}
 case 'proxy-bind':{const email=String(data.email||settings.arenaEmail).trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('绑定账号邮箱无效');if(data.id&&!proxyData.nodes.some(n=>n.id===data.id))throw Error('节点不存在');if(data.id)proxyData.bindings[email]=data.id;else delete proxyData.bindings[email];saveProxyVault();publish();return {ok:true};}
 case 'proxy-enable':proxyError='';await bridgeRequest('/api/desktop/idle', {});proxyData.enabled=!!data.enabled;saveProxyVault();await applyProxy(arena.webContents.session);if(mail)await applyProxy(mail.webContents.session,activeMail);if(!proxyData.enabled)await proxyRuntime.close();publish();return state();
 case 'proxy-check':{const n=proxyData.nodes.find(n=>n.id===data.id);if(!n)throw Error('节点不存在');const key='check-'+n.id;const started=Date.now();try{const port=await proxyRuntime.start(key,n.node);const ses=session.fromPartition('proxy-check-'+n.id);await ses.setProxy({mode:'fixed_servers',proxyRules:'http://127.0.0.1:'+port});
    // 多候选源检测：ipify→icanhazip→google 兜底。单点失败不代表节点坏（实测 ipify 在部分节点上超时但 google 通过）。
    const tryUrl=async(u)=>{try{const r=await ses.fetch(u,{signal:AbortSignal.timeout(10000)});if(!r.ok)return null;try{return await r.text()}catch{return 'ok'}}catch{return null}};
    let ip='';
    for(const u of ['https://api.ipify.org','https://icanhazip.com','https://api-ipv4.ip.sb/ip','https://www.google.com/']){
      const t=await tryUrl(u);
      if(t){ip=(t.trim().slice(0,40).match(/[\d\.]+/)||['ok'])[0];break}
    }
    if(!ip)throw Error('出口检测失败');
    n.check={ok:true,ms:Date.now()-started,ip,at:Date.now()};}catch{n.check={ok:false,at:Date.now()};}finally{await proxyRuntime.stop(key);}saveProxyVault();publish();return {ok:!!n.check.ok};}
 case 'proxy-clear-nodes':{trace('proxy-clear-nodes CALLED');try{await bridgeRequest('/api/desktop/idle', {});proxyData.enabled=false;proxyData.nodes=[];proxyData.bindings={};saveProxyVault();await applyProxy(arena.webContents.session,settings.arenaEmail);if(mail)await applyProxy(mail.webContents.session,activeMail);await proxyRuntime.close();publish();trace('proxy-clear-nodes DONE');return {ok:true,cleared:true};}catch(e){trace('proxy-clear-nodes ERROR: '+e.message);throw e;}}
 case 'home-open':{const error=await shell.openPath(HOME);if(error)throw Error(error);return {ok:true};}
 case 'integration-open':{const dirs={tunnel:TUNNEL_DIR};if(!dirs[data.kind])throw Error('未知入口');const error=await shell.openPath(dirs[data.kind]);if(error)throw Error(error);return {ok:true};}
 case 'integration-control':{if(!['start','stop','status'].includes(data.action)||!['all','tunnel','mcp'].includes(data.what))throw Error('无效控制命令');const script=path.join(TUNNEL_DIR,'bin','svc_ctl.ps1');const output=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Action',data.action,'-What',data.what],{windowsHide:true,timeout:60000,encoding:'utf8'},(err,out)=>err?reject(Error('隧道控制失败，请查看原控制台日志')):resolve(out)));return {output};}
 case 'coldstart-copy':{
  const pack=buildColdstart();
  clipboard.writeText(pack);return {ok:true,chars:pack.length};}
 case 'coldstart-send':{
  const pack=buildColdstart();
  const r=await arenaSend(pack);
  return {ok:true,mode:'sent',detail:r};}
 case 'coldstart-backup-copy':{
  const pack=fs.readFileSync(path.join(COLDSTART_DIR,'冷启动包-备用.txt'),'utf8');
  clipboard.writeText(pack);return {ok:true,chars:pack.length};}
 case 'coldstart-backup-send':{
  const pack=fs.readFileSync(path.join(COLDSTART_DIR,'冷启动包-备用.txt'),'utf8');
  const r=await arenaSend(pack);
  return {ok:true,mode:'sent',detail:r};}
 case 'relay-send':{
  if(!/^[a-z0-9-]+$/.test(String(data.source||''))||!data.key)throw Error('会话来源或标识无效');
  const out=await new Promise((resolve,reject)=>execFile(path.join(TUNNEL_DIR,'.venv','Scripts','python.exe'),[path.join(TUNNEL_DIR,'bin','relay_pack.py'),'pack',String(data.source),String(data.key),'30'],{windowsHide:true,timeout:120000,maxBuffer:4194304,encoding:'utf8'},(err,stdout,stderr)=>err?reject(Error(stderr||'接力包生成失败')):resolve(stdout)));
  const text=out.trim();
  const r=await arenaSend(text);
  return {ok:true,mode:'sent',chars:text.length,detail:r};}
 case 'relay-list':{
  const out=await new Promise((resolve,reject)=>execFile(path.join(TUNNEL_DIR,'.venv','Scripts','python.exe'),[path.join(TUNNEL_DIR,'bin','relay_pack.py'),'list','30','60'],{windowsHide:true,timeout:60000,maxBuffer:4194304,encoding:'utf8'},(err,stdout,stderr)=>err?reject(Error(stderr||'会话列表读取失败')):resolve(stdout)));
  return JSON.parse(out);}
 case 'relay-copy':{
  if(!/^[a-z0-9-]+$/.test(String(data.source||''))||!data.key)throw Error('会话来源或标识无效');
  const out=await new Promise((resolve,reject)=>execFile(path.join(TUNNEL_DIR,'.venv','Scripts','python.exe'),[path.join(TUNNEL_DIR,'bin','relay_pack.py'),'pack',String(data.source),String(data.key),'30'],{windowsHide:true,timeout:120000,maxBuffer:4194304,encoding:'utf8'},(err,stdout,stderr)=>err?reject(Error(stderr||'接力包生成失败')):resolve(stdout)));
  const text=out.trim();clipboard.writeText(text);return {ok:true,chars:text.length};}
 case 'session-export':{
  if(!arena||arena.webContents.isDestroyed())throw Error('右侧 Arena 网页未加载');
  const pageUrl=arena.webContents.getURL()||'';
  if(!/arena\.ai\/agent\//i.test(pageUrl))throw Error('请先在右侧打开要导出的对话页面');
  // 走 Arena 自己的一手接口。页面里的 self.__next_f（flight）现在不含 messages，
  // 旧版从这里解析必然得到「没找到对话记录」，所以改成直接读 /api/chat/<id>。
  const r=await arena.webContents.executeJavaScript(`(async()=>{
    const seg=location.pathname.split('/').filter(Boolean);const sid=seg[0]==='agent'?seg[1]:'';
    if(!sid)return {ok:false,detail:'当前地址里没有会话 id，请点进一个具体对话'};
    let res;
    try{res=await fetch('/api/chat/'+sid,{credentials:'include'});}
    catch(e){return {ok:false,detail:'请求 /api/chat 失败：'+String(e&&e.message||e)};}
    if(!res.ok)return {ok:false,detail:'接口返回 HTTP '+res.status};
    let d;
    try{d=await res.json();}catch(e){return {ok:false,detail:'接口返回的不是 JSON'};}
    const raw=Array.isArray(d.messages)?d.messages:[];
    if(!raw.length)return {ok:false,detail:'接口里没有 messages（该会话可能已归档或为空）'};
    const textOf=m=>(m.parts||[]).filter(p=>p&&p.type==='text'&&typeof p.text==='string'&&p.text).map(p=>p.text).join('\\n\\n');
    const messages=raw.map(m=>({role:String(m.role||'?').toLowerCase(),text:textOf(m)})).filter(x=>x.text);
    if(!messages.length)return {ok:false,detail:'消息里没有可导出的文本（只有工具调用或推理内容）'};
    let thinking=0,tools=0;
    for(const m of raw){for(const p of (m.parts||[])){if(p.type==='reasoning')thinking+=1;else if(String(p.type).startsWith('tool-'))tools+=1;}}
    const firstUser=messages.find(x=>x.role==='user');
    const title=String((firstUser&&firstUser.text)||'arena 对话').split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(13)).join(' ').split(String.fromCharCode(9)).join(' ').trim().slice(0,60);
    return {ok:true,title,messages,url:location.href,count:messages.length,total:raw.length,thinking,tools,
            complete:!(d.pagination&&d.pagination.hasMore)};
  })()`,true);
  if(!r||!r.ok)throw Error('导出失败：'+((r&&r.detail)||'未知原因'));
  const dir=path.join(HOME,'会话导出');fs.mkdirSync(dir,{recursive:true});
  const slug=String(r.title||'对话').replace(/[\\/:*?"<>|]+/g,'_').slice(0,60);
  const stamp=new Date().toISOString().replace(/[:T]/g,'-').slice(0,19);
  const file=path.join(dir,slug+'-'+stamp+'.json');
  fs.writeFileSync(file,JSON.stringify({app:'arena-workbench',version:2,exportedAt:new Date().toISOString(),
    url:r.url,session:r.url.split('/').pop(),title:r.title,count:r.count,total:r.total,
    omitted:{reasoningParts:r.thinking,toolParts:r.tools},complete:r.complete,
    messages:r.messages},null,1),'utf8');
  return {ok:true,file,count:r.count,total:r.total,title:r.title,chars:fs.statSync(file).size,
          omittedThinking:r.thinking,omittedTools:r.tools,complete:r.complete};}
 case 'session-import':{
  if(!arena||arena.webContents.isDestroyed())throw Error('右侧 Arena 网页未加载');
  const pick=await dialog.showOpenDialog(win,{title:'选择导出的会话记录',properties:['openFile'],filters:[{name:'会话导出',extensions:['json']},{name:'全部文件',extensions:['*']}],defaultPath:path.join(HOME,'会话导出')});
  if(!pick.filePaths||!pick.filePaths.length)return {ok:false,cancelled:true};
  let data;try{data=JSON.parse(fs.readFileSync(pick.filePaths[0],'utf8'));}catch(_e){throw Error('文件不是有效的导出 JSON');}
  let msgs=(Array.isArray(data.messages)?data.messages:[]).map(m=>({role:String((m&&m.role)||'?'),
    text:String((m&&m.text)||(()=>{try{return JSON.stringify(m&&m.attachments)||'';}catch(_e){return '';}})()||'')}))
    .filter(m=>m.text);
  if(!msgs.length)throw Error('导出文件里没有对话内容');
  currentView='arena';layout();
  await arena.webContents.loadURL('https://arena.ai/agent').catch(()=>{});
  await new Promise(w=>setTimeout(w,3500));
  const header='# 会话记录导入（接续旧对话）\n原对话标题: '+String(data.title||'').slice(0,80)+'\n导出时间: '+String(data.exportedAt||'').slice(0,19)+'\n说明: 下面是上一段对话的完整记录，请把它当作你的既有上下文来接续工作。\n';
  // 单条太长会撑爆输入框；总量太多会连发几十轮。两个上限都要有，并且明确告诉用户。
  const CHUNK=15000, MAX_TOTAL=200000;
  let dropped=0, used=0; const kept=[];
  for(const m of msgs){
    if(used+m.text.length>MAX_TOTAL){dropped+=1;continue;}
    kept.push(m); used+=m.text.length;
  }
  if(dropped)msgs.splice(0,msgs.length,...kept);
  const parts=[];
  let cur=header+'（记录较长，分多条发送）\n';
  for(const m of msgs){
    const piece='\n['+(m.role==='user'?'用户':'助手')+']\n'+String(m.text||'');
    if(cur.length+piece.length>CHUNK&&cur.length>header.length+10){parts.push(cur);cur='（接上条）\n';}
    cur+=piece;
  }
  cur+='\n\n——以上是历史记录（共 '+msgs.length+' 条'
    +(dropped?('，因超长省略了末尾 '+dropped+' 条'):'')+'）。请确认你已了解上下文，之后我会继续给你任务。';
  parts.push(cur);
  const sent=[];let i=0;
  for(const p of parts){
    i+=1;
    const r=await arenaSend(p);
    sent.push({part:i,chars:p.length,how:r.how});
    if(i<parts.length)await new Promise(w=>setTimeout(w,5000));
  }
  return {ok:true,file:pick.filePaths[0],title:String(data.title||'').slice(0,80),parts:sent.length,chars:parts.reduce((n,p)=>n+p.length,0),sent};}
 case 'pelican-send':{
  const r=await arenaSend('请用 SVG 输出一只骑自行车的鹈鹕的 2D 动画。要求：创建一个 HTML，内容是 SVG 绘制的鹈鹕骑自行车 2D 动画，动画自动循环播放，不要任何解释文字或代码块标记。');
  return {ok:true,detail:r};}
 case 'pelican-ref':{
  const cands=[path.join(EXAM_DIR,'参考','打开看图.html'),path.join(EXAM_DIR,'鹈鹕参考','打开看图.html')];
  const f=cands.find((x)=>fs.existsSync(x));
  if(!f)throw Error('未找到鹈鹕参考页（选妃资料\\参考\\打开看图.html）');
  const error=await shell.openPath(f);if(error)throw Error(error);return {ok:true};}
 case 'pelican-auto-start':{
  const infinite=data.infinite===true;
  // 次数：新口径 data.times（自由填）；兼容旧口径 data.rounds×data.x / data.x
  const legacyTotal=data.rounds!=null?Math.max(0,Number(data.rounds)||0)*Math.max(1,Number(data.x)||1):Math.max(1,Number(data.x)||1);
  const total=infinite?0:Math.max(1,Math.min(10000,Number(data.times??legacyTotal)||5));
  const scoreMode=["none","still","motion"].includes(data.scoreMode)?data.scoreMode:(data.score===true?"motion":"none");
  const score=scoreMode!=="none";
  const intervalSec=Math.max(0,Math.min(3600,Number(data.intervalSec)||30));
  if(pelicanAuto.running)throw Error('鹈鹕自动测试已在运行，先点停止');
  pelicanAutoRun(total,{scoreMode,score,intervalSec,infinite}).catch(e=>{pelicanAuto.lastError=String(e.message||e);pelicanAuto.running=false;});
  return {ok:true,started:true,times:total,infinite,scoreMode,score,intervalSec};}
 case 'pelican-auto-stop':{pelicanAuto.stop=true;return {ok:true,stopping:true};}
 case 'pelican-auto-status':{return {ok:true,running:pelicanAuto.running,stop:pelicanAuto.stop,done:pelicanAuto.done,total:pelicanAuto.total,infinite:pelicanAuto.infinite,round:pelicanAuto.round,totalRounds:pelicanAuto.totalRounds,x:pelicanAuto.x,score:pelicanAuto.score,scoreMode:pelicanAuto.scoreMode,intervalSec:pelicanAuto.intervalSec,current:pelicanAuto.current,results:pelicanAuto.results,lastError:pelicanAuto.lastError,startedAt:pelicanAuto.startedAt};}
 case 'pelican-archive-list':{const sc=pelicanArchiveScanAll();return {ok:true,exists:sc.exists,dayDir:sc.dayDir,total:sc.total,dates:sc.dates,counts:Object.fromEntries(Object.entries(sc.groups).map(([k,v])=>[k,v.filter(x=>!x.archived).length])),groups:sc.groups,skipped:sc.skipped};}
 case 'pelican-archive':{return pelicanArchiveByTier(data&&data.tiers);}
case 'pelican-archive-one':{
  const d=String((data&&data.date)||'').trim();
  const name=String((data&&data.name)||'').trim();
  const scan=pelicanArchiveScanAll();
  if(!scan.exists)throw Error('还没有鹈鹕文件夹：'+scan.dayDir);
  const item=pelicanFindItem(scan,name,d||null);
  if(!item)throw Error('找不到这个对话文件夹：'+name);
  if(item.archived)return {ok:true,already:true,name,tier:item.tier,date:item.date,to:item.date+'\\'+item.tier+'\\'+item.normalized};
  if(item.unscored){
    // 未评分的没有档位可进：照抄指纹归档的做法——指纹是把未识别会话挪进 Arena「已归档」，
    // 鹈鹕这边是把文件夹挪进同天文件夹下的 未评分 子文件夹，归档后不再出现在未评分列表里。
    const dayDir=path.join(scan.dayDir,item.date);
    const destDir=path.join(dayDir,'未评分');
    const dest=path.join(destDir,name);
    if(fs.existsSync(dest))return {ok:true,already:true,name,tier:'未评分',date:item.date,to:item.date+'\\未评分\\'+name};
    fs.mkdirSync(destDir,{recursive:true});
    fs.renameSync(path.join(dayDir,name),dest);
    return {ok:true,moved:true,name,tier:'未评分',date:item.date,score:null,mode:'still',to:item.date+'\\未评分\\'+name};
  }
  const dayDir=path.join(scan.dayDir,item.date);
  const destDir=path.join(dayDir,item.tier);
  const dest=path.join(destDir,item.normalized);
  if(fs.existsSync(dest))return {ok:true,already:true,name,tier:item.tier,date:item.date,to:item.date+'\\'+item.tier+'\\'+item.normalized};
  fs.mkdirSync(destDir,{recursive:true});
  fs.renameSync(path.join(dayDir,name),dest);
  return {ok:true,moved:true,name,tier:item.tier,date:item.date,score:item.score,mode:item.mode,to:item.date+'\\'+item.tier+'\\'+item.normalized};
}
case 'pelican-score-one':{
  // 未评分项补评分：只用首帧图走静帧评分（动画分封 0，满分 80），复用跑轮次时同一套 pelicanScore。
  // 有分后文件夹按静帧规则改名 R1-N_分数静，刷新列表后自动进对应档位，就能按档位归档了。
  const d=String((data&&data.date)||'').trim();
  const name=String((data&&data.name)||'').trim();
  const scan=pelicanArchiveScanAll();
  if(!scan.exists)throw Error('还没有鹈鹕文件夹：'+scan.dayDir);
  const item=pelicanFindItem(scan,name,d||null);
  if(!item)throw Error('找不到这个对话文件夹：'+name);
  if(!item.unscored)throw Error('这个对话已经有分数了，不用再评');
  const dayDir=path.join(scan.dayDir,item.date);
  const firstFile=path.join(dayDir,name,'首帧.png');
  if(!fs.existsSync(firstFile))throw Error('没有首帧图，评不了分');
  const scoreTag=await pelicanScore(firstFile,null,null,name);
  if(!scoreTag||scoreTag==='待评分')return {ok:false,error:'评委没出分（待评分）'+(pelicanScoreLastError?('：'+pelicanScoreLastError):'，稍后再试')};
  const score=Math.round(Number(scoreTag));
  if(!Number.isFinite(score))return {ok:false,error:'评委没出分（待评分）'+(pelicanScoreLastError?('：'+pelicanScoreLastError):'，稍后再试')};
  const m=/^R1-(\d+)/.exec(name);
  if(!m)throw Error('文件夹名不是 R1-序号，评不了分：'+name);
  const newName='R1-'+m[1]+'_'+score+'静';
  const dest=path.join(dayDir,newName);
  if(fs.existsSync(dest))return {ok:true,already:true,name:newName,oldName:name,tier:pelicanTier(score,'still'),date:item.date,score,to:item.date+'\\'+newName};
  fs.renameSync(path.join(dayDir,name),dest);
  return {ok:true,scored:true,name:newName,oldName:name,tier:pelicanTier(score,'still'),date:item.date,score,mode:'still',to:item.date+'\\'+newName};
}
case 'pelican-open-folder':{
  const d=String((data&&data.date)||'').trim();
  const name=String((data&&data.name)||'').trim();
  const scan=pelicanArchiveScanAll();
  const item=pelicanFindItem(scan,name,d||null);
  if(!item)throw Error('找不到这个对话文件夹：'+name);
  const dayDir=path.join(scan.dayDir,item.date);
  const full=item.archived?path.join(dayDir,item.tier,item.normalized):path.join(dayDir,item.name);
  const error=await shell.openPath(full);if(error)throw Error(error);return {ok:true};
}
case 'pelican-archive-unscored':{
  const scan=pelicanArchiveScanAll();
  if(!scan.exists)throw Error('还没有鹈鹕文件夹：'+scan.dayDir);
  const moved=[],already=[];
  for(const s of scan.skipped){
    const dayDir=path.join(scan.dayDir,s.date);
    const destDir=path.join(dayDir,'未评分');
    const src=path.join(dayDir,s.name); const dest=path.join(destDir,s.name);
    if(fs.existsSync(dest)){already.push({name:s.name,date:s.date,to:s.date+'\\未评分\\'+s.name});continue;}
    fs.mkdirSync(destDir,{recursive:true}); fs.renameSync(src,dest); moved.push({name:s.name,date:s.date,to:s.date+'\\未评分\\'+s.name});
  }
  return {ok:true,moved,already};
}
 case 'mail-import':{const {parseMailboxImport}=await import('./mail.mjs');const result=parseMailboxImport(data.text);for(const a of result.accounts){const existing=mailboxes.find(x=>x.email===a.email);if(existing)Object.assign(existing,a);else mailboxes.push(a);}saveVault();publish();return {imported:result.accounts.length,errors:result.errors};}
 case 'mail-open':await openMail(data.email);return {ok:true};
 case 'mail-copy':{const a=mailboxes.find(x=>x.email===data.email);if(!a)throw new Error('邮箱不存在');clipboard.writeText(data.field==='password'?a.password:a.email);return {ok:true};}
 case 'mail-remove':mailboxes=mailboxes.filter(a=>a.email!==data.email);saveVault();publish();return {ok:true};
 case 'mail-inbox':{const a=mailboxes.find(x=>x.email===data.email);if(!a)throw new Error('邮箱不存在');const {readOutlookInbox}=await import('./mail.mjs');
   const mailSession=session.fromPartition('persist:mail-'+crypto.createHash('sha256').update(a.email).digest('hex').slice(0,20));await applyProxy(mailSession,a.email);const result=await readOutlookInbox(a,(url,options)=>mailSession.fetch(url,{...options,signal:AbortSignal.timeout(30000)}));a.refreshToken=result.refreshToken;saveVault();return {messages:result.messages};}
 default:throw new Error('不支持的操作');
 }
 }catch(error){return {error:String(error.message||error)};}
});
function buildColdstart(){
  let script='';
  try{
    const tut=fs.readFileSync(path.join(COLDSTART_DIR,'冷启动包-主.txt'),'utf8');
    const a=tut.indexOf('[对话内容开始]'),b=tut.indexOf('[对话内容结束]');
    if(a>=0&&b>a)script=tut.slice(a+'[对话内容开始]'.length,b).trim();else script=tut.trim();
  }catch(e){throw Error('冷启动包-主.txt 读取失败（'+path.join(COLDSTART_DIR,'冷启动包-主.txt')+'）: '+(e.code||e.message));}
  if(!script)throw Error('冷启动包内容为空（'+path.join(COLDSTART_DIR,'冷启动包-主.txt')+' 读到了但提取长度为 0，通常是 [对话内容开始]/[对话内容结束] 之间为空）');
    return ['【Arena 冷启动包：一次粘贴，终端 + 全能 MCP 全部打通】','',
   '【第 1 步：安装 SSH 钥匙并验证隧道】',script,'',
   '预期结果：whoami 返回 wujie14\\shadow、hostname 返回 Wujie14。看到后继续第 2 步。','',
   '【第 2 步：接入全能 MCP（36 个工具）——只走 SSH 直连】',
'先在后台执行：ssh -F ~/.ssh/config -N -L 18765:127.0.0.1:8765 local-windows（经 local-windows 直连 Windows 本地 MCP，本地端口用 18765）',
'再对 http://127.0.0.1:18765/mcp 先发 initialize，预期返回里有 serverInfo，名字是 arena-desktop；只有 initialize 通了，再发 tools/list，预期 36 个工具。',
'直接发 tools/list、不先 initialize，服务器不会回包，curl 会超时，不要据此下结论。',
'之后所有本地操作都走该端点：POST http://127.0.0.1:18765/mcp（JSON-RPC：tools/list、tools/call）。',
'注意：同一轮内复用 18765 隧道：轮开始先确认 18765 在监听且 initialize/tools/list 通，通就整轮一直用这条隧道，不要每次调用完就杀掉、也不要重复起第二条；只有复用失败（端口不在监听或握手不通）时才重建。跨轮不能当常驻，因为沙箱后台隧道每轮结束会被回收。',
'若你的平台支持自定义 MCP 服务器：先后台执行 ssh -F ~/.ssh/config -N -L 18765:127.0.0.1:8765 local-windows，再把 http://127.0.0.1:18765/mcp（streamable-http）配置成 MCP 服务器。','',
   '【使用规则】',
   '1. 先 tools/list 确认工具，再开始任务。',
   '2. 工具以我的电脑本机用户权限全权运行；只做当前任务需要的操作。',
   '3. 完成后汇报结果；未执行的步骤明确说明。'].join('\n');
}
async function arenaSend(text){
  if(!arena||arena.webContents.isDestroyed())throw Error('右侧 Arena 网页未加载');
  const url=arena.webContents.getURL()||'';
  if(!/arena\.ai/i.test(url))throw Error('右侧当前不是 Arena 页面，请先在右侧点进目标会话');
  const r=await arena.webContents.executeJavaScript(`(async()=>{
    const t=${JSON.stringify(text)};
    const probes=['textarea[placeholder]','textarea','[contenteditable="true"]','div[role="textbox"]'];
    let input=null;
    for(const sel of probes){
      const els=[...document.querySelectorAll(sel)].filter(e=>e.offsetParent!==null);
      if(els.length){input=els[els.length-1];break;}
    }
    if(!input)return {ok:false,stage:'input',detail:'页面上没找到聊天输入框，请先点进一个会话'};
    input.focus();
    if(input.tagName==='TEXTAREA'||input.tagName==='INPUT'){
      const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const set=Object.getOwnPropertyDescriptor(proto,'value').set;
      set.call(input,'');
      set.call(input,t);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }else{
      document.execCommand('selectAll',false,null);
      document.execCommand('insertText',false,t);
    }
    await new Promise(r=>setTimeout(r,400));
    const btns=[...document.querySelectorAll('button,[role="button"]')].filter(b=>{
      if(b.disabled)return false;
      const s=((b.getAttribute('aria-label')||'')+' '+(b.title||'')+' '+(b.getAttribute('data-testid')||'')+' '+(b.textContent||'')).toLowerCase();
      return /send|发送|submit|提交/.test(s);
    });
    if(btns.length){btns[btns.length-1].click();return {ok:true,how:'button',found:btns.length};}
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));
    return {ok:true,how:'enter'};
  })()`,true);
  if(!r||!r.ok)throw Error('注入失败：'+((r&&r.detail)||'未知原因'));
  return r;
}
// ---- 鹈鹕自动测试（实验版，替代指纹三轮抽卡）----
// 流程：建轮（新建 X 个对话、各发一次鹈鹕提示词、间隔 60 秒）→ 收图（按顺序回访每个对话、等图片至多 30 秒、有图保存到 选妃资料\鹈鹕\YYYY-MM-DD\）→ 打分重命名（暂无本地视觉评委，分数位标“待评分”）→ 下一轮或停止。
// 打分结论：工作台本地没有任何能看图的多模态模型/视觉评委（已全仓检索 vision/multimodal/judge/image-score，均无）。分数只能等接外部多模态评委（例如 auto-pelican 那种把图发给多模态 LLM 打分的做法）后再补。
const PELICAN_PROMPT='请用 SVG 输出一只骑自行车的鹈鹕的 2D 动画。要求：创建一个 HTML，内容是 SVG 绘制的鹈鹕骑自行车 2D 动画，动画自动循环播放，不要任何解释文字或代码块标记。';
const pelicanAuto={running:false,stop:false,round:0,totalRounds:0,x:1,done:0,total:0,infinite:false,score:false,scoreMode:'none',intervalSec:30,results:[],lastError:null,current:null,startedAt:null};
function pelicanSleep(ms){return new Promise(w=>setTimeout(w,ms));}
async function pelicanSleepOrStop(ms){const end=Date.now()+ms;while(Date.now()<end){if(pelicanAuto.stop)return false;await pelicanSleep(Math.min(1000,end-Date.now()));}return !pelicanAuto.stop;}
function pelicanSessionIdFromUrl(url){const m=String(url||'').match(/\/agent\/([a-f0-9-]{36})/i);return m?m[1]:'';}
function pelicanArenaUrl(){return arena&&!arena.webContents.isDestroyed()?arena.webContents.getURL()||'':'';}
async function pelicanWaitSessionId(timeoutMs,notId){
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
    if(pelicanAuto.stop)return '';
    const sid=pelicanSessionIdFromUrl(pelicanArenaUrl());
    if(sid&&sid!==notId)return sid;
    await pelicanSleep(2000);
  }
  return pelicanSessionIdFromUrl(pelicanArenaUrl());
}
async function pelicanNewSession(){
  if(!arena||arena.webContents.isDestroyed())throw Error('右侧 Arena 网页未加载');
  currentView='arena';layout();
  await arena.webContents.loadURL('https://arena.ai/agent').catch(()=>{});
  await pelicanSleep(3500);
  try{await arena.webContents.executeJavaScript(`(()=>{const btns=[...document.querySelectorAll('button,a')].filter(b=>{const t=(b.textContent||'').trim();return /^(New chat|新对话|新会话|新建对话)$/i.test(t)&&b.offsetParent!==null;});if(btns.length){btns[0].click();return true;}return false;})()`,true);}catch{}
  await pelicanSleep(1500);
  return pelicanSessionIdFromUrl(pelicanArenaUrl());
}
async function pelicanFindVisual(){
  try{
    return await arena.webContents.executeJavaScript(`(async()=>{
      const find=()=>{
        const cands=[];
        for(const im of document.querySelectorAll('img')){
          if(im.offsetParent===null)continue;
          const r=im.getBoundingClientRect();
          if(r.width<150||r.height<100)continue;
          if(/avatar|logo|icon|emoji/i.test((im.src||'')+(im.alt||'')+(im.className||'')))continue;
          cands.push({kind:'img',el:im,x:r.x,y:r.y,w:r.width,h:r.height,src:im.currentSrc||im.src});
        }
        for(const fr of document.querySelectorAll('iframe')){
          if(fr.offsetParent===null)continue;
          const r=fr.getBoundingClientRect();
          if(r.width<200||r.height<150)continue;
          cands.push({kind:'iframe',el:fr,x:r.x,y:r.y,w:r.width,h:r.height});
        }
        for(const cv of document.querySelectorAll('canvas')){
          if(cv.offsetParent===null)continue;
          const r=cv.getBoundingClientRect();
          if(r.width<200||r.height<150)continue;
          cands.push({kind:'canvas',el:cv,x:r.x,y:r.y,w:r.width,h:r.height});
        }
        if(!cands.length)return null;
        cands.sort((a,b)=>((a.y+a.h)-(b.y+b.h)));
        return cands[cands.length-1];
      };
      let v=find();
      if(!v)return null;
      v.el.scrollIntoView({block:'center'});
      await new Promise(r=>setTimeout(r,800));
      const v2=find();
      if(!v2)return null;
      return {kind:v2.kind,x:v2.x,y:v2.y,w:v2.w,h:v2.h,src:v2.src||''};
    })()`,true);
  }catch(e){return null;}
}
async function pelicanWaitVisual(timeoutMs){
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
    if(pelicanAuto.stop)return null;
    const v=await pelicanFindVisual();
    if(v){await pelicanSleep(10000);if(pelicanAuto.stop)return null;return await pelicanFindVisual()||v;}
    await pelicanSleep(5000);
  }
  return null;
}
async function pelicanCaptureVisual(v,file){
  if(v&&v.kind==='img'&&v.src&&/^https?:\/\//i.test(v.src)){
    try{
      const res=await arena.webContents.session.fetch(v.src);
      if(res.ok){
        const buf=Buffer.from(await res.arrayBuffer());
        if(buf.length>1024){fs.writeFileSync(file,buf);return {saved:file,via:'download',bytes:buf.length};}
      }
    }catch{}
  }
  // 优先用 CDP 截图（capturePage 抓不到跨域 iframe 内容，会是空白；实测 CDP 能抓到鹈鹕）
  if(v){
    try{
      const dbg=arena.webContents.debugger;
      dbg.attach();
      try{
        const res=await dbg.sendCommand('Page.captureScreenshot',{format:'png',clip:{x:Math.round(v.x),y:Math.round(v.y),width:Math.round(v.w),height:Math.round(v.h),scale:1}});
        if(res&&res.data){
          const buf=Buffer.from(res.data,'base64');
          if(buf.length>1024){fs.writeFileSync(file,buf);return {saved:file,via:'cdp-clip',bytes:buf.length};}
        }
      }finally{
        try{dbg.detach();}catch{}
      }
    }catch{}
  }
  // 回退：capturePage 区域截图
  const rect=v?{x:Math.max(0,Math.round(v.x)),y:Math.max(0,Math.round(v.y)),width:Math.round(v.w),height:Math.round(v.h)}:null;
  const shot=rect?await arena.webContents.capturePage(rect):await arena.webContents.capturePage();
  const png=shot.toPNG();
  fs.writeFileSync(file,png);
  return {saved:file,via:rect?'capture-rect':'capture-full',bytes:png.length};
}

async function pelicanRename(sessionId,title){
  if(!pelicanArenaUrl().includes('/agent/'+sessionId))throw Error('会话已切换，未改名');
  const ok=await arena.webContents.executeJavaScript(`(async()=>{
    const pclick=(el)=>{const rr=el.getBoundingClientRect();const cx=rr.x+rr.width/2,cy=rr.y+rr.height/2;const base={bubbles:true,cancelable:true,view:window,button:0,clientX:cx,clientY:cy};el.dispatchEvent(new PointerEvent('pointerover',Object.assign({},base,{pointerId:1,pointerType:'mouse',isPrimary:true})));el.dispatchEvent(new MouseEvent('mouseover',base));el.dispatchEvent(new PointerEvent('pointerdown',Object.assign({},base,{pointerId:1,pointerType:'mouse',isPrimary:true,buttons:1})));el.dispatchEvent(new MouseEvent('mousedown',Object.assign({},base,{buttons:1})));el.dispatchEvent(new PointerEvent('pointerup',Object.assign({},base,{pointerId:1,pointerType:'mouse',isPrimary:true,buttons:0})));el.dispatchEvent(new MouseEvent('mouseup',Object.assign({},base,{buttons:0})));el.dispatchEvent(new MouseEvent('click',Object.assign({},base,{buttons:0})));};
    const id=${JSON.stringify(sessionId)};
    const title=${JSON.stringify(String(title).slice(0,100))};
    const row=[...document.querySelectorAll('a[data-sidebar="menu-button"][href="/agent/'+id+'"]')].pop();
    if(!row)return {ok:false,detail:'侧栏未显示当前会话'};
    const item=row.closest('[data-sidebar="menu-item"]')||row.parentElement;
    const trigger=item&&item.querySelector('button[data-sidebar="menu-action"]');
    if(!trigger)return {ok:false,detail:'找不到会话菜单按钮'};
    pclick(trigger);
    await new Promise(r=>setTimeout(r,900));
    const mi=[...document.querySelectorAll('[role="menuitem"]')].find(b=>/^(Rename|重命名|重命名对话)$/.test((b.textContent||'').trim()));
    if(!mi)return {ok:false,detail:'找不到重命名菜单'};
    pclick(mi);
    await new Promise(r=>setTimeout(r,600));
    const dlg=document.querySelector('[role="dialog"]');
    if(!dlg)return {ok:false,detail:'未弹出重命名对话框'};
    const input=dlg.querySelector('input');
    if(!input)return {ok:false,detail:'对话框里没有输入框'};
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(input,'');set.call(input,title);
    input.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,300));
    const confirm=[...dlg.querySelectorAll('button')].find(b=>/^(Rename|重命名|保存)$/.test((b.textContent||'').trim()));
    if(!confirm)return {ok:false,detail:'找不到确认按钮'};
    pclick(confirm);
    await new Promise(r=>setTimeout(r,1500));
    const done=[...document.querySelectorAll('a[href]')].some(a=>a.getAttribute('href')==='/agent/'+id&&(a.textContent||'').includes(title));
    return {ok:done};
  })()`,true);
  if(!ok||!ok.ok)throw Error('改名失败：'+((ok&&ok.detail)||'未知原因'));
  return true;
}
// 评分：auto-pelican 评委法——把收到的图发给本地 8787 的 gemini-3.8-flash-high（Anthropic /v1/messages，多模态），
// 按 24 个可见要素核对、7 项 0–5 分、6 个维度加权算 0–100 总分。
// 密钥不写死在代码里：读同目录 pelican-score.json（{baseUrl,model,apiKey}），环境变量 OCTOPUS_API_KEY / OCTOPUS_BASE_URL / OCTOPUS_MODEL 可覆盖。
// 没有密钥或调用失败一律返回“待评分”，绝不编分数。三档：不评分不调评委；静帧评分只发首帧，动画按 0 封顶，满分 80；静动评分收图后在浏览器里采 6 帧拼成帧拼图，首帧 + 帧拼图一起发给评委，动画从 6 帧的变化里判断，满分 100；拼图失败时退回单静帧，动画按 0 封顶、按静帧分档。分档：静帧 <45 差、45–48 中、49–52 良、>=53 优；动图 <60 差、60–65 中、66–72 良、>72 优。档位只内部用（按分数归档时用），不写进文件夹名和对话名；名字只有分数+序号，如 R1-1_51静、R1-1_73。
const PELICAN_SCORE_FILE=path.join(__dirname,'pelican-score.json');
const PELICAN_JUDGE_CHECKLIST={
  pelican_identifiable:'a pelican is identifiable',pelican_long_bill:'pelican has a long bill',pelican_throat_pouch:'pelican has a visible throat pouch',pelican_eye:'pelican has a visible eye',pelican_wing:'pelican has a visible wing',pelican_legs_or_feet:'pelican has visible legs or feet',
  bicycle_identifiable:'a bicycle is identifiable',bicycle_two_wheels:'bicycle has exactly two wheels',bicycle_frame_connects_wheels:'bicycle frame connects the wheels',bicycle_handlebars:'bicycle has handlebars',bicycle_saddle:'bicycle has a saddle',bicycle_pedals_or_crank:'bicycle has pedals or a crank',bicycle_chain_or_chainring:'bicycle has a chain or chainring',
  pelican_mounted:'pelican is mounted on the bicycle',feet_on_pedals:'feet are on the pedals',wing_on_handlebars:'wing is on the handlebars',plausible_scale:'pelican-to-bicycle scale is plausible',subjects_fully_in_frame:'subjects are fully in frame',no_detached_parts:'no detached parts',no_major_artifacts:'no major artifacts',
  motion_visible:'motion is visible',wheels_rotate:'wheels rotate',legs_pedal:'legs pedal',parts_stay_attached_in_motion:'parts stay attached in motion'};
const PELICAN_JUDGE_SCORE_KEYS=['prompt_fidelity','pelican_quality','bicycle_quality','interaction_spatial_correctness','animation_quality','visual_coherence','aesthetic_quality'];
const PELICAN_JUDGE_WEIGHTS={prompt_fidelity:0.15,object_quality:0.20,interaction_spatial_correctness:0.20,animation_quality:0.20,visual_coherence:0.15,aesthetic_quality:0.10};
const PELICAN_JUDGE_CAPS={pelican_identifiable:{prompt_fidelity:2,pelican_quality:2},bicycle_identifiable:{prompt_fidelity:2,bicycle_quality:2},pelican_mounted:{interaction_spatial_correctness:2},subjects_fully_in_frame:{aesthetic_quality:3},no_detached_parts:{visual_coherence:3},no_major_artifacts:{visual_coherence:3},motion_visible:{animation_quality:1},parts_stay_attached_in_motion:{animation_quality:3,visual_coherence:3}};
const PELICAN_JUDGE_SYSTEM_PROMPT=`You are a strict, well-calibrated art director grading a rendered SVG illustration. Be factual and precise. Do not be generous: a score of 5 means excellent in that dimension; a score of 0 means the content is missing or unusable. Look carefully before scoring. Do not describe the image, only grade it.

You receive two images. Image 1 is a single still frame rendered from the SVG (the first frame). Image 2 is a contact sheet of 6 frames sampled across one animation cycle, in reading order (top-left to bottom-right). Judge motion from Image 2: compare the frames — do the wheels rotate, do the legs pedal, do parts stay attached while moving? If the 6 frames are identical, there is no visible motion: mark all four motion checklist items false and set animation_quality to 0.

Use the provided prompt and SVG description to judge how well the rendered frame matches the intended content.

STEP 1 — CHECKLIST (exact keys; values must be boolean true/false):
${Object.entries(PELICAN_JUDGE_CHECKLIST).map(([k, v]) => `${k}: ${v}`).join('\n')}

STEP 2 — SCORES (0–5 integers only; 0 = poor or missing, 5 = excellent):
prompt_fidelity: 0–5 (does the frame show the requested subject: a pelican riding a bicycle?)
pelican_quality: 0–5 (how good is the pelican: shape, anatomy, proportions, recognisability?)
bicycle_quality: 0–5 (how good is the bicycle: wheels, frame, handlebars, saddle, pedals?)
interaction_spatial_correctness: 0–5 (is the pelican plausibly riding the bicycle: mounted, feet on pedals, wing on handlebars, plausible scale, no detached parts?)
animation_quality: 0–5 (judged from the 6-frame contact sheet: 0 if the frames are identical, higher when wheels rotate, legs pedal and parts stay attached)
visual_coherence: 0–5 (is the image coherent: no detached parts, no major artifacts, subjects fully in frame?)
aesthetic_quality: 0–5 (overall visual appeal: composition, colour, style, readability?)

STEP 3 — HARD RULES:
- Use integers 0–5 for scores. Do not use .5 values.
- Do not be generous. Use the full scale: score 5 only when the dimension is truly excellent.
- If no pelican is visible, pelican_quality must be 0. If no bicycle is visible, bicycle_quality must be 0.
- If the pelican is not mounted on the bicycle, interaction_spatial_correctness must be at most 2.
- If a motion cue is not visible, animation_quality must be low or 0.
- Do not inflate scores because the image is a cartoon or a simple drawing.

OUTPUT FORMAT - THIS IS MANDATORY AND THE ONLY ACCEPTABLE OUTPUT:
Return a single JSON object and nothing else (no markdown fences, no commentary, no extra keys, no renamed keys, no additional fields):
{"checklist":{"pelican_identifiable":true,"pelican_long_bill":true,"pelican_throat_pouch":true,"pelican_eye":true,"pelican_wing":true,"pelican_legs_or_feet":true,"bicycle_identifiable":true,"bicycle_two_wheels":true,"bicycle_frame_connects_wheels":true,"bicycle_handlebars":true,"bicycle_saddle":true,"bicycle_pedals_or_crank":true,"bicycle_chain_or_chainring":true,"pelican_mounted":true,"feet_on_pedals":true,"wing_on_handlebars":true,"plausible_scale":true,"subjects_fully_in_frame":true,"no_detached_parts":true,"no_major_artifacts":true,"motion_visible":true,"wheels_rotate":true,"legs_pedal":true,"parts_stay_attached_in_motion":true},"notes":"...","scores":{"aesthetic_quality":0,"animation_quality":3,"bicycle_quality":0,"interaction_spatial_correctness":0,"pelican_quality":0,"prompt_fidelity":0,"visual_coherence":0}}

The "checklist" must include all 24 keys exactly as given above, with boolean values. The "scores" must include all 7 keys exactly as given above, with integer values from 0 to 5. Do not invent any other key names.`;
function pelicanScoreConfig(){
  let fileCfg={};try{fileCfg=JSON.parse(fs.readFileSync(PELICAN_SCORE_FILE,'utf8'));}catch(e){}
  const apiKey=String(process.env.OCTOPUS_API_KEY||fileCfg.apiKey||'').trim();
  return {baseUrl:String(process.env.OCTOPUS_BASE_URL||fileCfg.baseUrl||'http://127.0.0.1:8787/v1').replace(/\/+$/,''),model:String(process.env.OCTOPUS_MODEL||fileCfg.model||'gemini-3.8-flash-high'),apiKey,protocol:String(process.env.OCTOPUS_PROTOCOL||fileCfg.protocol||'openai')};
}
function pelicanJudgeOverall(checklist,scores,hasStrip){
  const caps=[];
  for(const [check,cap] of Object.entries(PELICAN_JUDGE_CAPS))if(checklist[check]===false)for(const [sk,capV] of Object.entries(cap))caps.push([sk,capV,check]);
  if(!hasStrip)caps.push(['animation_quality',0,'single still frame']);
  const capped={...scores};
  for(const [sk,capV] of caps)capped[sk]=Math.min(capped[sk],capV);
  const criteria={prompt_fidelity:capped.prompt_fidelity,object_quality:(capped.pelican_quality+capped.bicycle_quality)/2,interaction_spatial_correctness:capped.interaction_spatial_correctness,animation_quality:capped.animation_quality,visual_coherence:capped.visual_coherence,aesthetic_quality:capped.aesthetic_quality};
  return Math.round(Object.entries(PELICAN_JUDGE_WEIGHTS).reduce((acc,[k,w])=>acc+w*criteria[k]/5,0)*100*10)/10;
}
function pelicanParseJudge(text,hasStrip){
  const m=text.match(/\{[\s\S]*\}/);
  if(m){
    try{
      const obj=JSON.parse(m[0]);
      const checklist=obj.checklist||{},scores=obj.scores||{};
      for(const k of Object.keys(PELICAN_JUDGE_CHECKLIST))if(typeof checklist[k]!=='boolean')throw Error('评委 checklist 缺项：'+k);
      for(const k of PELICAN_JUDGE_SCORE_KEYS)if(!Number.isInteger(scores[k])||scores[k]<0||scores[k]>5)throw Error('评委 scores 缺项或越界：'+k);
      return pelicanJudgeOverall(checklist,scores,hasStrip);
    }catch(e){/* 掉到下面的容错抠键 */}
  }
  // 容错：评委不按整 JSON 回时，分别抠 24 个 checklist 键和 7 个 scores 键；缺任何一个仍拒收，不编分
  const checklist={},scores={};
  for(const k of Object.keys(PELICAN_JUDGE_CHECKLIST)){
    const mm=text.match(new RegExp('"'+k+'"\\s*:\\s*(true|false)'));
    if(!mm)throw Error('评委 checklist 缺项：'+k);
    checklist[k]=mm[1]==='true';
  }
  for(const k of PELICAN_JUDGE_SCORE_KEYS){
    const mm=text.match(new RegExp('"'+k+'"\\s*:\\s*(\\d+(?:\\.\\d+)?)'));
    if(!mm)throw Error('评委 scores 缺项或越界：'+k);
    const v=Number(mm[1]);
    if(!Number.isInteger(v)||v<0||v>5)throw Error('评委 scores 缺项或越界：'+k);
    scores[k]=v;
  }
  return pelicanJudgeOverall(checklist,scores,hasStrip);
}
// 分档（用户 2026-11-09 定）：静帧满分 80：<45 差、45–48 中、49–52 良、>=53 优；
// 动图满分 100：<60 差、60–65 中、66–72 良、>72 优。score 为“待评分”等非数字时返回 ''。
function pelicanTier(score,scoreMode){
  const n=Number(score);
  if(!Number.isFinite(n))return '';
  if(scoreMode==='still')return n<45?'差':n<=48?'中':n<=52?'良':'优';
  return n<60?'差':n<=65?'中':n<=72?'良':'优';
}
let pelicanScoreLastError='';
async function pelicanScore(file,stripFile,roundIndex,label){
  const who=label||((roundIndex!=null)?('R1-'+roundIndex):'补评分');
  const fail=(reason)=>{pelicanScoreLastError=reason;try{trace('pelican score '+who+' failed: '+reason);}catch{ }return '待评分';};
  try{
    const cfg=pelicanScoreConfig();
    if(!cfg.apiKey&&!/^https?:\/\/(127\.0\.0\.1|localhost):8787\//.test(cfg.baseUrl))return fail('未配置评委：pelican-score.json 无 apiKey 且 baseUrl 不是本地 8787');
    const hasStrip=!!(stripFile&&fs.existsSync(stripFile));
    const b64=fs.readFileSync(file).toString('base64');
    const stripB64=hasStrip?fs.readFileSync(stripFile).toString('base64'):null;
    const userText=hasStrip?'Evaluate the two images: Image 1 is the first frame, Image 2 is a contact sheet of 6 frames sampled across one animation cycle. Judge motion from Image 2 and output JSON only.':'Evaluate the single still frame following the instructions and output JSON only.';
    const base=cfg.baseUrl.replace(/\/v1\/?$/,'');
    for(let attempt=0;attempt<3;attempt++){
      let text='';
      if(cfg.protocol==='anthropic'){
        const content=[{type:'text',text:userText},{type:'image',source:{type:'base64',media_type:'image/png',data:b64}}];
        if(hasStrip)content.push({type:'text',text:'Image 2 (6-frame contact sheet):'},{type:'image',source:{type:'base64',media_type:'image/png',data:stripB64}});
        const res=await fetch(base+'/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','anthropic-version':'2023-06-01','x-api-key':(cfg.apiKey||'test')},body:JSON.stringify({model:cfg.model,max_tokens:4096,temperature:0,system:PELICAN_JUDGE_SYSTEM_PROMPT,messages:[{role:'user',content}]}),signal:AbortSignal.timeout(120000)});
        if(!res.ok)return fail('评委接口返回 HTTP '+res.status+'（anthropic /v1/messages）');
        const data=await res.json().catch(()=>null);
        text=Array.isArray(data&&data.content)?data.content.filter(c=>c&&c.type==='text').map(c=>String(c.text||'')).join(''):'';
      }else{
        const content=[{type:'text',text:userText},{type:'image_url',image_url:{url:'data:image/png;base64,'+b64}}];
        if(hasStrip)content.push({type:'text',text:'Image 2 (6-frame contact sheet):'},{type:'image_url',image_url:{url:'data:image/png;base64,'+stripB64}});
        const res=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':(cfg.apiKey?('Bearer '+cfg.apiKey):undefined)},body:JSON.stringify({model:cfg.model,messages:[{role:'system',content:PELICAN_JUDGE_SYSTEM_PROMPT},{role:'user',content}],max_tokens:4096,temperature:0}),signal:AbortSignal.timeout(120000)});
        if(!res.ok)return fail('评委接口返回 HTTP '+res.status+'（openai /v1/chat/completions）');
        const data=await res.json().catch(()=>null);
        text=data&&data.choices&&data.choices[0]&&data.choices[0].message?String(data.choices[0].message.content||''):'';
      }
      try{pelicanScoreLastError='';return String(pelicanParseJudge(text,hasStrip));}catch(e){/* 格式不对再试一次 */}
    }
    return fail('评委返回内容解析不出分数（3 次尝试都失败）');
  }catch(e){
    if(e&&e.name==='TimeoutError')return fail('评委调用 120 秒超时');
    return fail('评分异常：'+String((e&&e.message)||e));
  }
}
// 动图采帧：动画已在 Arena 对话页里循环播放，直接对着 live 画面连截 6 张（间隔 600ms，覆盖约 3 秒，
// 常见鹈鹕 SVG 循环 2–4 秒）。不用另找 SVG 源码、不用渲染——模型出的图本来就在页上动。
// CDP 截不到时回退 capturePage。采不到 3 张以上返回 []，调用方退回单静帧评分。
async function pelicanCaptureFrames(v,tmpDir){
  const files=[];
  const clip=v?{x:Math.round(v.x),y:Math.round(v.y),width:Math.round(v.w),height:Math.round(v.h),scale:1}:null;
  let attached=false;
  try{
    if(clip){try{arena.webContents.debugger.attach();attached=true;}catch{}}
    for(let k=0;k<6;k++){
      if(pelicanAuto.stop)break;
      if(k>0)await pelicanSleep(600);
      const f=path.join(tmpDir,'frame-'+(k+1)+'.png');
      let ok=false;
      if(attached){
        try{
          const res=await arena.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',clip});
          if(res&&res.data){const buf=Buffer.from(res.data,'base64');if(buf.length>1024){fs.writeFileSync(f,buf);ok=true;}}
        }catch{}
      }
      if(!ok){
        try{
          const rect=clip?{x:Math.max(0,clip.x),y:Math.max(0,clip.y),width:clip.width,height:clip.height}:null;
          const shot=rect?await arena.webContents.capturePage(rect):await arena.webContents.capturePage();
          const png=shot.toPNG();
          if(png.length>1024){fs.writeFileSync(f,png);ok=true;}
        }catch{}
      }
      if(ok)files.push(f);
    }
  }finally{
    if(attached){try{arena.webContents.debugger.detach();}catch{}}
  }
  return files;
}
// 帧拼图：把 6 帧放进一个 3 列 x 2 行的隐藏窗口里排好，再整页截成一张图。不引任何新依赖，只用 Electron 自带能力。
async function pelicanBuildStrip(frameFiles,stripFile){
  const tmpDir=path.dirname(stripFile);
  const sheetPath=path.join(tmpDir,'sheet.html');
  let cellH=300;
  try{
    const sz=nativeImage.createFromPath(frameFiles[0]).getSize();
    if(sz.width>0&&sz.height>0)cellH=Math.max(120,Math.min(600,Math.round(400*sz.height/sz.width)));
  }catch{}
  const html='<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:0;display:grid;grid-template-columns:repeat(3,400px);}img{width:400px;display:block;}</style></head><body>'+frameFiles.map(f=>'<img src="'+path.basename(f)+'">').join('')+'</body></html>';
  fs.writeFileSync(sheetPath,html,'utf8');
  let win=null;
  try{
    win=new BrowserWindow({width:1200,height:cellH*2,show:false,backgroundColor:'#ffffff',webPreferences:{}});
    await new Promise((resolve,reject)=>{
      const to=setTimeout(()=>reject(new Error('sheet load timeout')),20000);
      win.webContents.once('did-finish-load',()=>{clearTimeout(to);resolve();});
      win.webContents.once('did-fail-load',()=>{clearTimeout(to);reject(new Error('sheet load failed'));});
      win.loadFile(sheetPath);
    });
    await pelicanSleep(800);
    const png=(await win.webContents.capturePage()).toPNG();
    if(png.length<5120)throw new Error('帧拼图空白或过小');
    fs.writeFileSync(stripFile,png);
    return true;
  }catch(e){trace('pelican strip failed: '+String(e.message||e));return false;}
  finally{
    try{fs.unlinkSync(sheetPath);}catch{}
    if(win&&!win.isDestroyed()){try{win.destroy();}catch{}}
  }
}
// 按分数归档：把某天文件夹里已评分的文件夹，按档位挪进同天文件夹下的 优/良/中/差 子文件夹，
// 每个档位里还是分数+序号的文件夹。名字只认分数+序号（R1-3_51静 / R1-1_73），
// 旧的带档位名（R1-1_51良静 / R1-1_73优）也认，挪过去时顺手把档位从名字里去掉。
// 没分数的（不评分 / 待评分）归不了档，跳过并上报。tier 只在这里用，不写进名字。
function pelicanScanItem(full,name,archived,tierOverride){
  let st; try{st=fs.statSync(full);}catch{return null;}
  if(!st.isDirectory())return null;
  const m=/^R1-(\d+)_(\d+)(优|良|中|差)?(静)?$/.exec(name);
  if(!m)return null;
  const score=Number(m[2]);
  const mode=m[4]==='静'?'still':'motion';
  const tier=tierOverride||pelicanTier(score,mode);
  if(!tier)return null;
  let files=[]; try{files=fs.readdirSync(full);}catch{}
  return {name,score,mode,tier,archived:!!archived,normalized:'R1-'+m[1]+'_'+score+(mode==='still'?'静':''),collectedAt:new Date(st.mtimeMs).toISOString(),hasFirst:files.includes('首帧.png'),hasStrip:files.includes('帧拼图.png'),hasHtml:files.includes('动画.html')};
}
function pelicanArchiveScan(dateStr){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(dateStr))throw Error('日期格式不对');
  const dayDir=path.join(EXAM_DIR,'鹈鹕',dateStr);
  const groups={'优':[],'良':[],'中':[],'差':[]};
  const skipped=[];
  if(!fs.existsSync(dayDir))return {date:dateStr,dayDir,groups,skipped,exists:false,total:0};
  for(const name of fs.readdirSync(dayDir)){
    const full=path.join(dayDir,name);
    let st; try{st=fs.statSync(full);}catch{continue;}
    if(!st.isDirectory())continue;
    if(name.endsWith('_tmp'))continue; // 进行中的临时文件夹不进归档列表
    if(['优','良','中','差','未评分'].includes(name)){
      // 已归档进档位文件夹的也列出来（archived:true），列表页照搬主页、全部显示
      if(['优','良','中','差'].includes(name)){
        for(const sub of fs.readdirSync(full)){
          const item=pelicanScanItem(path.join(full,sub),sub,true,name);
          if(item)groups[name].push(item);
        }
      }
      continue;
    }
    const item=pelicanScanItem(full,name,false);
    if(!item){let _f=[];try{_f=fs.readdirSync(full);}catch{} skipped.push({name,reason:'没有分数，归不了档',hasFirst:_f.includes('首帧.png'),hasStrip:_f.includes('帧拼图.png'),hasHtml:_f.includes('动画.html'),collectedAt:new Date(st.mtimeMs).toISOString()});continue;}
    groups[item.tier].push(item);
  }
  const total=Object.values(groups).reduce((n,a)=>n+a.length,0);
  return {date:dateStr,dayDir,groups,skipped,exists:true,total};
}
// 按分数归档不按日期：扫 选妃资料\鹈鹕\ 下全部 YYYY-MM-DD 文件夹，四个档（优/良/中/差）就是四个大分类，
// 照抄指纹那边“大模型分组里装小模型”的做法。每个对话自带抽到日期（date 只当卡片信息，不当筛选条件）。
function pelicanArchiveScanAll(){
  const root=path.join(EXAM_DIR,'鹈鹕');
  const groups={'优':[],'良':[],'中':[],'差':[]};
  const skipped=[];
  const dates=[];
  if(!fs.existsSync(root))return {dayDir:root,groups,skipped,exists:false,total:0,dates};
  for(const d of fs.readdirSync(root).sort()){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(d))continue;
    let sc; try{sc=pelicanArchiveScan(d);}catch{continue;}
    if(!sc.exists)continue;
    dates.push(d);
    for(const t of ['优','良','中','差'])for(const it of sc.groups[t])groups[t].push({...it,date:d});
    for(const x of sc.skipped)skipped.push({...x,date:d});
  }
  const total=Object.values(groups).reduce((n,a)=>n+a.length,0);
  return {dayDir:root,groups,skipped,exists:dates.length>0,total,dates};
}
function pelicanFindItem(scan,name,date){
  for(const t of ['优','良','中','差']){
    const f=scan.groups[t].find(x=>x.name===name&&(!date||x.date===date));
    if(f)return f;
  }
  // 未评分的也在 skipped 里：之前这里只找四个档位，所以未评分项永远“找不到”，归档/打开都无效。
  const s=(scan.skipped||[]).find(x=>x.name===name&&(!date||x.date===date));
  if(s)return {...s,unscored:true};
  return null;
}
function pelicanArchiveByTier(tiers){
  const scan=pelicanArchiveScanAll();
  if(!scan.exists)return {ok:false,error:'还没有鹈鹕文件夹：'+scan.dayDir};
  const wanted=(Array.isArray(tiers)?tiers:[]).filter(t=>['优','良','中','差'].includes(t));
  if(!wanted.length)return {ok:false,error:'先勾要归档的档位'};
  const moved=[],already=[];
  for(const tier of wanted){
    for(const item of scan.groups[tier].filter(x=>!x.archived)){
      const dayDir=path.join(scan.dayDir,item.date);
      const destDir=path.join(dayDir,tier);
      const src=path.join(dayDir,item.name);
      const dest=path.join(destDir,item.normalized);
      if(fs.existsSync(dest)){already.push({name:item.name,tier,date:item.date,to:item.date+'\\'+tier+'\\'+item.normalized,reason:'目标里已经有了'});continue;}
      fs.mkdirSync(destDir,{recursive:true});
      fs.renameSync(src,dest);
      moved.push({name:item.name,tier,date:item.date,score:item.score,mode:item.mode,to:item.date+'\\'+tier+'\\'+item.normalized});
    }
  }
  return {ok:true,moved,already,skipped:scan.skipped,counts:Object.fromEntries(Object.entries(scan.groups).map(([k,v])=>[k,v.filter(x=>!x.archived).length]))};
}
async function pelicanAutoRun(total,opts={}){
  const infinite=opts.infinite===true;
  pelicanAuto.running=true;pelicanAuto.stop=false;pelicanAuto.done=0;pelicanAuto.total=total;pelicanAuto.infinite=infinite;pelicanAuto.round=0;pelicanAuto.totalRounds=total;pelicanAuto.x=1;pelicanAuto.scoreMode=["none","still","motion"].includes(opts.scoreMode)?opts.scoreMode:(opts.score===true?"motion":"none");pelicanAuto.score=pelicanAuto.scoreMode!=="none";pelicanAuto.intervalSec=Math.max(0,Math.min(3600,Number(opts.intervalSec)||30));pelicanAuto.results=[];pelicanAuto.lastError=null;pelicanAuto.current=null;pelicanAuto.startedAt=new Date().toISOString();
  const now=new Date();
  const dateStr=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
  const outDir=path.join(EXAM_DIR,'鹈鹕',dateStr);
  fs.mkdirSync(outDir,{recursive:true});
  try{
    let i=0;
    while(!pelicanAuto.stop&&(infinite||i<total)){
      i+=1;pelicanAuto.done=i;pelicanAuto.round=i;
      const t0=Date.now();const dur=()=>Math.round((Date.now()-t0)/1000);
      const pushResult=(r)=>{pelicanAuto.results.push(r);try{trace('pelican round '+r.index+' '+(r.ok?'ok':'failed')+' 用时 '+r.durationSec+' 秒'+(r.ok&&r.score&&r.score!=='不评分'?(' · '+r.score+(r.tier?('（'+r.tier+'档）'):'')):'')+(r.ok?'':(' · '+(r.reason||''))));}catch{}};
      // 顺序：一个对话发完、等图、收图、存好，再建下一个对话；不再先发完一轮再回头收
      pelicanAuto.current={phase:'send',round:1,index:i,total:infinite?null:total};
      const beforeId=await pelicanNewSession();
      if(pelicanAuto.stop)break;
      const r=await arenaSend(PELICAN_PROMPT);
      if(!r||!r.ok){pushResult({round:1,index:i,ok:false,reason:'发送鹈鹕提示词失败',durationSec:dur()});continue;}
      const sid=await pelicanWaitSessionId(60000,beforeId);
      if(!sid){pushResult({round:1,index:i,ok:false,reason:'未拿到新会话 id',durationSec:dur()});continue;}
      const url='https://arena.ai/agent/'+sid;
      pelicanAuto.current={phase:'wait-image',round:1,index:i,total:infinite?null:total};
      const v=await pelicanWaitVisual(600000);
      if(!v){pushResult({round:1,index:i,sessionId:sid,ok:false,reason:'600 秒内未见图片产出',durationSec:dur()});continue;}
      // 文件夹结构：每张图一个文件夹，名=分数+序号（不评分时只有序号），里面放首帧 + 帧拼图，不写 JSON。
      // 顺序：存首帧 -> 采 6 帧拼帧拼图（评分开时才采）-> 双图打分 -> 文件夹按分数定名。
      const itemDir0=path.join(outDir,'R1-'+i+'_tmp');
      fs.mkdirSync(itemDir0,{recursive:true});
      const tmpFile=path.join(itemDir0,'首帧.png');
      let saved=null;
      try{saved=await pelicanCaptureVisual(v,tmpFile);}catch(e){try{fs.rmSync(itemDir0,{recursive:true,force:true});}catch{} pushResult({round:1,index:i,sessionId:sid,ok:false,reason:'保存图片失败：'+String(e.message||e),durationSec:dur()});continue;}
      let stripFile=null;
      if(pelicanAuto.scoreMode==='motion'){
        try{
          const frames=await pelicanCaptureFrames(v,itemDir0);
          if(frames.length>=3&&await pelicanBuildStrip(frames,path.join(itemDir0,'帧拼图.png')))stripFile=path.join(itemDir0,'帧拼图.png');
          for(const f of frames)try{fs.unlinkSync(f);}catch{}
        }catch(e){trace('pelican frames failed: '+String(e.message||e));}
      }
      const scoreTag=pelicanAuto.score?await pelicanScore(tmpFile,stripFile,i):null;
      const scoreError=pelicanAuto.score?pelicanScoreLastError:'';
      // 动图档拼图失败会退回单静帧：此时按静帧分档算、文件夹名和对话名带“静”，一眼能看出是静帧分不是动图分。
      const effectiveMode=(pelicanAuto.scoreMode==='motion'&&!stripFile)?'still':pelicanAuto.scoreMode;
      const tier=scoreTag?pelicanTier(scoreTag,effectiveMode):'';
      const base=scoreTag?('R1-'+i+'_'+scoreTag+(effectiveMode==='still'?'静':'')):('R1-'+i);
      const itemDir=path.join(outDir,base);
      try{
        if(fs.existsSync(itemDir))fs.rmSync(itemDir,{recursive:true,force:true});
        fs.renameSync(itemDir0,itemDir);
      }catch(e){pushResult({round:1,index:i,sessionId:sid,ok:false,reason:'建文件夹失败：'+String(e.message||e),durationSec:dur()});continue;}
      const file=path.join(itemDir,'首帧.png');
      const strip=stripFile?path.join(itemDir,'帧拼图.png'):null;
      const title=scoreTag?('[鹈鹕 '+scoreTag+(effectiveMode==='still'?'静':'')+'] R1-'+i):('[鹈鹕] R1-'+i);
      let renamed=false,renameError='';
      try{await pelicanRename(sid,title);renamed=true;}catch(e){renameError=String(e.message||e);}
      pushResult({round:1,index:i,sessionId:sid,ok:true,file,strip,title,score:scoreTag||'不评分',tier:tier||'',scoreMode:pelicanAuto.scoreMode,effectiveScoreMode:effectiveMode,renamed,renameError,via:saved&&saved.via,frames:strip?6:0,durationSec:dur(),scoreError:scoreError});
      // 每完成一次，等间隔（默认 30 秒）再开始下一次；最后一次不等待
      if(!pelicanAuto.stop&&(infinite||i<total)){pelicanAuto.current={phase:'wait',round:1,index:i,total:infinite?null:total};if(!await pelicanSleepOrStop(pelicanAuto.intervalSec*1000))break;}
    }
  }catch(e){
    pelicanAuto.lastError=String(e.message||e);
  }finally{
    pelicanAuto.running=false;pelicanAuto.current=null;
  }
}
function saveProxyVault(){if(!safeStorage.isEncryptionAvailable())throw Error('系统加密不可用');const tmp=PROXY_VAULT+'.tmp';fs.writeFileSync(tmp,safeStorage.encryptString(JSON.stringify(proxyData)));fs.renameSync(tmp,PROXY_VAULT);}
app.on('second-instance',()=>{win?.show();win?.focus();});
app.on('before-quit',()=>{try{workspaceServer?.close();}catch{}});
app.on('before-quit',async event=>{if(quitting)return;event.preventDefault();quitting=true;try{await proxyRuntime?.close();}catch{} if(backend&&!backend.killed){await new Promise(res=>{const to=setTimeout(()=>{try{require('node:child_process').execFile('taskkill',['/T','/F','/PID',String(backend.pid)],()=>{});}catch{} res();},3000); backend.once('exit',()=>{clearTimeout(to);res();}); try{backend.kill();}catch{clearTimeout(to);res();}});} app.quit();});
app.whenReady().then(async()=>{
 net.createServer(socket=>{socket.once('data',data=>{const command=data.toString().trim();if(command==='quit'){socket.end('ok');app.quit();}else if(command==='status'){socket.end(JSON.stringify({visible:win?.isVisible(),enabled:win?.isEnabled(),minimized:win?.isMinimized(),focused:win?.isFocused(),children:win?.getChildWindows().length,modal,views:win?.contentView.children.map(v=>({bounds:v.getBounds(),visible:v.getVisible(),destroyed:v.webContents.isDestroyed()}))}));}else socket.end();});}).listen(PIPE);
 await main();
}).catch(error=>{trace('startup failure: '+String(error.stack||error));dialog.showErrorBox('Arena 工作台启动失败',String(error.message));app.quit();});
app.on('window-all-closed',()=>app.quit());
