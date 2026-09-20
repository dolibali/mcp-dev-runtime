import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const url = process.argv[2] ?? 'http://127.0.0.1:3001/mcp';
const client = new Client({name:'local-dev-mcp-smoke',version:'0.1.0'});
function unpack(result) {
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content));
  const text = result.content?.find(c=>c.type==='text')?.text ?? '';
  const at = text.indexOf('\n');
  return {...result.structuredContent, output:result.structuredContent?.output ?? (at<0?'':text.slice(at+1))};
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const expected=['exec_command','write_stdin','apply_patch','view_image','list_exec_sessions','terminate_exec_session'];
  const tools=(await client.listTools()).tools.map(x=>x.name);
  assert.deepEqual(tools.sort(),expected.sort());console.log('Tool discovery: PASS (6 tools)');
  let r=unpack(await client.callTool({name:'exec_command',arguments:{cmd:"printf 'local-dev-mcp-ok'",yield_time_ms:1000}}));
  let output=r.output;const deadline=Date.now()+10000;
  while(r.state==='running'||r.state==='terminating'||r.has_more){
    assert(Date.now()<deadline,'Smoke command did not finish');
    r=unpack(await client.callTool({name:'write_stdin',arguments:{session_id:r.session_id,yield_time_ms:1000}}));output+=r.output;
  }
  assert.equal(r.exit_code,0);assert.equal(output,'local-dev-mcp-ok');
  console.log('Real command and exit code: PASS');
  // A long-running service can have more retained records than one page.
  // Follow the stable listing cursor; never rerun the command to locate it.
  let cursor,found=false;
  const seenCursors=new Set(),lookupDeadline=Date.now()+10000;
  do {
    assert(Date.now()<lookupDeadline,'Smoke session lookup timed out');
    const sessions=unpack(await client.callTool({name:'list_exec_sessions',arguments:{limit:100,...(cursor?{cursor}:{})}}));
    if(sessions.sessions.some(s=>s.session_id===r.session_id)){found=true;break;}
    cursor=sessions.next_cursor;
    if(cursor){assert(!seenCursors.has(cursor),'Smoke session pagination did not advance');seenCursors.add(cursor);}
  } while(cursor);
  assert(found,'Smoke execution was not found in retained session pages');console.log('Session lookup: PASS');
  console.log('LOCAL MCP SMOKE PASSED');
} finally {await client.close();}
