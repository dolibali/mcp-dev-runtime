import { StringDecoder } from 'node:string_decoder';
import { finished } from 'node:stream/promises';
import type { ProcessEvents, ProcessHandle } from '../runtime/pipe-process.js';
import { WindowsChild, windowsEnvironment } from './windows-host.js';
import { windowsShellArgs } from './shell.js';

export async function startWindowsProcess(shell: string, command: string, login: boolean, tty: boolean, cwd: string,
  env: NodeJS.ProcessEnv, events: ProcessEvents): Promise<ProcessHandle> {
  const prepared = await windowsShellArgs(shell, command, login, tty);
  const childEnv = windowsEnvironment(env);
  for (const key of ['MDR_STDIN_CONTROL', 'CONTROL_PLANE_API_KEY', 'OPENAI_ADMIN_KEY', 'NODE_TEST_CONTEXT']) delete childEnv[key];
  let child: WindowsChild;
  try { child = new WindowsChild({ exe: shell, args: prepared.args, cwd, env: childEnv, tty }); }
  catch (error) { await prepared.cleanup(); throw error; }
  let error: string | undefined;
  child.on('error', e => { error = e.message; });
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    stream.on('data', (data: Buffer) => { const text = decoder.write(data); if (text) events.output(text); });
    stream.on('end', () => { const text = decoder.end(); if (text) events.output(text); });
  }
  child.on('close', (code: number | null, signal: string | null, fault?: string) => {
    void (async () => {
      await Promise.all([finished(child.stdout), finished(child.stderr)]);
      await prepared.cleanup();
      events.closed(code, signal, fault ?? error);
    })().catch(e => events.closed(code, signal, fault ?? error ?? String(e)));
  });
  return { get pid() { return child.pid; }, write: text => {
    if (!tty) throw new Error('Pipe stdin is closed.'); child.write(text);
  }, kill: signal => { child.kill(signal); } };
}
