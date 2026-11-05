import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {realtimeRoute,matchesRealtime,trackRealtime} from '../src/realtime-route.mjs';
const id='01a18c7e-db7b-71dc-b23b-29dcc33bc10e';
test('matches legacy, encoded runner and unencoded runner realtime paths',()=>{
  for(const key of [id,`agent-runner:${id}`,`agent-runner%3A${id}`]){
    for(const endpoint of ['out','in/append']){
      const url=`https://arena.ai/ai-proxy/realtime/v1/sessions/${key}/${endpoint}?x=1`;
      assert.equal(matchesRealtime(url,id,endpoint),true);
      assert.equal(realtimeRoute(url).key,decodeURIComponent(key));
    }
  }
  assert.equal(realtimeRoute(`https://other.invalid/ai-proxy/realtime/v1/sessions/${id}/out`),null);
  assert.equal(matchesRealtime(`https://arena.ai/ai-proxy/realtime/v1/sessions/agent-runner%3A${id}/out`,'44444444-4444-4444-8444-444444444444','out'),false);
});
test('captures only this page own output credentials before a send',()=>{
  const page=new EventEmitter(); trackRealtime(page); trackRealtime(page);
  assert.equal(page.listenerCount('request'),1);
  page.emit('request',{url:()=>`https://arena.ai/ai-proxy/realtime/v1/sessions/agent-runner%3A${id}/out`,headers:()=>({authorization:'Bearer test-token'})});
  assert.deepEqual(page.__bridgeRealtime.get(id),{key:`agent-runner:${id}`,token:'test-token'});
});
