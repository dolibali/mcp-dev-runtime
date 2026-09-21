import { mkdir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export async function privateDirectory(dir: string) {
  if (process.platform === 'win32') {
    const { windowsSecurity } = await import('../platform/windows-host.js');
    await windowsSecurity('private-dir', dir); return;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) {
    throw new Error('Refusing unsafe private directory (must be owned by you, mode 0700, not a symlink): ' + dir);
  }
}

export async function writePrivateIfMissing(file: string, content: string): Promise<boolean> {
  await privateDirectory(path.dirname(file));
  let handle;
  try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const info = await lstat(file);
    if (process.platform === 'win32') {
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe existing private configuration.');
      const { windowsSecurity } = await import('../platform/windows-host.js');
      await windowsSecurity('validate-private', file); return false;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) {
      throw new Error('Refusing unsafe existing configuration (must be owned by you, mode 0600, not a symlink): ' + file);
    }
    return false;
  }
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  return true;
}
