const net=require('node:net'),crypto=require('node:crypto'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const pipe='\\\\.\\pipe\\arena-workbench-'+crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,16);
const client=net.connect(pipe,()=>client.write('quit\n'));
client.setTimeout(3000,()=>{client.destroy();process.exitCode=1;});
client.on('error',()=>{process.exitCode=1;});client.on('data',()=>{process.exitCode=0;client.end();});
