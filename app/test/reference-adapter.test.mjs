import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceStatus, scoreReference, identifyReference} from '../src/fingerprint/reference-adapter.mjs';
import {generateChallenges, identify, robustScoreNumbers, parseNumbers} from '../src/fingerprint/reference/engine.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Harvester } from '../src/harvest.mjs';
const bank=JSON.parse(fs.readFileSync(new URL('../src/fingerprint/reference/bank.json',import.meta.url)));

test('supplied reference preserves all 58 model labels and feature dimensions',()=>{
  assert.equal(referenceStatus().modelIds.length,58);
  for(const [name,dim] of [['hellinger',355],['ordered_blocks',74]]){
    const a=bank.robust[name];
    assert.equal(a.feature_mean.length,dim); assert.equal(a.feature_scale.length,dim);
    assert.equal(a.centroids.length,58);
    assert.ok(a.centroids.every(row=>row.length===dim&&row.every(Number.isFinite)));
  }
});
test('trivial answer, repetition and arithmetic sequences cannot label a session',()=>{
  for(const texts of [['2','2','2'], Array(3).fill(Array(300).fill(7).join(' ')),
    Array(3).fill(Array.from({length:300},(_,i)=>i+1).join(' '))]){
    const r=scoreReference(texts,[300,300,300]);
    assert.equal(r.model,null); assert.equal(r.status,'unresolved');
  }
});
test('three original multilingual challenges are sent serially with the reference lengths',async()=>{
  const prompts=[];
  const r=await identifyReference({ask:async p=>{prompts.push(p);return '2';}});
  assert.equal(prompts.length,3); assert.equal(r.model,null);
  const c=generateChallenges(3,[]);
  assert.equal(new Set(c.map(x=>x.expected_count)).size,3);
  assert.ok(c.every(x=>x.expected_count>=292&&x.expected_count<=332&&x.prompt.length>100));
});
test('shared round scorer agrees with original standalone numerical formula',()=>{
  let seed=1234567;
  const text=Array.from({length:310},()=>{seed=(1664525*seed+1013904223)>>>0;return seed%355+1;}).join(' ');
  const values=robustScoreNumbers(parseNumbers(text),bank);
  const result=identify([text],bank,{expectedCounts:[310]});
  for(const candidate of result.candidates){
    const i=bank.models.findIndex(m=>m.id===candidate.id);
    assert.ok(Math.abs(candidate.score-values[i])<1e-10);
  }
});
for(const probeRounds of [1,2,3]) test(`harvest sends exactly ${probeRounds} numeric challenge(s), first at creation, without 1+1`,async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reference-harvest-'));
  try {
    let calls=0,createdPrompt='';
    const credential={email:'test@example.invalid'};
    const bridge={
      browser:{probeAvailable:false,getPage:async()=>({}),withAccount:async(_,fn)=>fn()},
      createAgentSession:async(_,prompt)=>{createdPrompt=prompt;return {id:'44444444-4444-4444-8444-444444444444'};},
      readLatestTurn:async()=>({text:'2'}),
      converse:async(id,body)=>{ assert.ok(body.messages[0].content.length>100); calls++;
        return {choices:[{message:{content:'2'}}]}; }
    };
    const h=new Harvester({bridge,credentials:{primary:()=>credential},archiveDir:dir,timing:{readyDelay:()=>0,probeDelay:()=>0,cardDelay:n=>n}});
    await h.start({count:1,intervalMs:0,fingerprintRounds:probeRounds});
    const end=Date.now()+2000;
    while(h.status().running&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
    assert.equal(h.status().running,false); assert.equal(calls,probeRounds-1);
    assert.ok(createdPrompt.length>100); assert.notEqual(createdPrompt,'1+1=');
    assert.equal(h.status().rounds[0].via,'numeric-fingerprint-estimate');
    const rows=JSON.parse(fs.readFileSync(path.join(dir,'记录.json'),'utf8'));
    assert.equal(rows[0].Model,'未识别');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
