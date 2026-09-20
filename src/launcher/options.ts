import path from 'node:path';
import { readFile } from 'node:fs/promises';
import * as z from 'zod/v4';
import { PACKAGE_ROOT, layout, launcherConfigPath, userConfigPath } from './layout.js';
import { isUnifiedUserConfig, launcherConfigFromUnified } from '../user-config.js';

export const ROOT = PACKAGE_ROOT;
// src/launcher and dist/launcher have the same depth from the package root.
export const launcherSchema = z.strictObject({
  runtime_config: z.string().optional(),
  state_dir: z.string().default('.runtime'),
  logs_dir: z.string().optional(),
  tunnel_bin: z.string().optional(),
  tunnel_enabled: z.boolean().default(true),
  tunnel_health_port: z.number().int().min(1).max(65535).default(9098),
  ready_timeout_ms: z.number().int().min(1000).max(120000).default(30000),
  env_file: z.string().optional(),
  shell_env: z.boolean().default(false),
  health_interval_ms:z.number().int().min(250).max(60000).default(5000),
  log_max_bytes:z.number().int().min(1024).max(104857600).default(10485760),
  log_files:z.number().int().min(1).max(20).default(3)
});
export type LaunchOptions = z.infer<typeof launcherSchema>;
export type ResolvedLaunchOptions = LaunchOptions & {
  configuration_file: string | null;
  launcher_config_file: string | null;
  configuration_mode: 'unified' | 'legacy-split' | 'defaults';
};

async function json(file: string, explicit = false): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) {
    if (!explicit && (e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function options(file?: string, overrides: Record<string, unknown> = {}): Promise<ResolvedLaunchOptions> {
  const l = layout();
  let location: string | null = null;
  let launcherFile: string | null = null;
  let mode: ResolvedLaunchOptions['configuration_mode'] = 'defaults';
  let data: Record<string, unknown> = {};
  if (file) {
    location = path.resolve(file);
    const raw = await json(location, true) ?? {};
    if (isUnifiedUserConfig(raw)) {
      data = launcherConfigFromUnified(raw);
      data.runtime_config = location;
      mode = 'unified';
    } else {
      data = raw;
      launcherFile = location;
      mode = 'legacy-split';
    }
  } else {
    const legacy = launcherConfigPath();
    const legacyData = await json(legacy);
    if (legacyData) {
      data = legacyData;
      launcherFile = legacy;
      location = legacy;
      mode = 'legacy-split';
    } else {
      const configFile = userConfigPath();
      const configData = await json(configFile);
      if (configData && isUnifiedUserConfig(configData)) {
        data = launcherConfigFromUnified(configData);
        data.runtime_config = configFile;
        location = configFile;
        mode = 'unified';
      } else if (configData) {
        data = { runtime_config: configFile };
        location = configFile;
        mode = 'legacy-split';
      }
    }
  }
  const userDefaults = l.mode === 'binary' ? { state_dir: l.state_dir } : {};
  const parsed = launcherSchema.parse({ ...userDefaults, ...data, ...overrides });
  const base = path.dirname(location ?? launcherConfigPath());
  for (const key of ['runtime_config','state_dir','logs_dir','tunnel_bin','env_file'] as const) {
    if (parsed[key]) parsed[key] = path.resolve(base, parsed[key]!);
  }
  parsed.logs_dir ??= l.mode === 'binary' && !Object.hasOwn(data, 'state_dir') && !Object.hasOwn(overrides, 'state_dir') ? l.logs_dir : parsed.state_dir;
  if (!parsed.runtime_config) {
    const local = path.join(l.config_dir, 'config.json');
    try { await readFile(local); parsed.runtime_config = local; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  const configurationFile = mode === 'unified' ? parsed.runtime_config ?? location : parsed.runtime_config ?? location;
  return Object.assign(parsed, {
    configuration_file: configurationFile ?? null,
    launcher_config_file: launcherFile,
    configuration_mode: mode
  });
}

export async function resolveOptions({
  configFile,
  launcherFile,
  overrides = {}
}: {
  configFile?: string;
  launcherFile?: string;
  overrides?: Record<string, unknown>;
} = {}): Promise<ResolvedLaunchOptions> {
  if (launcherFile) {
    if (configFile) {
      const raw = await json(path.resolve(configFile), true) ?? {};
      if (isUnifiedUserConfig(raw)) {
        throw new Error('A unified --config already contains launcher settings; do not combine it with legacy --launcher-config.');
      }
    }
    const merged = { ...overrides, ...(configFile ? { runtime_config: path.resolve(configFile) } : {}) };
    return options(path.resolve(launcherFile), merged);
  }
  if (configFile) {
    const location = path.resolve(configFile);
    const raw = await json(location, true) ?? {};
    if (isUnifiedUserConfig(raw)) return options(location, overrides);
    return options(undefined, { ...overrides, runtime_config: location });
  }
  return options(undefined, overrides);
}
