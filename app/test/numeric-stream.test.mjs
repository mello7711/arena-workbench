import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Bridge} from '../src/bridge.mjs';

for (const fresh of [false, true]) test(`numeric reply settles with single finish (fresh=${fresh})`,async()=>{
  let clock=0,reads=0,cancelled=false;
  const records=['data-agent-dispatch','start','text-delta','finish'].map(type=>({
    body:JSON.stringify({data:{type,nodeId:'reply',...(type==='text-delta'?{delta:'17 23 51'}:{})}})
  }));
  const chunk=new TextEncoder().encode('data: '+JSON.stringify({records})+'\n\n');
  const sandbox={AbortController,TextDecoder,Date:{now:()=>clock},window:{},
    setTimeout:()=>0,clearTimeout:()=>{},fetch:async url=>{
      assert.ok(url.includes('/sessions/agent-runner%3A44444444-4444-4444-8444-444444444444/out'));
      return {status:200,body:{getReader:()=>({read:async()=>{
        reads++;clock+=fresh?10:3000;
        return reads===1?{done:false,value:chunk}:reads===2?
          {done:false,value:new TextEncoder().encode(': ping\n\n')}:{done:true};
      },cancel:async()=>{cancelled=true;}})}};
    }};
  const page={evaluate:async(fn,args)=>{
    sandbox.args=args;
    return vm.runInNewContext('('+fn.toString()+')(args)',sandbox);
  }};
  const result=await Bridge.prototype.readLatestTurn.call({},page,{
    id:'44444444-4444-4444-8444-444444444444',
    realtimeId:'agent-runner:44444444-4444-4444-8444-444444444444',
    token:'test',plainTextProbe:true,numericFreshSession:fresh,readBudgetMs:90000
  });
  assert.equal(result.text,'17 23 51');
  assert.equal(result.timing.ourSteps,1);
  assert.equal(result.timing.ourTurnFinishes,1);
  assert.equal(result.timing.breakReason,'numeric+finish');
  assert.equal(reads,1);assert.equal(cancelled,true);
});


test('numeric read timeout reports incomplete answer instead of raw AbortError',async()=>{
  let expire;
  const sandbox={AbortController,TextDecoder,Date,window:{},
    setTimeout:fn=>{expire=fn;return 1;},clearTimeout:()=>{},
    fetch:async(_url,{signal})=>({body:{getReader:()=>({
      read:async()=>{expire();throw signal.reason;},cancel:async()=>{}
    })}})};
  const page={evaluate:async(fn,args)=>{sandbox.args=args;return vm.runInNewContext('('+fn.toString()+')(args)',sandbox);}};
  const result=await Bridge.prototype.readLatestTurn.call({},page,{
    id:'test-session',token:'test',plainTextProbe:true,numericFreshSession:true,readBudgetMs:10
  });
  assert.equal(result.timing.breakReason,'budget');
  assert.match(result.errorText,/超时/);
  assert.equal(result.text,'');
});
