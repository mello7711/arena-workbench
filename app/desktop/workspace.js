const $=s=>document.querySelector(s);
function toast(text){$('#toast')?.remove();const t=document.createElement('div');t.id='toast';t.textContent=text;document.body.append(t);setTimeout(()=>t.remove(),3500);}
async function call(action,data){const r=await window.workbench.invoke(action,data);if(r?.error)throw new Error(r.error);return r;}
function action(id,handler){const el=$('#'+id);if(!el)return;el.addEventListener('click',async()=>{el.disabled=true;try{await handler();}catch(e){const f=$('#feedback');if(f)f.textContent=e.message;toast(e.message);}finally{el.disabled=false;}});}
function out(id,text){const el=id instanceof HTMLElement?id:$(id);if(el)el.textContent=text;}

action('openHome',()=>call('home-open'));
action('startTunnel',async()=>{out('#tunnelOutput','正在执行…');const r=await call('integration-control',{action:'start',what:'all'});out('#tunnelOutput',r.output);});
action('stopTunnel',async()=>{out('#tunnelOutput','正在执行…');const r=await call('integration-control',{action:'stop',what:'all'});out('#tunnelOutput',r.output);});
action('tunnelStatus',async()=>{out('#tunnelOutput','正在执行…');const r=await call('integration-control',{action:'status',what:'all'});out('#tunnelOutput',r.output);});
action('openTunnel',()=>call('integration-open',{kind:'tunnel'}));






action('coldstartCopy',async()=>{await call('coldstart-copy');toast('冷启动包已复制：整段粘给全新 Arena 对话即可');});
action('coldstartSend',async()=>{const r=await call('coldstart-send');toast('冷启动包已发送到当前会话（'+(r.detail&&r.detail.how==='enter'?'回车':'发送按钮')+'）');});
action('coldstartBackupCopy',async()=>{await call('coldstart-backup-copy');toast('备用冷启动包已复制：整段粘给不接受钥匙的对话即可');});
action('coldstartBackupSend',async()=>{const r=await call('coldstart-backup-send');toast('备用冷启动包已发送到当前会话（'+(r.detail&&r.detail.how==='enter'?'回车':'发送按钮')+'）');});
let RELAY_SESSIONS = []; // {source,key,label}
let RELAY_AGENTS = []; // [{id,name}] 脚本探测到的本机 agent

function relayFill() {
  const want = $('#relaySource').value || 'all';
  const sel = $('#relaySession');
  const keep = sel.value;
  sel.replaceChildren();
  const list = RELAY_SESSIONS.filter((s) => want === 'all' || s.source === want);
  for (const s of list) {
    const o = document.createElement('option');
    o.value = s.source + '|' + s.key;
    o.textContent = s.label;
    sel.append(o);
  }
  if (keep && list.some((s) => s.source + '|' + s.key === keep)) sel.value = keep;
  out('#relayOutput', `本机 agent：${RELAY_AGENTS.map((a) => a.name).join('、') || '未探测到'} · 列出 ${list.length}/${RELAY_SESSIONS.length} 个会话。选中后复制或发送。`);
}

action('relaySend',async()=>{const v=$('#relaySession').value;if(!v)throw Error('请先刷新会话列表并选择一个会话');const i=v.indexOf('|');const r=await call('relay-send',{source:v.slice(0,i),key:v.slice(i+1)});out('#relayOutput',`接力包已发送到当前会话（${r.chars} 字符）。`);toast('接力包已发送到当前会话');});
action('relayRefresh',async()=>{
  const r=await call('relay-list');
  RELAY_SESSIONS = r.sessions || [];
  RELAY_AGENTS = r.agents || [];
  const src = $('#relaySource');
  const keepSrc = src.value;
  src.replaceChildren();
  for (const a of [{id:'all',name:'全部来源'}, ...RELAY_AGENTS]) {
    const o = document.createElement('option');
    o.value = a.id; o.textContent = a.name;
    src.append(o);
  }
  if (keepSrc && [...src.options].some((o) => o.value === keepSrc)) src.value = keepSrc;
  relayFill();
});
$('#relaySource').addEventListener('change', relayFill);
action('relayCopy',async()=>{const v=$('#relaySession').value;if(!v)throw Error('请先刷新会话列表并选择一个会话');const i=v.indexOf('|');const r=await call('relay-copy',{source:v.slice(0,i),key:v.slice(i+1)});out('#relayOutput',`接力包已复制（${r.chars} 字符）。粘贴给目标 Arena 会话即可接力。`);toast('接力包已复制');});

action('sessionExport',async()=>{
  out('#sessionIoOutput','导出中：读取右侧会话…');
  const r=await call('session-export');
  const note=(r.omittedThinking||r.omittedTools)
    ? `\n（已省略 ${r.omittedThinking} 段推理过程、${r.omittedTools} 次工具调用，只导出对话正文）` : '';
  const warn=(r.complete===false) ? '\n⚠️ 接口提示还有更早的消息未取回，导出可能不完整' : '';
  out('#sessionIoOutput',`已导出 ${r.count} 条正文（原始 ${r.total} 条消息，${r.chars} 字节）${note}${warn}\n→ ${r.file}`);
  toast('当前对话已导出');
});
action('sessionImport',async()=>{out('#sessionIoOutput','导入中：新开对话并发送记录，请勿操作右侧页面…');const r=await call('session-import');if(r.cancelled){out('#sessionIoOutput','已取消');return;}out('#sessionIoOutput',`已导入到新对话：${r.parts} 条消息块 · 共 ${r.chars} 字符
来源文件：${r.file}`);toast('记录已导入到新对话');});
