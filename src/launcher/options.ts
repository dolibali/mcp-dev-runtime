import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import * as z from 'zod/v4';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// src/launcher and dist/launcher have the same depth from the package root.
export const launcherSchema = z.strictObject({
  runtime_config: z.string().optional(),
  state_dir: z.string().default('.runtime'),
  tunnel_bin: z.string().optional(),
  tunnel_health_port: z.number().int().min(1).max(65535).default(9098),
  ready_timeout_ms: z.number().int().min(1000).max(120000).default(30000),
  env_file: z.string().optional(),
  shell_env: z.boolean().default(false),
  health_interval_ms:z.number().int().min(250).max(60000).default(5000),
  log_max_bytes:z.number().int().min(1024).max(104857600).default(10485760),
  log_files:z.number().int().min(1).max(20).default(3)
});
export type LaunchOptions = z.infer<typeof launcherSchema>;
export async function options(file?: string, overrides: Record<string, unknown> = {}): Promise<LaunchOptions> {
  const location = path.resolve(file ?? path.join(ROOT, 'launcher.config.json'));
  let data = {};
  try { data = JSON.parse(await readFile(location, 'utf8')); }
  catch (e) { if (file || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const parsed = launcherSchema.parse({ ...data, ...overrides });
  const base = path.dirname(location);
  for (const key of ['runtime_config','state_dir','tunnel_bin','env_file'] as const) {
    if (parsed[key]) parsed[key] = path.resolve(base, parsed[key]!);
  }
  if (!parsed.runtime_config) {
    const local = path.join(ROOT, 'config.json');
    try { await readFile(local); parsed.runtime_config = local; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return parsed;
}
