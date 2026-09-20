import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fixture, nodeCmd } from '../helpers.mjs';
import { fileURLToPath } from 'node:url';
test('stdio: official client discovers six tools and executes a real command',async t=>{
  const config=await fixture(t);const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../dist/main.js',import.meta.url)),'--transport','stdio','--cwd',config.cwd,'--shell','/bin/bash','--log-level','silent'],stderr:'pipe'});
  const c=new Client({name:'stdio-test',version:'1.0.0'});t.after(()=>c.close());await c.connect(transport);
  assert.equal((await c.listTools()).tools.length,6);let r=await c.callTool({name:'exec_command',arguments:{cmd:'printf stdio-ok'}});
  assert.equal(r.isError,false);assert(r.content[0].text.includes('stdio-ok'));
  assert.equal(r.structuredContent.exit_code,0);
});
