const {app,BrowserWindow,WebContentsView,ipcMain,session,safeStorage,clipboard,dialog,shell}=require('electron');
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawn}=require('node:child_process');
const net=require('node:net');const {execFile}=require('node:child_process');const {parseNodes,chooseNode}=require('./proxy-pool.cjs');const {ProxyRuntime}=require('./proxy-runtime.cjs');
const ROOT=path.resolve(__dirname,'..'),DATA=path.join(ROOT,'.arena-gui');
const HOME=path.dirname(ROOT),TUNNEL_DIR=path.join(HOME,'隧道与MCP'),EXAM_DIR=path.join(HOME,'选妃资料');
const CDP_PORT=String(process.env.ARENA_DESKTOP_CDP_PORT||'20145');
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
function loadVault(){if(!fs.existsSync(VAULT))return [];if(!safeStorage.isEncryptionAvailable())throw new Error('系统凭据加密不可用');return JSON.parse(safeStorage.decryptString(fs.readFileSync(VAULT)));}
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
 mailboxes=loadVault();proxyRuntime=new ProxyRuntime(DATA);if(fs.existsSync(PROXY_VAULT))proxyData=JSON.parse(safeStorage.decryptString(fs.readFileSync(PROXY_VAULT)));
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
 case 'panel':modal=false;settings.collapsed=false;saveSettings();layout();publish();if(!['archive','harvest','workspace'].includes(data.page))throw new Error('无效页面');if(data.page==='workspace'){await panel.webContents.loadFile(path.join(__dirname,'workspace.html')).catch(()=>{});panel.webContents.executeJavaScript('window.scrollTo(0,0)').catch(()=>{});return {ok:true};}await panel.webContents.loadURL('http://127.0.0.1:20140/').catch(()=>{});await panel.webContents.executeJavaScript(`switchPage(${JSON.stringify(data.page)})`);panel.webContents.executeJavaScript('window.scrollTo(0,0)').catch(()=>{});return {ok:true};
 case 'panel-resize':{return resizePanel(Number(data.delta)||0);}
 case 'panel-drag-begin':{if(divider&&!settings.collapsed){const b=divider.getBounds();divider.setBounds({x:b.x,y:b.y,width:40,height:b.height});}return {ok:true};}
 case 'panel-drag-end':{layout();return {ok:true};}
 case 'panel-workspace':{await panel.webContents.loadFile(path.join(__dirname,'workspace.html')).catch(()=>{});return {ok:true};}
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
  const pack=fs.readFileSync(path.join(TUNNEL_DIR,'冷启动包-备用.txt'),'utf8');
  clipboard.writeText(pack);return {ok:true,chars:pack.length};}
 case 'coldstart-backup-send':{
  const pack=fs.readFileSync(path.join(TUNNEL_DIR,'冷启动包-备用.txt'),'utf8');
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
  const f=path.join(EXAM_DIR,'鹈鹕参考','打开看图.html');
  if(!fs.existsSync(f))throw Error('未找到人工对照表（选妃资料\鹈鹕参考\打开看图.html）');
  const error=await shell.openPath(f);if(error)throw Error(error);return {ok:true};}
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
    const tut=fs.readFileSync(path.join(TUNNEL_DIR,'冷启动包-主.txt'),'utf8');
    const a=tut.indexOf('[对话内容开始]'),b=tut.indexOf('[对话内容结束]');
    if(a>=0&&b>a)script=tut.slice(a+'[对话内容开始]'.length,b).trim();
  }catch(e){}
  if(!script)throw Error('未找到打通教程（隧道与MCP\\冷启动包-主.txt）');
    return ['【Arena 冷启动包：一次粘贴，终端 + 全能 MCP 全部打通】','',
   '【第 1 步：安装 SSH 钥匙并验证隧道】',script,'',
   '预期结果：whoami 返回 {{WIN_USER}}、hostname 返回 {{WIN_USER}}。看到后继续第 2 步。','',
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
function saveProxyVault(){if(!safeStorage.isEncryptionAvailable())throw Error('系统加密不可用');const tmp=PROXY_VAULT+'.tmp';fs.writeFileSync(tmp,safeStorage.encryptString(JSON.stringify(proxyData)));fs.renameSync(tmp,PROXY_VAULT);}
app.on('second-instance',()=>{win?.show();win?.focus();});
app.on('before-quit',async event=>{if(quitting)return;event.preventDefault();quitting=true;try{await proxyRuntime?.close();}catch{} if(backend&&!backend.killed){await new Promise(res=>{const to=setTimeout(()=>{try{require('node:child_process').execFile('taskkill',['/T','/F','/PID',String(backend.pid)],()=>{});}catch{} res();},3000); backend.once('exit',()=>{clearTimeout(to);res();}); try{backend.kill();}catch{clearTimeout(to);res();}});} app.quit();});
app.whenReady().then(async()=>{
 net.createServer(socket=>{socket.once('data',data=>{const command=data.toString().trim();if(command==='quit'){socket.end('ok');app.quit();}else if(command==='status'){socket.end(JSON.stringify({visible:win?.isVisible(),enabled:win?.isEnabled(),minimized:win?.isMinimized(),focused:win?.isFocused(),children:win?.getChildWindows().length,modal,views:win?.contentView.children.map(v=>({bounds:v.getBounds(),visible:v.getVisible(),destroyed:v.webContents.isDestroyed()}))}));}else socket.end();});}).listen(PIPE);
 await main();
}).catch(error=>{trace('startup failure: '+String(error.stack||error));dialog.showErrorBox('Arena 工作台启动失败',String(error.message));app.quit();});
app.on('window-all-closed',()=>app.quit());
