import { request } from 'node:http';
import { lstat, open, readFile, rm, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export async function info(file) {
  try { return await lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export function isInside(parent, child) {
  parent = path.resolve(parent); child = path.resolve(child);
  return child === parent || child.startsWith(parent + path.sep);
}

export function expandConfiguredPath(value, base, home = homedir()) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid configured path.');
  const expanded = value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  return path.resolve(base, expanded);
}

export async function requireOwnedDirectory(dir, label = 'directory') {
  const s = await info(dir);
  if (!s) return false;
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid()) {
    throw new Error(`Refusing unsafe ${label} (must be a real directory owned by the current user): ${dir}`);
  }
  return true;
}

export async function removeOwnedPath(target, { root } = {}) {
  const absolute = path.resolve(target);
  if (root && !isInside(root, absolute)) throw new Error('Refusing deletion outside the owned root: ' + absolute);
  const s = await info(absolute);
  if (!s) return false;
  if (s.isDirectory() && !s.isSymbolicLink()) {
    if (s.uid !== process.getuid()) throw new Error('Refusing directory not owned by the current user: ' + absolute);
    await rm(absolute, { recursive: true, force: false });
  } else {
    if (s.uid !== process.getuid()) throw new Error('Refusing file not owned by the current user: ' + absolute);
    await unlink(absolute);
  }
  return true;
}

export async function confirmCompleteUninstall(lines, input = process.stdin, output = process.stdout) {
  output.write('MCP Dev Runtime will be completely uninstalled.\n\n');
  output.write('The following will be removed:\n');
  for (const line of lines) output.write('  ' + line + '\n');
  output.write('\nThis permanently deletes MDR configuration, credentials, history, logs and installed runtime data.\n');
  output.write('\nContinue? [y/N]: ');
  return new Promise(resolve => {
    let buffer = '', settled = false;
    const cleanup = () => {
      input.off('data', onData); input.off('end', onEnd); input.off('error', onError);
    };
    const finish = value => {
      if (settled) return;
      settled = true; cleanup(); resolve(value);
    };
    const decide = text => finish(text.trim().toLowerCase() === 'y');
    const onData = chunk => {
      buffer += chunk.toString();
      if (buffer.length > 256) return finish(false);
      const newline = buffer.search(/[\r\n]/);
      if (newline >= 0) decide(buffer.slice(0, newline));
    };
    const onEnd = () => decide(buffer);
    const onError = () => finish(false);
    input.on('data', onData); input.once('end', onEnd); input.once('error', onError);
    if (input.readableEnded) queueMicrotask(onEnd);
  });
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

async function postStop(state) {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath: state.control_socket,
      path: '/stop',
      method: 'POST',
      headers: { 'X-Run-ID': state.run_id }
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (text.length > 65536) res.destroy(new Error('Oversized supervisor response')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Supervisor refused shutdown.'));
        try {
          const body = JSON.parse(text);
          if (body.run_id !== state.run_id) throw new Error('Supervisor identity mismatch.');
          resolve();
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(2500, () => req.destroy(new Error('Supervisor shutdown request timed out.')));
    req.on('error', reject); req.end();
  });
}

export async function stopManagedState(stateDir) {
  const file = path.join(stateDir, 'supervisor.json');
  const s = await info(file);
  if (!s) return { status: 'stopped' };
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid()) {
    throw new Error('Refusing unsafe supervisor state file: ' + file);
  }
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('Cannot safely read supervisor state before uninstall: ' + file); }
  if (!state?.run_id || !Number.isSafeInteger(state.pid) || typeof state.control_socket !== 'string') {
    throw new Error('Invalid supervisor state; inspect it before uninstalling: ' + file);
  }
  if (!alive(state.pid)) return { status: 'stale', run_id: state.run_id };
  try { await postStop(state); }
  catch (error) {
    throw new Error('The managed MDR process is still alive but could not be safely stopped. Uninstall was cancelled: ' + error.message);
  }
  const until = Date.now() + 22000;
  while (Date.now() < until) {
    const current = await info(file);
    if (!current) return { status: 'stopped', run_id: state.run_id };
    let next;
    try { next = JSON.parse(await readFile(file, 'utf8')); } catch {}
    if (next?.run_id && next.run_id !== state.run_id) {
      throw new Error('A different MDR instance appeared while uninstalling. No files were deleted.');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Managed MDR shutdown did not finish within 22 seconds. No files were deleted.');
}

export async function removeOwnedCommand(file, expectedHeader) {
  const s = await info(file);
  if (!s) return { status: 'absent', path: file };
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid()) return { status: 'foreign', path: file };
  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { return { status: 'foreign', path: file }; }
  let before, text;
  try {
    before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.size > 65536) return { status: 'foreign', path: file };
    text = await handle.readFile('utf8');
  } finally { await handle.close(); }
  if (!text.startsWith(expectedHeader)) return { status: 'foreign', path: file };
  const now = await lstat(file);
  if (!now.isFile() || now.isSymbolicLink() || before.dev !== now.dev || before.ino !== now.ino ||
      before.mtimeMs !== now.mtimeMs || before.size !== now.size) {
    throw new Error('Command changed while uninstalling; refusing to remove it: ' + file);
  }
  await unlink(file);
  return { status: 'removed', path: file };
}

export async function readJsonIfPresent(file) {
  const s = await info(file);
  if (!s) return null;
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid()) throw new Error('Refusing unsafe JSON file: ' + file);
  return JSON.parse(await readFile(file, 'utf8'));
}

export function dedupeDeletionRoots(paths) {
  const sorted = [...new Set(paths.filter(Boolean).map(p => path.resolve(p)))].sort((a, b) => a.length - b.length);
  return sorted.filter((p, index) => !sorted.slice(0, index).some(parent => isInside(parent, p)));
}
