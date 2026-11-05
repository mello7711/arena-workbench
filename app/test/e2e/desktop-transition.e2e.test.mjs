import test from 'node:test';import assert from 'node:assert/strict';
import {startE2E,httpRequest,authHeaders} from './helper.mjs';
test('desktop switch requires authentication and pauses API until verified sync succeeds',async()=>{
 let synced=false;
 const e=await startE2E({config:{desktopCdpUrl:'http://127.0.0.1:20141'},bridge:{
  readyAccounts:new Set(),browser:{login:async email=>{if(!synced)throw Error('not signed in');return {email,cookieHeader:'fixture'};}},
  credentials:{list:()=>[],assertWritable:()=>{},upsert:()=>{}},
 }});
 const request=(route,body,headers=authHeaders())=>httpRequest(e.port,{method:'POST',reqPath:route,body,headers});
 try{
  assert.equal((await request('/api/desktop/transition',{email:'new@example.invalid'},{})).status,401);
  assert.equal((await request('/api/desktop/transition',{email:'new@example.invalid'})).status,200);
  assert.equal(e.config.desktopSwitchPending,true);
  assert.equal((await request('/v1/chat/completions',{messages:[{role:'user',content:'hi'}]})).status,409);
  assert.equal((await request('/api/harvest/start',{count:1})).status,409);
  assert.equal((await request('/api/desktop/sync',{email:'new@example.invalid'})).status,409);
  assert.equal(e.config.desktopSwitchPending,true);
  synced=true;
  assert.equal((await request('/api/desktop/sync',{email:'new@example.invalid'})).status,200);
  assert.equal(e.config.desktopSwitchPending,false);
 }finally{await e.close();}
});
