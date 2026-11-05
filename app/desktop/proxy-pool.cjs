const crypto=require('node:crypto');
const yaml=require('js-yaml');
const types=new Set(['http','socks5','ss','vmess','vless','trojan','hysteria2','tuic']);
function validate(node){
 if(!node||!types.has(node.type)||typeof node.server!=='string'||!node.server.trim()||!Number.isInteger(Number(node.port))||node.port<1||node.port>65535)throw Error('节点类型、服务器或端口无效');
 const copy=JSON.parse(JSON.stringify(node));copy.port=Number(copy.port);copy.name=String(copy.name||copy.type+' · '+copy.server).slice(0,120);
 return copy;
}
function share(line){
 if(!line.includes('://')){const m=line.match(/^([^:]+):(\d+):([^:]+):(.+)$/);line=m?'http://'+encodeURIComponent(m[3])+':'+encodeURIComponent(m[4])+'@'+m[1]+':'+m[2]:'http://'+line;}
 if(line.startsWith('vmess://')){const v=JSON.parse(Buffer.from(line.slice(8),'base64').toString());return {type:'vmess',name:v.ps,server:v.add,port:Number(v.port),uuid:v.id,alterId:Number(v.aid||0),cipher:v.scy||'auto',tls:v.tls==='tls',network:v.net||'tcp',...(v.net==='ws'?{'ws-opts':{path:v.path||'/',headers:{Host:v.host||v.add}}}:{})};}
 if(line.startsWith('ss://')){let raw=line.slice(5).split('#')[0];if(!raw.includes('@'))raw=Buffer.from(raw,'base64').toString();const at=raw.lastIndexOf('@');let auth=raw.slice(0,at);if(!auth.includes(':'))auth=Buffer.from(auth,'base64').toString();const i=auth.indexOf(':');const u=new URL('http://'+raw.slice(at+1));return {type:'ss',name:decodeURIComponent(line.split('#')[1]||''),server:u.hostname,port:Number(u.port),cipher:auth.slice(0,i),password:auth.slice(i+1)};}
 const u=new URL(line),type=({'socks:':'socks5','socks5:':'socks5','https:':'http','hy2:':'hysteria2'})[u.protocol]||u.protocol.slice(0,-1);
 const n={type,name:decodeURIComponent(u.hash.slice(1)),server:u.hostname.replace(/^\[|\]$/g,''),port:Number(u.port||({'http':80,'https':443}[u.protocol.slice(0,-1)]||0))};
 if(type==='http'||type==='socks5'){if(u.username)n.username=decodeURIComponent(u.username);if(u.password)n.password=decodeURIComponent(u.password);if(u.protocol==='https:')n.tls=true;}
 else if(type==='vless'||type==='vmess'||type==='tuic'){n.uuid=decodeURIComponent(u.username);if(type==='tuic')n.password=decodeURIComponent(u.password);}
 else n.password=decodeURIComponent(u.username+(u.password?':'+u.password:''));
 const q=u.searchParams;n.tls=n.tls||['tls','reality'].includes(q.get('security'))||['trojan','hysteria2','tuic'].includes(type);
 if(q.get('sni'))n.servername=q.get('sni');if(q.get('flow'))n.flow=q.get('flow');
 if(q.get('type')==='ws'){n.network='ws';n['ws-opts']={path:q.get('path')||'/',headers:{Host:q.get('host')||n.server}};}
 if(q.get('type')==='grpc'){n.network='grpc';n['grpc-opts']={'grpc-service-name':q.get('serviceName')||''};}
 if(q.get('security')==='reality')n['reality-opts']={'public-key':q.get('pbk'),'short-id':q.get('sid')||''};
 if(q.get('fp'))n['client-fingerprint']=q.get('fp');
 if(q.get('alpn'))n.alpn=q.get('alpn').split(',');
 return n;
}
function parseNodes(text){
 text=String(text||'').trim();if(text.length>4*1024*1024)throw Error('节点配置超过4MB');
 let rows;
 if(/(?:^|\n)\s*proxies\s*:/.test(text)||/^[{\[]/.test(text)){const v=yaml.load(text,{schema:yaml.JSON_SCHEMA});rows=Array.isArray(v)?v:v?.proxies;if(!Array.isArray(rows))throw Error('配置需要 proxies 节点列表');}
 else {if(!text.includes('://')&&/^[A-Za-z0-9+/=\s]+$/.test(text))text=Buffer.from(text,'base64').toString();rows=text.split(/\r?\n/).filter(s=>s.trim()&&!s.trim().startsWith('#')).map(s=>share(s.trim()));}
 if(rows.length>1000)throw Error('一次最多1000个节点');
 return rows.map(row=>{const node=validate(row);return {id:crypto.createHash('sha256').update(JSON.stringify(node)).digest('hex').slice(0,20),node};});
}
function chooseNode(nodes,bindings){const counts={};for(const id of Object.values(bindings||{}))counts[id]=(counts[id]||0)+1;return nodes.filter(n=>n.check?.ok!==false).sort((a,b)=>(counts[a.id]||0)-(counts[b.id]||0))[0]||null;}
module.exports={parseNodes,chooseNode};
