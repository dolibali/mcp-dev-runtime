import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, access, copyFile, chmod, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { VERSION } from '../version.js';
import { ROOT } from './options.js';
const exec = promisify(execFile);
export type TunnelLock = {
  schema_version: number; runtime_version: string; contract_version: string;
  upstream: { repository: string; commit: string; source_version: string; version_label: string; license: string };
  preferred_variant: string; submodule_path: string;
};
export async function readLock(): Promise<TunnelLock> {
  const lock = JSON.parse(await readFile(path.join(ROOT, 'tunnel.lock.json'), 'utf8')) as TunnelLock;
  if (lock.runtime_version !== VERSION) throw new Error('Project version differs from tunnel.lock.json; run npm run versions:sync and validate the release.');
  if (lock.schema_version !== 1 || !/^[a-f0-9]{40}$/.test(lock.upstream?.commit)) throw new Error('Invalid tunnel.lock.json');
  if (lock.upstream.repository !== 'https://github.com/openai/tunnel-client.git') throw new Error('Unexpected upstream repository in tunnel.lock.json');
  return lock;
}
export function compatibleVersion(output: string, lock: TunnelLock): boolean {
  const base = lock.upstream.source_version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sha = lock.upstream.commit.slice(0, 7);
  const text = output.trim();
  const full = new RegExp(`(?:^|\\s)v?${base}\\+${sha}(?:\\s|$|[(-])`).test(text);
  const runtime = new RegExp(`(?:^|\\s)v?${base}\\s+git sha: ${sha}(?:\\s|$)`).test(text);
  return full || runtime;
}
export async function inspectTunnel(file: string, lock: TunnelLock) {
  await access(file, constants.X_OK);
  const resolved = await realpath(file);
  const r = await exec(resolved, ['--version'], { timeout: 6000, maxBuffer: 65536 });
  const reported = r.stdout.trim();
  if (!compatibleVersion(reported, lock)) throw new Error(`Tunnel version mismatch: expected ${lock.upstream.version_label}. Candidate: ${file}`);
  const digest = createHash('sha256').update(await readFile(resolved)).digest('hex');
  // Both upstream run-only and full variants accept the run command in this pin.
  const help = await exec(resolved, ['--help'], { timeout: 6000, maxBuffer: 131072 });
  const hasRunCommand = /^\s+run\s+/m.test(help.stdout);
  return { path: resolved, version: reported, sha256: digest, args_prefix: hasRunCommand ? ['run'] : [],
    variant: path.basename(resolved).includes('runtime') ? 'tunnel-client-runtime' : 'tunnel-client' };
}
export type TunnelBinary = Awaited<ReturnType<typeof inspectTunnel>>;
export async function resolveTunnel(explicit?: string): Promise<TunnelBinary> {
  const lock = await readLock();
  if (explicit || process.env.TUNNEL_BIN) return inspectTunnel(path.resolve(explicit ?? process.env.TUNNEL_BIN!), lock);
  const names = ['tunnel-client-runtime','tunnel-client'];
  const candidates = [
    path.join(ROOT,'.runtime','bin',lock.upstream.commit,'tunnel-client-runtime'),
    ...names.map(n=>path.join(ROOT,lock.submodule_path,'bin',n)),
    path.join(ROOT,'..','tunnel-client','bin','tunnel-client'),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(p=>names.map(n=>path.join(p,n)))
  ];
  for (const file of [...new Set(candidates)]) {
    try { return await inspectTunnel(file, lock); } catch { /* try the next compatible candidate */ }
  }
  throw new Error(`No compatible Tunnel binary found (${lock.upstream.version_label}). Set --tunnel-bin or run npm run tunnel:setup -- --build. No unverified latest download is performed.`);
}
async function command(binary: string, args: string[], cwd: string) {
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(binary,args,{cwd,stdio:['ignore','inherit','inherit']});
    child.once('error',reject); child.once('close',code=>code===0?resolve():reject(new Error(`${binary} failed with exit ${code}`)));
  });
}
export async function buildTunnel() {
  const lock=await readLock(); let source=path.join(ROOT,lock.submodule_path);
  try { await access(path.join(source,'go.mod')); }
  catch {
    source=path.join(ROOT,'.runtime','source','tunnel-client');
    try { await access(path.join(source,'.git')); }
    catch { await mkdir(path.dirname(source),{recursive:true}); await command('git',['clone','--filter=blob:none','--no-checkout',lock.upstream.repository,source],ROOT); }
    await command('git',['fetch','origin',lock.upstream.commit],source);
    await command('git',['checkout','--detach',lock.upstream.commit],source);
  }
  const sha=(await exec('git',['rev-parse','HEAD'],{cwd:source})).stdout.trim();
  if(sha!==lock.upstream.commit) throw new Error('Submodule commit differs from tunnel.lock.json; run git submodule update --init vendor/tunnel-client.');
  if((await exec('git',['status','--porcelain','--untracked-files=no'],{cwd:source})).stdout.trim()) throw new Error('Tunnel source has local modifications; refusing to label it as the locked source.');
  await command('make',['tunnel-client-runtime'],source);
  const built=path.join(source,'bin','tunnel-client-runtime'); await inspectTunnel(built,lock);
  const destination=path.join(ROOT,'.runtime','bin',sha,'tunnel-client-runtime');
  await mkdir(path.dirname(destination),{recursive:true});await copyFile(built,destination);await chmod(destination,0o755);
  const binary=await inspectTunnel(destination,lock);
  await writeFile(destination+'.json',JSON.stringify({source_commit:sha,repository:lock.upstream.repository,kind:'local-source-build',sha256:binary.sha256,built_at:new Date().toISOString()},null,2)+'\n',{mode:0o600});
  return binary;
}
