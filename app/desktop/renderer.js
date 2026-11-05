const $=s=>document.querySelector(s);let snapshot={},selectedEmail='',modalKind='',currentPage='workspace';
async function call(action,data){const result=await window.workbench.invoke(action,data);if(result?.error)throw new Error(result.error);return result;}
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,3500);}
function render(state){snapshot=state;$('#address').textContent=state.view==='mail'?state.mailUrl:state.arenaUrl;$('#mail').classList.toggle('active',state.view==='mail');$('#mailCount').textContent=state.accounts.length;$('#collapse').textContent=state.collapsed?'展开面板':'收起面板';
 if(state.view==='arena'&&currentPage!=='archive'&&currentPage!=='workspace')setPage('archive');
 const aa=$('#arenaAccountList');const selected=aa.value;aa.replaceChildren();for(const email of state.arenaAccounts||[]){const o=document.createElement('option');o.value=email;o.textContent=email;aa.append(o);}aa.value=selected||state.email||'';
 const pn=$('#proxyNode');const chosen=pn.value;pn.replaceChildren();for(const n of state.proxyPool?.nodes||[]){const o=document.createElement('option');o.value=n.id;o.textContent=n.name+' · '+n.type+(n.check?(n.check.ok?' · '+n.check.ip+' · '+n.check.ms+'ms':' · 检测失败'):' · 未检测');pn.append(o);}pn.value=chosen||state.proxyPool?.bindings?.[$('#proxyAccount').value||state.email]||pn.options[0]?.value||'';$('#poolInfo').textContent=(state.proxyPool?.enabled?'固定节点已启用':'固定节点未启用')+' · 共 '+(state.proxyPool?.nodes.length||0)+' 个节点'+(state.proxyPool?.error?' · '+state.proxyPool.error:'');
 const select=$('#mailSelect');const previous=select.value||selectedEmail;select.replaceChildren();for(const a of state.accounts){const option=document.createElement('option');option.value=a.email;option.textContent=a.email+(a.hasToken?' · 可读取邮件':' · 网页登录');select.append(option);}if(state.accounts.some(a=>a.email===previous))select.value=previous;
}
function setPage(page){currentPage=page;for(const id of ['archive','workspace']){const b=$('#'+id);if(b)b.classList.toggle('active',id===page);}}
async function openModal(kind){modalKind=kind;await call('modal',{open:true});$('#overlay').hidden=false;for(const k of ['mail','proxy','sync'])if($('#'+k+'Body'))$('#'+k+'Body').hidden=k!==kind;$('#modalTitle').textContent={mail:'邮箱账号与收件箱',proxy:'浏览器代理（暂时没修）',sync:'账号与 Arena 登录同步'}[kind]||'';$('#feedback').textContent='';if(kind==='proxy'){$('#proxyInput').value=snapshot.proxy||'';$('#proxyAccount').value=snapshot.email||'';render(snapshot);}if(kind==='sync')$('#arenaEmail').value=snapshot.email||'';}
async function closeModal(){await call('modal',{open:false});$('#overlay').hidden=true;}
function action(id,handler){const el=$('#'+id);if(!el)return;el.addEventListener('click',async()=>{el.disabled=true;try{await handler();}catch(e){$('#feedback').textContent=e.message;toast(e.message);}finally{el.disabled=false;}});}
action('mail',()=>openModal('mail'));
async function showPanel(page){await closeModal();setPage(page);const r=await call('panel',{page});if(page==='workspace')window.dispatchEvent(new CustomEvent('workspace-loaded'));return r;}
action('archive',()=>showPanel('archive'));action('workspace',()=>showPanel('workspace'));
action('proxy',()=>openModal('proxy'));action('sync',()=>openModal('sync'));action('close',closeModal);
action('reload',()=>call('navigate',{command:'reload'}));action('back',()=>call('navigate',{command:'back'}));
action('saveProxy',async()=>{await call('proxy-save',{proxy:$('#proxyInput').value});$('#feedback').textContent='代理已保存并应用。请刷新当前网页。';});
action('testProxy',async()=>{const r=await call('proxy-test');$('#feedback').textContent='Arena 响应状态：'+r.status+(r.ok?'（连接成功）':'（网络可达，网站未接受请求）');});
action('syncLogin',async()=>{await call('sync',{email:$('#arenaEmail').value});$('#feedback').textContent='已同步当前登录，可使用左侧抽卡与 API。';toast('登录同步成功');});
action('importMail',async()=>{const r=await call('mail-import',{text:$('#mailImport').value});$('#mailImport').value='';$('#feedback').textContent=`已导入或更新 ${r.imported} 个邮箱。`+r.errors.map(e=>`\n第${e.line}行：${e.message}`).join('');});
action('openMail',async()=>{const email=$('#mailSelect').value;await call('mail-open',{email});await closeModal();});
action('copyEmail',async()=>{await call('mail-copy',{email:$('#mailSelect').value,field:'email'});toast('邮箱已复制');});
action('copyPassword',async()=>{await call('mail-copy',{email:$('#mailSelect').value,field:'password'});toast('密码已复制');});
action('removeMail',async()=>{const email=$('#mailSelect').value;if(!email||!confirm('从本地加密账号列表移除 '+email+'？'))return;await call('mail-remove',{email});$('#feedback').textContent='已移除本地邮箱记录。';});
action('readInbox',async()=>{const box=$('#messages');box.className='empty';box.textContent='正在读取所选邮箱…';const r=await call('mail-inbox',{email:$('#mailSelect').value});box.replaceChildren();box.className='';if(!r.messages.length){box.className='empty';box.textContent='收件箱暂无邮件';}
 for(const m of r.messages){const row=document.createElement('article');row.className='message';const subject=document.createElement('strong');subject.textContent=m.subject;const meta=document.createElement('small');meta.textContent=m.from+' · '+new Date(m.receivedAt).toLocaleString('zh-CN');const preview=document.createElement('p');preview.textContent=m.preview;row.append(subject,meta,preview);for(const code of m.codes){const c=document.createElement('span');c.className='code';c.textContent='验证码候选 '+code;row.append(c);}box.append(row);}$('#feedback').textContent='已读取 '+r.messages.length+' 封邮件。数字仅为验证码候选，请结合邮件主题确认。';});
