import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const {parseNodes,chooseNode}=createRequire(import.meta.url)('../desktop/proxy-pool.cjs');
test('proxy import supports authenticated endpoints, Clash and subscriptions without dropping credentials',()=>{
 const [http,socks]=parseNodes('http://alice:pass@127.0.0.1:8080#one\nsocks5://bob:secret@127.0.0.1:1080#two');
 assert.equal(http.node.username,'alice');assert.equal(socks.node.password,'secret');
 const [v]=parseNodes('proxies:\n  - name: sample\n    type: vless\n    server: example.invalid\n    port: 443\n    uuid: example-id\n    tls: true');assert.equal(v.node.uuid,'example-id');
 assert.equal(parseNodes('127.0.0.1:8888:alice:secret')[0].node.username,'alice');
 assert.equal(parseNodes('mixed-port: 7890\nproxies:\n - {name: fixture, type: http, server: 127.0.0.1, port: 8080}').length,1);
 assert.equal(parseNodes(Buffer.from('http://127.0.0.1:7890').toString('base64')).length,1);
});
test('proxy assignment balances accounts and excludes failed nodes',()=>{
 const nodes=parseNodes('http://127.0.0.1:8080\nhttp://127.0.0.1:8081\nhttp://127.0.0.1:8082');
 nodes[2].check={ok:false};const bindings={one:nodes[0].id};
 assert.equal(chooseNode(nodes,bindings).id,nodes[1].id);assert.equal(bindings.one,nodes[0].id);
 for(const node of nodes)node.check={ok:false};assert.equal(chooseNode(nodes,bindings),null);
});
test('sharing links preserve transport and TLS parameters',()=>{
 const [node]=parseNodes('vless://id@example.invalid:443?security=reality&pbk=pub&sid=abcd&type=grpc&serviceName=svc&fp=chrome#test');
 assert.equal(node.node['reality-opts']['public-key'],'pub');assert.equal(node.node['grpc-opts']['grpc-service-name'],'svc');
 assert.equal(parseNodes('trojan://secret@example.invalid:443#test')[0].node.password,'secret');
 assert.equal(parseNodes('ss://'+Buffer.from('aes-128-gcm:secret').toString('base64')+'@example.invalid:1234#ss')[0].node.password,'secret');
});
test('malformed or unsupported configs fail before entering pool',()=>{
 assert.throws(()=>parseNodes('proxies:\n - {type: direct, server: x, port: 80}'));
 assert.throws(()=>parseNodes('file:///tmp/private'));
 assert.throws(()=>parseNodes('http://example.invalid:0'));
});
