import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type ProcessEvents = {
  output: (text: string) => void;
  closed: (code: number | null, signal: string | null, error?: string) => void;
};
export type ProcessHandle = { pid: number | undefined; write: (text: string) => void; kill: (signal: NodeJS.Signals) => void };
export function startPipe(shell: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, events: ProcessEvents): ProcessHandle {
  const child = spawn(shell, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let error: string | undefined, leaderExited = false;
  for (const stream of [child.stdout!, child.stderr!]) {
    const decoder = new StringDecoder('utf8');
    stream.on('data', (chunk: Buffer) => { const text = decoder.write(chunk); if (text) events.output(text); });
    stream.on('end', () => { const text = decoder.end(); if (text) events.output(text); });
    stream.on('error', e => { error = e.message; });
  }
  child.on('error', e => { error = e.message; });
  child.on('exit', () => { leaderExited = true; });
  // 'close', not 'exit': the final output must be drained before a terminal state.
  child.on('close', (code, signal) => events.closed(code, signal, error));
  return {
    pid: child.pid,
    write: () => { throw new Error('Pipe stdin is closed.'); },
    kill: signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') return;
        // Some host launch environments disallow group signalling. Never fall
        // back to an already exited leader, whose PID could have been reused.
        if (leaderExited) throw e;
        child.kill(signal);
      }
    }
  };
}
