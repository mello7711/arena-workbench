export function parseMailboxImport(text) {
  const accounts=[], errors=[];
  const lines=String(text).split(/\r?\n/);
  if(lines.length>2000)throw new Error('一次最多导入2000行');
  for(let i=0;i<lines.length;i++){
    const raw=lines[i].trim();if(!raw)continue;
    const parts=raw.includes('----')?raw.split('----'):raw.split('\t');
    if(![2,4].includes(parts.length)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parts[0].trim())){
      errors.push({line:i+1,message:'格式应为 邮箱----密码 或 邮箱----密码----Client ID----刷新令牌'});continue;
    }
    const [email,password,clientId='',refreshToken='']=parts.map(p=>p.trim());
    if(!password&&!refreshToken){errors.push({line:i+1,message:'密码或刷新令牌不能为空'});continue;}
    accounts.push({email:email.toLowerCase(),password,clientId,refreshToken});
  }
  return {accounts,errors};
}
export function mailboxWebUrl(email){
  const domain=String(email).split('@')[1]?.toLowerCase();
  if(domain==='qq.com'||domain==='foxmail.com')return 'https://mail.qq.com/';
  if(domain==='gmail.com')return 'https://mail.google.com/';
  if(domain==='163.com')return 'https://mail.163.com/';
  if(domain==='126.com')return 'https://mail.126.com/';
  return 'https://outlook.live.com/mail/';
}
export async function readOutlookInbox(account,request){
  if(!account.clientId||!account.refreshToken)throw new Error('此邮箱未导入Client ID和刷新令牌，请使用网页登录');
  const form=new URLSearchParams({client_id:account.clientId,refresh_token:account.refreshToken,
    grant_type:'refresh_token',scope:'https://graph.microsoft.com/Mail.Read offline_access'});
  const token=await request('https://login.microsoftonline.com/common/oauth2/v2.0/token',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});
  const payload=await token.json();
  if(!token.ok||!payload.access_token)throw new Error(`微软令牌刷新失败（${payload.error||token.status}）；可能需要重新授权或不具备Graph邮件权限`);
  const url='https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=20&$select=id,subject,from,receivedDateTime,bodyPreview,body,isRead&$orderby=receivedDateTime%20desc';
  const response=await request(url,{headers:{Authorization:`Bearer ${payload.access_token}`,Prefer:'outlook.body-content-type="text"'}});
  if(!response.ok)throw new Error(`读取收件箱失败（${response.status}）；请检查Mail.Read授权`);
  const data=await response.json();
  return {refreshToken:payload.refresh_token||account.refreshToken,messages:(data.value||[]).map(m=>({
    id:m.id,subject:m.subject||'无主题',from:m.from?.emailAddress?.address||'',
    receivedAt:m.receivedDateTime,preview:String(m.body?.content||m.bodyPreview||'').slice(0,10000),isRead:m.isRead,
    codes:[...new Set(String(m.body?.content||m.bodyPreview||'').match(/\b\d{4,8}\b/g)||[])]
  }))};
}
