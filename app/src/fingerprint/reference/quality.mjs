// Extracted unchanged from supplied Arena-numeric-5.7.6/fingerprint-quality.js.
 const FILL=0.9;            // 每轮有效数字个数至少达到请求数量的 90%（5.0.12 要求严格相等，这里留一点点数误差）
 const STRONG=0.8;          // 某一轮单独强烈指向另一个模型的概率阈值
 const LABEL={empty:'没有数字',too_short:'数量不足',repeated_block:'出现重复周期',constant:'全是同一个数',monotonic:'基本单调',arithmetic:'接近等差数列',low_unique:'数值多样性过低'};
 /* 单轮输入闸门：返回 {level:'ok'|'invalid'|'insufficient', rule} */
 function gate(numbers,requested){
  const n=numbers.length;
  if(n<1)return {level:'invalid',rule:'empty'};
  if(requested&&n<Math.ceil(requested*FILL))return {level:'insufficient',rule:'too_short',length:n,minimum:Math.ceil(requested*FILL)};
  for(let period=2;period<=Math.min(64,Math.floor(n/3));period++){
    const comparisons=n-period;let hits=0;
    for(let z=period;z<n;z++){
     if(numbers[z]===numbers[z-period])hits++;
     // Even matching every remaining item cannot reach the unchanged 95% threshold.
     if((hits+n-z-1)/comparisons<0.95)break;
    }
   if(hits/(n-period)>=0.95)return {level:'invalid',rule:'repeated_block',period};
  }
  const uniq=new Set(numbers);
  if(n>=2&&uniq.size<=1)return {level:'invalid',rule:'constant'};
  if(n>=3){
   let up=0,down=0;for(let j=1;j<n;j++){if(numbers[j]>=numbers[j-1])up++;if(numbers[j]<=numbers[j-1])down++;}
   if(Math.max(up,down)/(n-1)>=0.9)return {level:'invalid',rule:'monotonic'};
   const cnt={};let mx=0;for(let k=1;k<n;k++){const d=numbers[k]-numbers[k-1];cnt[d]=(cnt[d]||0)+1;if(cnt[d]>mx)mx=cnt[d];}
   if((mx+1)/n>=0.5)return {level:'invalid',rule:'arithmetic'};
  }
  if(uniq.size/n<0.05)return {level:'invalid',rule:'low_unique'};
  return {level:'ok'};
 }
 /* 整体评估一个识别结果：
  *  texts      各轮回答文本
  *  counts     各轮请求的数字个数
  *  parse      文本 → 数字数组
  *  identifyOne(text,count) → 单轮识别结果（用来看各轮是否指向同一个模型）；只有 ≥2 轮时才做一致性检查
  *  winner     最终冠军模型 id */
 function assess(o){
  const texts=o.texts||[],counts=o.counts||[],reasons=[],seen=new Map();
  texts.forEach((t,i)=>{const numbers=o.parse(t||''),r=gate(numbers,counts[i]||0);if(r.level!=='ok')reasons.push('第'+(i+1)+'轮'+(LABEL[r.rule]||r.rule));
   if(numbers.length){const key=numbers.join(',');if(seen.has(key))reasons.push('第'+(i+1)+'轮数字重复第'+(seen.get(key)+1)+'轮，不能作为独立证据');else seen.set(key,i);}
  });
  let perProbe=[],votes=null;
  if(texts.length>=2&&typeof o.identifyOne==='function'&&o.winner){
   perProbe=texts.map((t,i)=>{try{const r=o.identifyOne(t||'',counts[i]||0);return r&&r.ok&&r.top?{id:r.top.id,prob:r.top.prob}:null;}catch{return null;}});
   votes=perProbe.filter(p=>p&&p.id===o.winner).length;
   const need=Math.ceil(texts.length*2/3);
   if(votes<need)reasons.push('多轮不一致：仅 '+votes+'/'+texts.length+' 轮支持 '+o.winner);
   const conflict=perProbe.findIndex(p=>p&&p.id!==o.winner&&p.prob>=STRONG);
   if(conflict>=0)reasons.push('第'+(conflict+1)+'轮强烈指向 '+perProbe[conflict].id);
  }
  return {pass:reasons.length===0,reasons,perProbe,votes};
 }

export {gate,assess};
