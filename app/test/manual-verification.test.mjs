import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Bridge} from '../src/bridge.mjs';
import {Harvester} from '../src/harvest.mjs';
import {requiresManualWait} from '../src/manual-gate.mjs';

for (const initialStatus of [403,429]) test(`manual ${initialStatus} waits up to 120s on same page and never clicks send twice`,async()=>{
  const page=new EventEmitter();let sends=0,waits=0;const phases=[];
  const id='44444444-4444-4444-8444-444444444444';
  const editor={waitFor:async opts=>assert.equal(opts.timeout,120_000),fill:async()=>{}};
  Object.assign(page,{goto:async()=>{},waitForLoadState:async()=>{},waitForTimeout:async()=>{},
    getByRole:()=>({count:async()=>0}),
    locator:()=>({last:()=>editor,click:async()=>{sends++;}}),
    waitForResponse:async(_,opts)=>{
      assert.equal(opts.timeout,120_000);waits++;
      return waits===1?{status:()=>initialStatus,text:async()=>initialStatus===429?'prompt failed':'recaptcha validation failed'}:
        {status:()=>200,text:async()=>JSON.stringify({id}),headers:()=>({'public-access-token':'test'})};
    }});
  const result=await Bridge.prototype.createAgentSession.call({},page,'1+1=',{waitForHuman:true,onPhase:p=>phases.push(p)});
  assert.equal(result.id,id);assert.equal(sends,1);assert.equal(waits,2);
  assert.ok(phases.some(p=>p.includes('不自动重发') && p.includes('120秒')));
});

test('manual wait does not hide unrelated authentication or server failures',()=>{
  assert.equal(requiresManualWait(429,'prompt failed'),true);
  assert.equal(requiresManualWait(403,'recaptcha validation failed'),true);
  assert.equal(requiresManualWait(403,'account restricted'),false);
  assert.equal(requiresManualWait(401,'unauthorized'),false);
  assert.equal(requiresManualWait(500,'server failed'),false);
});

test('failed round stops batch instead of navigating to the next card',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'manual-verification-'));
  try{
    let attempts=0;
    const bridge={browser:{getPage:async()=>({}),withAccount:async(_,fn)=>fn(),probeAvailable:false},
      createAgentSession:async()=>{attempts++;throw new Error('verification not completed');}};
    const h=new Harvester({bridge,credentials:{primary:()=>({email:'test@example.invalid'})},archiveDir:dir});
    await h.start({count:5,intervalMs:0});
    const deadline=Date.now()+2000;
    while(h.status().running&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    assert.equal(h.status().running,false);assert.equal(attempts,1);assert.equal(h.status().done,1);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('stopping a desktop verification wait cancels the task without destroying the embedded website',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-stop-'));
 try{
  let closed=false;
  const page={close:async()=>{closed=true;}};
  const bridge={config:{desktopCdpUrl:'http://127.0.0.1:20141'},browser:{getPage:async()=>page,withAccount:async(_,fn)=>fn()},
   createAgentSession:async(_,__,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}))};
  const h=new Harvester({bridge,credentials:{primary:()=>({email:'test@example.invalid'})},archiveDir:dir});
  await h.start({count:1});await new Promise(r=>setTimeout(r,10));h.stop();await new Promise(r=>setTimeout(r,10));
  assert.equal(closed,false);assert.equal(h.status().running,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
