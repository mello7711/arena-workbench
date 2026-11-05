import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {clickUnsentComposer} from '../src/send-recovery.mjs';
for (const scenario of ['unsent','changed','empty','hidden','disabled','captcha','running','navigated']) {
  test(`send recovery: ${scenario}`,()=>{
    let clicks=0;
    const visible=()=>[{}];
    const send={getClientRects:scenario==='hidden'?()=>[]:visible,disabled:scenario==='disabled',
      getAttribute:()=> 'Send message',click:()=>clicks++};
    const editor={getClientRects:visible,textContent:scenario==='changed'?'different':scenario==='empty'?'':'probe'};
    const buttons=[send];
    if(scenario==='running') buttons.push({getClientRects:visible,getAttribute:()=> 'Stop generating'});
    const document={querySelectorAll:selector=>selector==='button'?buttons:selector==='iframe'?
      (scenario==='captcha'?[{src:'https://google.com/recaptcha',getClientRects:visible}]:[]):[editor]};
    const result=vm.runInNewContext('('+clickUnsentComposer.toString()+')(args)',{
      document,location:{href:scenario==='navigated'?'other':'session'},args:{prompt:'probe',expectedUrl:'session'}
    });
    assert.equal(result,scenario==='unsent');
    assert.equal(clicks,scenario==='unsent'?1:0);
  });
}
