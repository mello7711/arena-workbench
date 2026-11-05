import test from 'node:test';import assert from 'node:assert/strict';
import {ArenaBrowser} from '../src/arena-login.mjs';
test('desktop purposes reuse the embedded Arena page without creating contexts or windows',async()=>{
 const arena={url:()=> 'https://arena.ai/agent/test'},mail={url:()=> 'https://outlook.live.com/mail/'};
 const context={pages:()=>[mail,arena]};arena.context=()=>context;const browser=new ArenaBrowser({desktopCdpUrl:'http://127.0.0.1:20141'});
 browser.launch=async()=>{browser.browser={contexts:()=>[context]};};
 for(const purpose of ['harvest','converse','fingerprint'])assert.equal(await browser.getPage({email:'one@example.invalid'},purpose),arena);
 browser.desktopAccountEmail='one@example.invalid';
 await assert.rejects(browser.getPage({email:'other@example.invalid'},'converse'),error=>error.code==='desktop_account_mismatch');
});
test('desktop shutdown leaves ownership of embedded website with its desktop shell',async()=>{
 let closed=false;const b=new ArenaBrowser({desktopCdpUrl:'http://127.0.0.1:20141'});
 b.browser={close:async()=>{closed=true;}};b.contexts.set('test',{context:{close:async()=>{closed=true;}}});
 await b.close();assert.equal(closed,false);assert.equal(b.contexts.size,0);
});

test('desktop finds active Arena account outside default browser context',async()=>{
 const context={pages:()=>[page]},page={url:()=> 'https://arena.ai/agent/current',context:()=>context};
 const b=new ArenaBrowser({desktopCdpUrl:'http://127.0.0.1:20141'});
 b.launch=async()=>{b.browser={contexts:()=>[{pages:()=>[]},context]};};
 assert.equal(await b.getPage({email:'two@example.invalid'},'converse'),page);
});

test('desktop login uses a stored password to recover an expired embedded session',async()=>{
 let submitted=null;let checks=0;
 const context={cookies:async()=>[{name:'arena-auth-prod-v1.test',value:'fresh',domain:'.arena.ai'}]};
 const page={
  context:()=>context,
  evaluate:async(_fn,args)=>{submitted=args;return {status:200,text:'ok'};},
  waitForTimeout:async()=>{},
 };
 const b=new ArenaBrowser({desktopCdpUrl:'http://127.0.0.1:20141'});
 b.launch=async()=>({});b.getPage=async()=>page;
 b.sessionIsUsable=async()=>++checks>1;
 const result=await b.login('one@example.invalid','stored-password');
 assert.deepEqual(submitted,{email:'one@example.invalid',password:'stored-password'});
 assert.equal(result.cookieHeader,'arena-auth-prod-v1.test=fresh');
 assert.equal(b.desktopAccountEmail,'one@example.invalid');
});
