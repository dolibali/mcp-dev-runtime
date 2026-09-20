import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import path from 'node:path';
import {RotatingLog} from '../../dist/launcher/rotating-log.js';
import {probe,probePair} from '../../dist/launcher/health.js';
import {Runtime} from '../../dist/runtime/runtime.js';
import {startHttp} from '../../dist/mcp/http.js';
import {fixture} from '../helpers.mjs';

test('rotation: long-running output rotates during writes and preserves bounded recent bytes',async t=>{
  const config=await fixture(t),file=path.join(config.cwd,'runtime.log');
  const log=new RotatingLog(file,1024,3),text='0123456789'.repeat(900);
  for(let at=0;at<text.length;at+=180){if(!log.write(text.slice(at,at+180)))await once(log,'drain');}
  log.end();await finished(log);
  const names=(await fs.readdir(config.cwd)).filter(n=>n.startsWith('runtime.log'));
  assert.equal(names.length,3);let output='';
  for(const name of ['runtime.log.2','runtime.log.1','runtime.log']){
    const s=await fs.stat(path.join(config.cwd,name));assert(s.size<=1024);assert.equal(s.mode&0o777,0o600);
    output+=await fs.readFile(path.join(config.cwd,name),'utf8');
  }
  assert(text.endsWith(output));assert(log.stats.rotations>=8);assert.equal(log.stats.queued_bytes,0);
});
test('rotation: Unicode, large individual chunks, and single-file mode stay bounded',async t=>{
  const config=await fixture(t),file=path.join(config.cwd,'one.log');
  const log=new RotatingLog(file,1024,1);log.end('中🙂文\n'.repeat(1000));await finished(log);
  const bytes=await fs.readFile(file);assert(bytes.length<=1024);assert(!bytes.toString().includes('\ufffd'));
  assert.deepEqual(await fs.readdir(config.cwd),['one.log']);
});
test('rotation: slow consumers signal backpressure and I/O errors are observed',async t=>{
  const config=await fixture(t);const log=new RotatingLog(path.join(config.cwd,'load.log'),8192,2);
  assert.equal(log.write('x'.repeat(200000)),false);await once(log,'drain');log.end();await finished(log);
  const bad=new RotatingLog(path.join(config.cwd,'missing','bad.log'),1024,2);bad.end('failure');
  await assert.rejects(finished(bad));assert(bad.stats.error);
});
test('rotation: a symlink cannot redirect log writes to an arbitrary file',async t=>{
  const config=await fixture(t),outside=path.join(config.cwd,'outside'),link=path.join(config.cwd,'linked.log');
  await fs.writeFile(outside,'unchanged');await fs.symlink(outside,link);
  const log=new RotatingLog(link,1024,2);log.end('overwrite attempt');await assert.rejects(finished(log));
  assert.equal(await fs.readFile(outside,'utf8'),'unchanged');
});
test('health: fresh degraded/recovered probes do not restart commands or fabricate readiness',async t=>{
  const config=await fixture(t),runtime=new Runtime(config),http=await startHttp(runtime);t.after(()=>http.close());
  let ready=true;
  const tunnel=createServer((q,r)=>{r.writeHead(ready?200:503);r.end(ready?'ready':'not ready');});
  await new Promise(r=>tunnel.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>tunnel.close(r)));
  const mcp=http.url.replace('/mcp','/healthz'),url=`http://127.0.0.1:${tunnel.address().port}/readyz`;
  const first=await probePair(mcp,url,runtime.exec.instanceId);assert.equal(first.availability,'ready');
  ready=false;const down=await probePair(mcp,url,runtime.exec.instanceId);assert.equal(down.availability,'degraded');assert.equal(down.mcp.ok,true);assert.equal(down.tunnel.ok,false);
  ready=true;const up=await probePair(mcp,url,runtime.exec.instanceId);assert.equal(up.availability,'ready');assert.equal(up.mcp.instance_id,first.mcp.instance_id);
  assert.equal(runtime.exec.list().sessions.length,0);
  const mismatch=await probe(mcp,'mcp','not-the-instance');assert.equal(mismatch.reason,'instance_changed');assert.equal(mismatch.ok,false);
});
test('health: malformed, oversized, redirected and slow endpoints are bounded failures',async t=>{
  const server=createServer((q,r)=>{
    if(q.url==='/large')r.end('x'.repeat(70000));
    else if(q.url==='/redirect'){r.writeHead(302,{Location:'/malformed'});r.end();}
    else if(q.url==='/slow'){}else r.end('{broken');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const route of ['/large','/redirect','/slow','/malformed']){
    const before=performance.now(),r=await probe(base+route,'mcp',undefined,80);
    assert.equal(r.ok,false,route);assert(performance.now()-before<1500);
  }
});
test('health: disabled Tunnel reports ready based on MCP only',async t=>{
  const config=await fixture(t),runtime=new Runtime(config),http=await startHttp(runtime);t.after(()=>http.close());
  const health=await probePair(http.url.replace('/mcp','/healthz'),undefined,runtime.exec.instanceId);
  assert.equal(health.availability,'ready');assert.equal(health.mcp.ok,true);assert.equal(health.tunnel.disabled,true);
});
