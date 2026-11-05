const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
class ProxyRuntime{
 constructor(data){this.data=data;this.jobs=new Map();}
 async start(key,node){
  const old=this.jobs.get(key);if(old&&old.signature===JSON.stringify(node)&&old.child.exitCode===null)return old.port;
  await this.stop(key);const exe=path.join(this.data,'tools','mihomo.exe');if(!fs.existsSync(exe))throw Error('Mihomo核心未安装');
  const port=await freePort(),dir=path.join(this.data,'proxy-runtime',require('node:crypto').createHash('sha256').update(key).digest('hex').slice(0,16));fs.mkdirSync(dir,{recursive:true});
  const config=path.join(dir,'runtime.json');fs.writeFileSync(config,JSON.stringify({'mixed-port':port,'allow-lan':false,'bind-address':'127.0.0.1',mode:'rule','log-level':'silent',ipv6:false,proxies:[{...node,name:'bound-node'}],rules:['MATCH,bound-node']}));
  const child=spawn(exe,['-d',dir,'-f',config],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});
  this.jobs.set(key,{child,port,signature:JSON.stringify(node),config});
  for(let i=0;i<80;i++){if(child.exitCode!==null||child.killed)break;const ok=await new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');s.setTimeout(150);s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));s.once('timeout',()=>{s.destroy();resolve(false);});});if(ok)return port;await new Promise(r=>setTimeout(r,100));}
  await this.stop(key);throw Error('节点核心启动失败，请检查配置和协议参数');
 }
 async stop(key){const job=this.jobs.get(key);if(!job)return;this.jobs.delete(key);if(job.child.exitCode===null){job.child.kill();await new Promise(resolve=>{const timer=setTimeout(resolve,2500);job.child.once('exit',()=>{clearTimeout(timer);resolve();});});}try{fs.unlinkSync(job.config);}catch{}}
 async close(){await Promise.all([...this.jobs.keys()].map(k=>this.stop(k)));}
}
module.exports={ProxyRuntime};
