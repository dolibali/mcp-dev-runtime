import { parseDocument } from 'yaml';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../runtime/errors.js';
import { limits } from './limits.js';
import { hash, readText, utf8Prefix } from './io.js';

export type Metadata = {
  name: string; description: string; short_description?: string; compatibility?: string;
  implicit_allowed: boolean; dependencies: string[]; warnings: string[]; metadata_revision: string;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected YAML object');
  return value as Record<string, unknown>;
}
function yaml(text: string): Record<string, unknown> {
  const doc = parseDocument(text, { strict: true, uniqueKeys: true, stringKeys: true, prettyErrors: false, version: '1.2' });
  // No custom tags, merge expansions or alias graphs in executable guidance metadata.
  if (doc.errors.length || doc.warnings.length) throw new Error('Invalid YAML');
  return object(doc.toJS({ maxAliasCount: 0 }));
}
function field(value: unknown, maximum: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw new Error('Expected text field');
  const text = value.replace(/\s+/g, ' ').trim();
  if ((required && !text) || Buffer.byteLength(text) > maximum) throw new Error('Invalid text length');
  return text || undefined;
}

export async function loadMetadata(file: string, skillRoot: string): Promise<Metadata> {
  const read = await readText(file, limits.metadataBytes, skillRoot, true);
  const lines = read.text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new ToolError('INVALID_SKILL_METADATA', 'SKILL.md requires YAML frontmatter.');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 1) throw new ToolError('INVALID_SKILL_METADATA', 'Frontmatter is missing its end delimiter or exceeds the metadata budget.');
  const header = lines.slice(1, end).join('\n');
  let name: string, description: string, short_description: string | undefined, compatibility: string | undefined;
  try {
    const value = yaml(header);
    name = field(value.name ?? path.basename(skillRoot), 256, true)!;
    description = field(value.description, 4096, true)!;
    compatibility = field(value.compatibility, 1024);
    if (value.metadata !== undefined) short_description = field(object(value.metadata)['short-description'], 1024);
  } catch { throw new ToolError('INVALID_SKILL_METADATA', 'Invalid bounded YAML/name/description in SKILL.md; file contents were not logged.'); }

  let implicit_allowed = true, sidecarRevision = 'absent';
  const dependencies: string[] = [], warnings: string[] = [];
  const sidecar = path.join(skillRoot, 'agents', 'openai.yaml');
  try {
    // lstat distinguishes a genuinely absent optional file from a broken link.
    let exists = true;
    try { await lstat(sidecar); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error; }
    if (exists) {
      const readSidecar = await readText(sidecar, limits.metadataBytes, skillRoot);
      sidecarRevision = hash(readSidecar.text);
      const doc = yaml(readSidecar.text);
      if (doc.policy !== undefined) {
        const policy = object(doc.policy);
        if (policy.allow_implicit_invocation !== undefined && typeof policy.allow_implicit_invocation !== 'boolean') throw new Error('Invalid policy');
        implicit_allowed = policy.allow_implicit_invocation !== false;
        if (policy.products !== undefined && (!Array.isArray(policy.products) || policy.products.length)) {
          implicit_allowed = false; warnings.push('Product restriction cannot be verified by MDR; explicit selection required.');
        }
      }
      if (doc.interface !== undefined) {
        const short = field(object(doc.interface).short_description, 1024);
        short_description ??= short;
      }
      if (doc.dependencies !== undefined) {
        const tools = object(doc.dependencies).tools;
        if (tools !== undefined && !Array.isArray(tools)) throw new Error('Invalid dependencies');
        for (const item of (tools as unknown[] | undefined)?.slice(0, 16) ?? []) {
          const d = object(item), kind = field(d.type, 64), value = field(d.value, 128);
          if (kind && value) dependencies.push(kind + ':' + value);
        }
        if (Array.isArray(tools) && tools.length > 16) warnings.push('Additional dependency declarations omitted.');
      }
    }
  } catch {
    implicit_allowed = false; sidecarRevision = 'invalid';
    warnings.push('Optional openai.yaml is invalid/unreadable; implicit use disabled. No dependency was executed.');
  }
  return {
    name, description, ...(short_description ? { short_description } : {}), ...(compatibility ? { compatibility } : {}),
    implicit_allowed, dependencies, warnings,
    metadata_revision: hash(header + '\0' + sidecarRevision)
  };
}

export function displayDescription(metadata: Metadata) {
  const description = utf8Prefix(metadata.description, 512);
  return { description, description_truncated: description !== metadata.description };
}
