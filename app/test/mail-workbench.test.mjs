import test from 'node:test';import assert from 'node:assert/strict';
import {parseMailboxImport,readOutlookInbox,mailboxWebUrl} from '../desktop/mail.mjs';
test('bulk mailbox imports distinguish password-only and authorized-token accounts without echoing secrets',()=>{
 const r=parseMailboxImport('one@outlook.com----secret1\ntwo@outlook.com----secret2----client----refresh\nbad secret3');
 assert.equal(r.accounts.length,2);assert.equal(r.errors.length,1);assert.equal(r.accounts[1].refreshToken,'refresh');
 assert.equal(JSON.stringify(r.errors).includes('secret3'),false);
 assert.equal(mailboxWebUrl('one@qq.com'),'https://mail.qq.com/');
});
test('Outlook reader uses official endpoints, rotates refresh token and only returns plain message data',async()=>{
 let calls=0;const request=async(url,opts)=>{calls++;
  if(calls===1){assert.ok(url.startsWith('https://login.microsoftonline.com/'));assert.ok(opts.body.includes('grant_type=refresh_token'));return {ok:true,json:async()=>({access_token:'access',refresh_token:'rotated'})};}
  assert.ok(url.startsWith('https://graph.microsoft.com/'));assert.equal(opts.headers.Authorization,'Bearer access');
  return {ok:true,json:async()=>({value:[{id:'1',subject:'Verify',from:{emailAddress:{address:'sender@example.invalid'}},bodyPreview:'Code 123456',receivedDateTime:'2026-10-30T00:00:00Z'}]})};
 };
 const result=await readOutlookInbox({clientId:'client',refreshToken:'old'},request);
 assert.equal(calls,2);assert.equal(result.refreshToken,'rotated');assert.deepEqual(result.messages[0].codes,['123456']);
 assert.equal(JSON.stringify(result.messages).includes('access'),false);
});
test('missing or rejected mailbox authorization surfaces error rather than pretending inbox is empty',async()=>{
 await assert.rejects(readOutlookInbox({},()=>{}),/Client ID/);
 await assert.rejects(readOutlookInbox({clientId:'client',refreshToken:'old'},async()=>({ok:false,status:400,json:async()=>({error:'invalid_grant'})})),/invalid_grant/);
});
