// node-pty 1.1.0 publishes some Unix spawn-helper files without executable bits.
// Repair only this project's installed native helper; never change system files.
import { createRequire } from 'node:module';
import { access, chmod, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
if (process.platform !== 'win32') {
  const root = path.resolve(path.dirname(require.resolve('node-pty')), '..');
  for (const name of [
    `prebuilds/${process.platform}-${process.arch}/spawn-helper`,
    'build/Release/spawn-helper', 'build/Debug/spawn-helper'
  ]) {
    const file = path.join(root, name);
    let info;
    try { info = await stat(file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile()) throw new Error(`Invalid PTY helper: ${file}`);
    try { await access(file, constants.X_OK); }
    catch { await chmod(file, info.mode | 0o111); console.error(`Prepared PTY helper: ${name}`); }
  }
}
