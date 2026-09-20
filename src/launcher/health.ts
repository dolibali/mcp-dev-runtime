import { NAME } from '../version.js';

export type Probe = {ok:boolean;checked_at:string;latency_ms:number;http_status?:number;reason?:string;instance_id?:string;details?:Record<string,unknown>;disabled?:boolean};
/** Fresh bounded local probes. No shell commands, keys, remote inference or task replays. */
export async function probe(url:string,kind:'mcp'|'tunnel',expectedInstance?:string,timeout=1500):Promise<Probe>{
  const start=performance.now(),base={checked_at:new Date().toISOString()};
  try{
    const response=await fetch(url,{signal:AbortSignal.timeout(timeout),redirect:'error'});
    const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
    if(reader){try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536){await reader.cancel();throw new Error('Health response exceeds 64 KiB.');}chunks.push(part.value);}}finally{reader.releaseLock();}}
    const text=Buffer.concat(chunks).toString('utf8');
    if(!response.ok)return {...base,ok:false,http_status:response.status,latency_ms:performance.now()-start,reason:'http_error'};
    if(kind==='tunnel')return {...base,ok:text.trim()==='ready',http_status:response.status,latency_ms:performance.now()-start,
      ...(text.trim()==='ready'?{}:{reason:'not_ready'})};
    const data=JSON.parse(text) as Record<string,unknown>;
    if(data.server!==NAME||data.status!=='ok'||typeof data.instance_id!=='string')return {...base,ok:false,http_status:response.status,latency_ms:performance.now()-start,reason:'unexpected_runtime'};
    if(expectedInstance&&data.instance_id!==expectedInstance)return {...base,ok:false,http_status:response.status,latency_ms:performance.now()-start,instance_id:data.instance_id,reason:'instance_changed'};
    return {...base,ok:true,http_status:response.status,latency_ms:performance.now()-start,instance_id:data.instance_id,details:data};
  }catch(e){return {...base,ok:false,latency_ms:performance.now()-start,reason:e instanceof Error?e.message.slice(0,200):'probe_failed'};}
}
export async function probePair(mcpUrl:string,tunnelUrl?:string,expectedInstance?:string){
  const mcpPromise=probe(mcpUrl,'mcp',expectedInstance);
  const tunnelPromise=tunnelUrl
    ? probe(tunnelUrl,'tunnel')
    : Promise.resolve<Probe>({ok:true,disabled:true,checked_at:new Date().toISOString(),latency_ms:0,reason:'disabled'});
  const [mcp,tunnel]=await Promise.all([mcpPromise,tunnelPromise]);
  return {checked_at:new Date().toISOString(),availability:mcp.ok&&tunnel.ok?'ready':'degraded',mcp,tunnel,
    scope:tunnel.disabled
      ? 'Local MCP readiness only; Tunnel is disabled by configuration.'
      : 'Local runtime and Tunnel readiness only; not a ChatGPT/WAN round-trip guarantee.'};
}
