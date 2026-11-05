import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Harvester} from '../src/harvest.mjs';
for(const continuous of [false,true])for(const mode of ['any','all'])test(`harvest continuous=${continuous} ${mode} targets only stop on accepted identities; rename errors preserve archive`,async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arena-targets-'));let i=0;
 const models=[null,'target-a','target-a','target-b'];
 const credential={email:'fixture@example.invalid'};
 const page={url:()=> 'https://arena.ai/agent/different'};
 const h=new Harvester({archiveDir:dir,credentials:{primary:()=>credential},timing:{readyDelay:()=>0,probeDelay:()=>0,cardDelay:()=>0},
  identify:async()=>({status:'ok',model:models[i++],nearMiss:{model:'target-b',confidence:0.99}}),
  bridge:{config:{desktopCdpUrl:'local'},browser:{withAccount:(_,work)=>work(),getPage:async()=>page},
   createAgentSession:async()=>({id:'44444444-4444-4444-8444-444444444444'}),readLatestTurn:async()=>({text:'fixture'})}});
 try{
  await h.start({count:continuous?1:5,untilTarget:continuous,fingerprintRounds:1,targetModels:['target-a','target-b'],targetMode:mode,renameMatched:true,intervalMs:0});
  for(let n=0;n<200&&h.status().running;n++)await new Promise(r=>setTimeout(r,2));
  const s=h.status();assert.equal(s.running,false);assert.equal(s.targetHit,true);assert.equal(s.total,continuous?null:5);assert.equal(s.untilTarget,continuous);
  assert.equal(s.done,mode==='any'?2:4);assert.equal(s.failed,0);assert.ok(s.rounds[1].renameError);
  assert.ok(fs.existsSync(path.join(dir,'记录.json')));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('continuous harvest requires a target before touching browser',async()=>{
 const h=new Harvester({archiveDir:'unused',bridge:{},credentials:{}});
 const r=await h.start({untilTarget:true});assert.equal(r.ok,false);assert.match(r.error,/目标/);assert.equal(h.status().running,false);
});
