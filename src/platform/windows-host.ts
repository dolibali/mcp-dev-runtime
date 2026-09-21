import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
let verifiedPath: string | undefined;

export function windowsHostPath(): string {
  if (process.platform !== 'win32') throw new Error('Windows native adapter is only used on Windows.');
  if (verifiedPath) return verifiedPath;
  const marker = path.join(root, 'distribution.json');
  let candidate: string;
  if (existsSync(marker)) {
    const d = JSON.parse(readFileSync(marker, 'utf8'));
    candidate = path.join(root, 'native', 'mdr-windows-host.exe');
    if (!/^[a-f0-9]{64}$/.test(d.windows_host_sha256 ?? '') ||
        createHash('sha256').update(readFileSync(candidate)).digest('hex') !== d.windows_host_sha256) {
      throw new Error('Bundled Windows adapter checksum mismatch. Reinstall a verified package.');
    }
  } else {
    candidate = process.env.MDR_WINDOWS_HOST
      ? path.resolve(process.env.MDR_WINDOWS_HOST)
      : path.join(root, '.runtime', 'bin', 'mdr-windows-host.exe');
  }
  if (!statSync(candidate).isFile()) throw new Error('Windows adapter is missing; run npm run build:windows-host in a source checkout.');
  return verifiedPath = candidate;
}

/** Windows environment keys are case insensitive; resolve layers before spawn. */
export function windowsEnvironment(...layers: NodeJS.ProcessEnv[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const layer of layers) for (const [key, value] of Object.entries(layer)) {
    if (value !== undefined) out[key.toUpperCase()] = value;
  }
  return out;
}

export async function windowsSecurity(operation: 'private-dir' | 'private-file' | 'validate-private' | 'pipe-acl', filename: string): Promise<void> {
  try { await exec(windowsHostPath(), [operation, filename], { windowsHide: true, timeout: 10000, maxBuffer: 16384 }); }
  catch (error) {
    // Child-process error objects include argv. Only this bounded native error is public.
    const stderr = (error as { stderr?: string }).stderr;
    throw new Error(stderr?.trim().slice(0, 2048) || 'Windows ownership / ACL validation failed.');
  }
}

export async function windowsIdentity(pid: number = process.pid): Promise<{ pid: number; sid: string; created: string; elevated: boolean }> {
  const r = await exec(windowsHostPath(), ['identity', String(pid)], { windowsHide: true, timeout: 6000, maxBuffer: 16384 });
  return JSON.parse(r.stdout);
}

export async function windowsReplaceFile(source: string, destination: string): Promise<void> {
  try { await exec(windowsHostPath(), ['replace-file', source, destination], { windowsHide: true, timeout: 10000, maxBuffer: 16384 }); }
  catch (e) { throw new Error((e as {stderr?:string}).stderr?.trim().slice(0,2048) || 'Windows file replacement failed; no delete-and-rename fallback was attempted.'); }
}

type Start = { exe: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; tty?: boolean; stdin?: boolean };
type Frame = { type: string; protocol?: number; pid?: number; stream?: string; data?: string; code?: number };

