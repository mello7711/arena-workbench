// Use Arena's own Rename UI, scoped to the exact completed conversation.
export async function renameConversation(page,sessionId,title){
 if(!/^[a-f0-9-]{36}$/i.test(sessionId))throw Error('Invalid conversation id');
 const url=new URL(page.url());if(url.origin!=='https://arena.ai'||url.pathname!='/agent/'+sessionId)throw Error('会话已切换，未改名');
 const row=page.locator(`a[data-sidebar="menu-button"][href="/agent/${sessionId}"]`).last();
 if(!await row.isVisible().catch(()=>false))throw Error('侧栏未显示当前会话，未改名');
 const guard=()=>{if(page.url()!=='https://arena.ai/agent/'+sessionId)throw Error('会话已切换，停止改名');};
 const item=row.locator('xpath=ancestor::*[@data-sidebar="menu-item"][1]');
 const trigger=item.locator('button[data-sidebar="menu-action"]').first();
 await trigger.click({timeout:4000});
 const menu=page.getByRole('menu');await menu.getByRole('menuitem',{name:/^(Rename|重命名|重命名对话)$/}).click({timeout:4000});
 const dialog=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:/^(Rename|Rename chat|Rename conversation|重命名|重命名对话)$/})});
 guard();const value=String(title).slice(0,100);await dialog.locator('input').fill(value,{timeout:4000});
 guard();await dialog.getByRole('button',{name:/^(Rename|重命名|保存)$/}).click({timeout:4000});
 await dialog.waitFor({state:'hidden',timeout:6000});
 await page.waitForFunction(({id,title})=>Array.from(document.querySelectorAll('a[href]')).some(a=>a.getAttribute('href')==='/agent/'+id&&(a.textContent||'').includes(title)),{id:sessionId,title:value},{timeout:4000});
 return value;
}
