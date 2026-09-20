import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, chmod } from 'node:fs/promises';
import path from 'node:path';

export const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
export async function digest(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
function safeRelative(name) {
  return typeof name === 'string' && name && !name.includes('\\') && !/[\0\r\n]/.test(name) &&
    !path.isAbsolute(name) && name.split('/').every(s => s && s !== '.' && s !== '..');
}
export async function inventory(root, { normalize = false } = {}) {
  const files = [];
  async function walk(dir, rel = '') {
    for (const name of (await readdir(dir)).sort()) {
      const relative = rel ? rel + '/' + name : name;
      if (relative === 'BUILD-MANIFEST.json') continue;
      if (!safeRelative(relative)) throw new Error('Unsafe bundle path: ' + relative);
      const file = path.join(dir, name), info = await lstat(file);
      if (info.isSymbolicLink()) {
        const target = await readlink(file);
        const resolved = path.resolve(path.dirname(file), target);
        if (path.isAbsolute(target) || !resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('External bundle symlink: ' + relative);
        files.push({ path: relative, type: 'symlink', target });
      } else if (info.isDirectory()) {
        if (normalize) await chmod(file, 0o755);
        await walk(file, relative);
      } else if (info.isFile()) {
        const mode = normalize ? (info.mode & 0o111 ? 0o755 : 0o644) : info.mode & 0o777;
        if (normalize) await chmod(file, mode);
        files.push({ path: relative, type: 'file', size: info.size, mode, sha256: await digest(file) });
      } else throw new Error('Unsupported bundle file type: ' + relative);
    }
  }
  await walk(root);
  return files;
}
export async function verifyBundle(root) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Bundle root must be a real directory, not a symlink.');
  const manifestPath = path.join(root, 'BUILD-MANIFEST.json');
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid bundle manifest file.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1 || manifest.project !== 'mcp-dev-runtime' ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version) || !Array.isArray(manifest.files)) throw new Error('Invalid bundle manifest.');
  const actual = await inventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Bundle integrity check failed (files, permissions, links or hashes differ). Re-download the release.');
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('This bundle does not match the current platform/architecture.');
  return manifest;
}
