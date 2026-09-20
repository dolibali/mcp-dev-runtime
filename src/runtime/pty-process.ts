import * as pty from 'node-pty';
import { constants } from 'node:os';
import type { ProcessEvents, ProcessHandle } from './pipe-process.js';

export function startPty(shell: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, events: ProcessEvents): ProcessHandle {
  const terminal = pty.spawn(shell, args, {
    name: 'xterm-256color', cols: 120, rows: 40, cwd,
    env: Object.fromEntries(Object.entries(env).filter((x): x is [string, string] => x[1] !== undefined)),
    encoding: 'utf8'
  });
  let closed = false;
  terminal.onData(text => events.output(text));
  // node-pty emits onExit after its data reader has drained the PTY.
  terminal.onExit(({ exitCode, signal }) => {
    closed = true;
    const name = signal ? Object.entries(constants.signals).find(([, n]) => n === signal)?.[0] ?? `SIGNAL_${signal}` : null;
    events.closed(name ? null : exitCode, name);
  });
  return {
    pid: terminal.pid,
    write: text => terminal.write(text),
    kill: signal => {
      if (closed) return;
      try { process.kill(-terminal.pid, signal); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') { terminal.kill(signal); return; }
        terminal.kill(signal);
      }
    }
  };
}