/** Private framed transport; ordinary tool bytes can never impersonate control. */
export class WindowsChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private readonly host: ChildProcess;
  private ready = false;
  private terminal = false;
  private finalCode: number | undefined;
  private fault: string | undefined;
  private errorReported = false;
  private emergency: NodeJS.Timeout | undefined;
  private readonly blockedOutputs = new Set<PassThrough>();

  constructor(start: Start) {
    super();
    this.host = spawn(windowsHostPath(), ['run'], { cwd: start.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '', diagnostic = '';
    this.host.stdout!.setEncoding('utf8');
    this.host.stdout!.on('data', (text: string) => {
      pending += text;
      if (pending.length > 262144) { this.fail('Oversized Windows adapter frame.'); return; }
      let at: number;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        try { this.frame(JSON.parse(line) as Frame); }
        catch { this.fail('Invalid Windows adapter protocol; execution was stopped.'); return; }
      }
    });
    this.host.stderr!.setEncoding('utf8');
    this.host.stderr!.on('data', (text: string) => { diagnostic = (diagnostic + text).slice(-4096); });
    this.host.stdin!.on('error', () => {});
    this.host.once('error', e => { this.fault = e.message; if (!this.ready) { this.errorReported=true; this.emit('error', e); } });
    this.host.once('close', code => {
      if (this.emergency) clearTimeout(this.emergency);
      this.terminal = true;
      const failure = this.fault ?? (code !== 0 || this.finalCode === undefined
        ? diagnostic.trim() || 'Windows execution host ended without a confirmed result.' : undefined);
      const exitCode = this.finalCode ?? code;
      const drained = Promise.all([this.stdout, this.stderr].map(stream => finished(stream, { writable: false, cleanup: true })));
      this.stdout.end(); this.stderr.end();
      if (!this.ready && failure && !this.errorReported) { this.errorReported=true; this.emit('error', new Error(failure)); }
      void drained.then(() => {
        this.exitCode = exitCode;
        this.emit('exit', this.exitCode, null);
        this.emit('close', this.exitCode, null, failure);
      }, () => {
        this.exitCode = exitCode;
        this.emit('close', this.exitCode, null, failure ?? 'Windows output could not be drained.');
      });
    });
    this.host.stdin!.write(JSON.stringify({ ...start, protocol: 1, type: 'start', env: windowsEnvironment(start.env) }) + '\n');
  }

  private frame(f: Frame) {
    if (f.type === 'ready' && f.protocol === 1 && Number.isSafeInteger(f.pid) && !this.ready) {
      this.pid = f.pid; this.ready = true; this.emit('spawn'); return;
    }
    if (f.type === 'data' && this.ready && this.finalCode === undefined && typeof f.data === 'string') {
      const output = f.stream === 'stderr' ? this.stderr : this.stdout;
      if (!output.write(Buffer.from(f.data, 'base64'))) {
        this.host.stdout!.pause();
        if(!this.blockedOutputs.has(output)){
          this.blockedOutputs.add(output);
          output.once('drain',()=>{
            this.blockedOutputs.delete(output);
            if(this.blockedOutputs.size===0)this.host.stdout!.resume();
          });
        }
      }
      return;
    }
    if (f.type === 'exit' && this.ready && Number.isInteger(f.code) && f.code! >= 0 && f.code! <= 0xffffffff && this.finalCode === undefined) {
      this.finalCode = f.code; this.host.stdin!.end(); return;
    }
    throw new Error('Unexpected Windows adapter frame.');
  }
  private fail(message: string) {
    this.fault ??= message; this.host.kill();
  }
  write(text: string) {
    if (this.terminal) throw new Error('Windows process has already exited.');
    this.host.stdin!.write(JSON.stringify({ type: 'input', data: Buffer.from(text).toString('base64') }) + '\n');
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.terminal) return false;
    const force = signal === 'SIGKILL';
    this.host.stdin!.write(JSON.stringify({ type: 'terminate', force }) + '\n');
    if (force && !this.emergency) {
      this.emergency = setTimeout(() => this.fail('Windows adapter did not confirm forced shutdown.'), 5000);
      this.emergency.unref();
    }
    return true;
  }
}

export async function detachWindows(start: Start, log: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const c = spawn(windowsHostPath(), ['detach'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => { c.kill(); reject(new Error('Windows detached launcher timed out.')); }, 10000);
    c.stdout!.on('data', d => { output += d; }); c.stderr!.on('data', d => { error = (error + d).slice(-4096); });
    c.once('error', e => { clearTimeout(timer); reject(e); });
    c.once('close', code => {
      clearTimeout(timer);
      try { if (code !== 0) throw new Error(error || 'Host policy prevents detached startup.');
        const result = JSON.parse(output); if (!Number.isSafeInteger(result.pid)) throw new Error('Invalid launcher identity.'); resolve(result.pid);
      } catch (e) { reject(e); }
    });
    c.stdin!.end(JSON.stringify({ ...start, protocol: 1, type: 'start', log, env: windowsEnvironment(start.env) }) + '\n');
  });
}
