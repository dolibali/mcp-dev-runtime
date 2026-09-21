import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ToolError } from '../runtime/errors.js';

export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
export function validPath(value: string): boolean { return value.length <= 4096 && !/[\0\r\n]/.test(value); }
export function fingerprint(s: Stats): string { return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':'); }
export function utf8Prefix(value: string, bytes: number): string {
  const data = Buffer.from(value);
  let end = Math.min(bytes, data.length);
  while (end > 0 && end < data.length && (data[end]! & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString('utf8');
}
export async function canonicalDirectory(value: string): Promise<string> {
  if(process.platform==='win32'&&!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value)){
    throw new ToolError('INVALID_WORKDIR','Windows workdir must include its drive or UNC share.');
  }
  if (!path.isAbsolute(value) || !validPath(value)) throw new ToolError('INVALID_WORKDIR', 'workdir must be an absolute existing directory.');
  try {
    const resolved = await realpath(value);
    if (!(await stat(resolved)).isDirectory()) throw new Error();
    return resolved;
  } catch { throw new ToolError('INVALID_WORKDIR', 'workdir must be an absolute existing directory.'); }
}

// Resolve first; O_NOFOLLOW protects the final component and O_NONBLOCK prevents
// a file swapped to a FIFO from hanging open(). This is a path guard, not a sandbox.
export async function fileIdentity(file: string, root?: string): Promise<{ file: string; stamp: string; size: number }> {
  if (!validPath(file)) throw new ToolError('INVALID_SKILL_PATH', 'Invalid skill file path.');
  const resolved = await realpath(file);
  if (root && !inside(root, resolved)) throw new ToolError('RESOURCE_OUTSIDE_SKILL', 'The resource leaves the selected skill directory.');
  const s = await lstat(resolved);
  if (!s.isFile()) throw new ToolError('INVALID_SKILL_FILE', 'Only regular skill files may be read.');
  return { file: resolved, stamp: fingerprint(s), size: s.size };
}
export async function readText(file: string, maximum: number, root?: string, prefixOnly = false) {
  const identity = await fileIdentity(file, root);
  if (!prefixOnly && identity.size > maximum) throw new ToolError('SKILL_TOO_LARGE', 'Text resource exceeds the bounded file size; split it into references.');
  const handle = await open(identity.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || fingerprint(before) !== identity.stamp) throw new ToolError('SKILL_CHANGED', 'Skill file changed while opening; retry from the beginning.');
    const capacity = Math.min(before.size, maximum) + 1;
    const data = Buffer.alloc(capacity);
    let size = 0;
    while (size < capacity) {
      const { bytesRead } = await handle.read(data, size, capacity - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (fingerprint(await handle.stat()) !== identity.stamp || await realpath(file) !== identity.file) {
      throw new ToolError('SKILL_CHANGED', 'Skill file changed during reading; retry from the beginning.');
    }
    const partial = size > maximum;
    if (partial && !prefixOnly) throw new ToolError('SKILL_TOO_LARGE', 'Text resource exceeds the bounded file size.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data.subarray(0, Math.min(size, maximum)), { stream: partial }); }
    catch { throw new ToolError('INVALID_SKILL_TEXT', 'Skill resources must be UTF-8 text.'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new ToolError('INVALID_SKILL_TEXT', 'Binary/control data is not a text skill resource.');
    return { text, partial, file: identity.file, stamp: identity.stamp };
  } finally { await handle.close(); }
}

export function resourcePath(root: string, resource: string): string {
  if (!resource || !validPath(resource) || path.isAbsolute(resource) || resource.includes('\\') || resource.includes(':') ||
      resource.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new ToolError('INVALID_RESOURCE', 'Use a non-hidden, skill-relative resource path without traversal or a URL.');
  }
  return path.join(root, resource);
}
