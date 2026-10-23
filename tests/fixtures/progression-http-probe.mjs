import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readPublishedProgressionAverage } from '../../lib/seasonal/progression-average-publication.ts';
const db=new DatabaseSync(process.argv[2],{readOnly:true});
db.exec('PRAGMA busy_timeout=100');
let stopped=false;
process.on('message',()=>{stopped=true;});
const server=createServer((_request,response)=>{
  try {
    const published=readPublishedProgressionAverage(db,'regular','persistent',100);
    response.writeHead(published?200:503,{'content-type':'application/json'});
    response.end(JSON.stringify(published));
  } catch(error) {response.writeHead(500);response.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const samples=[];

try {
  while(!stopped || samples.length===0) {
    const start=performance.now();
    const response=await fetch(`http://127.0.0.1:${server.address().port}`,{signal:AbortSignal.timeout(2000)});
    const body=await response.json();
    if(response.status!==200 || !body?.value?.series?.cumulative?.overall?.length) throw new Error('incomplete published response');
    samples.push(performance.now()-start);
    if(samples.length===1) process.send({ready:true});
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  process.send({samples});
} catch(error) {process.send({error:error.message});}
finally {await new Promise(resolve=>server.close(resolve));db.close();process.disconnect();}