$('#mailSelect').addEventListener('change',()=>{selectedEmail=$('#mailSelect').value;$('#messages').textContent='点击“读取收件箱”查看所选账号。';});
window.workbench.onState(render);
call('state').then(render).catch(e=>toast(e.message));
setInterval(async()=>{try{const h=await call('health');$('#status').classList.toggle('ready',!!h.ready);$('#status span').textContent=h.ready?'API 已就绪 · 与 Arena 共用会话':'API 已启动 · 等待官网登录同步';}catch{$('#status span').textContent='API 正在启动或已停止';$('#status').classList.remove('ready');}},3000);

action('collapse',async()=>render(await call('collapse')));
async function switchArena(email){await call('account-switch',{email});$('#overlay').hidden=true;toast('已切换独立登录环境；请完成官网登录后同步');}
action('switchArena',()=>switchArena($('#arenaAccountList').value));
action('newArena',()=>switchArena($('#arenaEmail').value));
action('importNodes',async()=>{const r=await call('proxy-import',{text:$('#nodeImport').value});$('#nodeImport').value='';toast('已导入 '+r.imported+' 个节点');});
action('importNodeFile',async()=>{const r=await call('proxy-import-file');if(r.imported)toast('已导入 '+r.imported+' 个节点');});
action('addSubscription',async()=>{const r=await call('proxy-subscribe',{url:$('#subscriptionUrl').value});$('#subscriptionUrl').value='';toast('已导入 '+r.imported+' 个节点');});
action('bindNode',async()=>{await call('proxy-bind',{email:$('#proxyAccount').value,id:$('#proxyNode').value});toast('固定绑定已保存；下次打开该账号时使用');});
action('autoNode',async()=>{await call('proxy-bind',{email:$('#proxyAccount').value,id:''});toast('已清除绑定；下次打开账号时自动分配并固定');});
action('checkNode',async()=>{const r=await call('proxy-check',{id:$('#proxyNode').value});toast(r.ok?'出口检测通过':'出口检测失败');});
action('enablePool',()=>call('proxy-enable',{enabled:true}));action('disablePool',()=>call('proxy-enable',{enabled:false}));
action('clearNodes',async()=>{await call('proxy-clear-nodes');render(await call('state'));toast('已清空节点。');});
