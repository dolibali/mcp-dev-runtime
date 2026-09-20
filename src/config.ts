import { readFile, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { ToolError } from './runtime/errors.js';
import { defaultToolAllowlist, validateToolAllowlist } from './mcp/tool-registry.js';
import { isUnifiedUserConfig, runtimeConfigFromUnified } from './user-config.js';

const integer = (min: number, max: number, fallback: number) => z.number().int().min(min).max(max).default(fallback);
export const configSchema = z.strictObject({
  transport: z.enum(['http', 'stdio']).default('http'),
  host: z.string().min(1).default('127.0.0.1'),
  port: integer(0, 65535, 3001),
  mcp_path: z.string().startsWith('/').default('/mcp'),
  health_path: z.string().startsWith('/').default('/healthz'),
  cwd: z.string().min(1).default(process.cwd()),
  shell: z.string().min(1).default(process.env.SHELL || '/bin/bash'),
  exec: z.strictObject({
    default_login: z.boolean().default(false), default_tty: z.boolean().default(false),
    default_yield_time_ms: integer(0, 10000, 1000), max_yield_time_ms: integer(1, 10000, 10000),
    default_max_output_tokens: integer(256, 16000, 4000), max_output_tokens: integer(256, 16000, 16000),
    max_active_sessions: integer(1, 64, 8),
    per_session_output_bytes: integer(1024, 268435456, 8388608),
    total_output_bytes: integer(1024, 1073741824, 67108864),
    // null (preferred) and 0 disable time-based eviction; capacity limits remain.
    retained_session_ms: z.union([z.literal(0), z.number().int().min(100).max(86400000), z.null()]).default(null),
    max_ended_sessions: integer(1, 4096, 512),
    maintenance_interval_ms: integer(50, 300000, 30000),
    termination_grace_ms: integer(1, 10000, 2000),
    default_poll_yield_time_ms: integer(0, 10000, 5000), default_input_yield_time_ms: integer(0, 10000, 250)
  }).prefault({}),
  history: z.strictObject({
    enabled: z.boolean().default(true),
    directory: z.string().min(1).default('.mcp-dev-runtime/history'),
    record_command: z.boolean().default(false), record_output: z.boolean().default(false),
    max_records: integer(1, 100000, 4096),
    max_total_bytes: integer(65536, 10737418240, 268435456),
    max_log_bytes: integer(1024, 268435456, 16777216),
    max_pending_bytes: integer(1024, 16777216, 1048576)
  }).prefault({}),
  tools: z.strictObject({
    allow: z.array(z.string().min(1)).default([...defaultToolAllowlist])
  }).prefault({}),
  image: z.strictObject({
    max_encoded_bytes: integer(1024, 33554432, 8388608),
    max_input_bytes: integer(1024, 134217728, 33554432),
    max_input_pixels: integer(1, 100000000, 40000000),
    max_output_dimension: integer(32, 8192, 2048)
  }).prefault({}),
  patch: z.strictObject({
    max_patch_bytes: integer(1024, 16777216, 4194304), max_file_bytes: integer(1024, 134217728, 16777216),
    max_total_file_bytes: integer(1024, 268435456, 67108864), max_files: integer(1, 1024, 256)
  }).prefault({}),
  request_cache_entries: integer(8, 2048, 128),
  request_cache_ttl_ms: integer(100, 86400000, 600000),
  max_http_body_bytes: integer(1024, 33554432, 8388608),
  log_level: z.enum(['debug', 'info', 'warn', 'silent']).default('info')
});
export type Config = z.infer<typeof configSchema>;
export function expandPath(value: string, base: string): string {
  if (value.includes('\0')) throw new ToolError('INVALID_PATH', 'Paths cannot contain NUL.');
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
  return path.resolve(base, expanded);
}
export async function validateConfig(config: Config): Promise<Config> {
  if (process.platform === 'win32') throw new Error('This release supports macOS/Linux POSIX shells only.');
  config.cwd = expandPath(config.cwd, process.cwd());
  config.shell = expandPath(config.shell, process.cwd());
  if (!(await stat(config.cwd)).isDirectory()) throw new Error('cwd must be an existing directory.');
  await access(config.shell, constants.X_OK);
  if (config.mcp_path === config.health_path) throw new Error('mcp_path and health_path must differ.');
  if (config.exec.default_yield_time_ms > config.exec.max_yield_time_ms ||
      config.exec.default_max_output_tokens > config.exec.max_output_tokens) throw new Error('Default budget exceeds configured maximum.');
  config.tools.allow = validateToolAllowlist(config.tools.allow);
  return config;
}
export async function loadConfig(filename?: string, overrides: Record<string, unknown> = {}): Promise<Config> {
  const raw = filename ? JSON.parse(await readFile(filename, 'utf8')) : {};
  const fromFile = isUnifiedUserConfig(raw) ? runtimeConfigFromUnified(raw) : raw;
  if (filename && isUnifiedUserConfig(raw)) {
    const base = path.dirname(path.resolve(filename));
    if (typeof fromFile.cwd === 'string') fromFile.cwd = expandPath(fromFile.cwd, base);
    if (typeof fromFile.shell === 'string') fromFile.shell = expandPath(fromFile.shell, base);
  }
  // Resolve a missing cwd at invocation time, not when the schema was imported.
  return validateConfig(configSchema.parse({ cwd: process.cwd(), ...fromFile, ...overrides }));
}
