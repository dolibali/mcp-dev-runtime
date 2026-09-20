import * as z from 'zod/v4';

const unknown = () => z.unknown().optional();

const unifiedSchema = z.strictObject({
  schema_version: z.literal(1).optional(),
  mcp: z.strictObject({
    transport: unknown(),
    host: unknown(),
    port: unknown(),
    path: unknown(),
    health_path: unknown(),
    max_http_body_bytes: unknown()
  }).optional(),
  tunnel: z.strictObject({
    enabled: unknown(),
    health_port: unknown(),
    ready_timeout_ms: unknown(),
    health_interval_ms: unknown(),
    binary: unknown()
  }).optional(),
  tools: z.strictObject({
    allow: unknown()
  }).optional(),
  skills: z.strictObject({ extra_roots: unknown(), disabled_paths: unknown() }).optional(),
  runtime: z.strictObject({
    cwd: unknown(),
    shell: unknown(),
    state_dir: unknown(),
    logs_dir: unknown(),
    env_file: unknown(),
    shell_env: unknown()
  }).optional(),
  exec: z.unknown().optional(),
  history: z.unknown().optional(),
  image: z.unknown().optional(),
  patch: z.unknown().optional(),
  logging: z.strictObject({
    level: unknown(),
    max_bytes: unknown(),
    files: unknown()
  }).optional(),
  request_cache: z.strictObject({
    entries: unknown(),
    ttl_ms: unknown()
  }).optional()
});

export type UnifiedUserConfig = z.infer<typeof unifiedSchema>;

const discriminatorKeys = new Set([
  'schema_version', 'mcp', 'tunnel', 'runtime', 'logging', 'request_cache'
]);

export function isUnifiedUserConfig(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).some(key => discriminatorKeys.has(key));
}

export function parseUnifiedUserConfig(value: unknown): UnifiedUserConfig {
  return unifiedSchema.parse(value);
}

export function runtimeConfigFromUnified(value: unknown): Record<string, unknown> {
  const doc = parseUnifiedUserConfig(value);
  const mcp = doc.mcp ?? {};
  const runtime = doc.runtime ?? {};
  const logging = doc.logging ?? {};
  const requestCache = doc.request_cache ?? {};
  return {
    ...(mcp.transport !== undefined ? { transport: mcp.transport } : {}),
    ...(mcp.host !== undefined ? { host: mcp.host } : {}),
    ...(mcp.port !== undefined ? { port: mcp.port } : {}),
    ...(mcp.path !== undefined ? { mcp_path: mcp.path } : {}),
    ...(mcp.health_path !== undefined ? { health_path: mcp.health_path } : {}),
    ...(runtime.cwd !== undefined ? { cwd: runtime.cwd } : {}),
    ...(runtime.shell !== undefined ? { shell: runtime.shell } : {}),
    ...(doc.exec !== undefined ? { exec: doc.exec } : {}),
    ...(doc.history !== undefined ? { history: doc.history } : {}),
    ...(doc.image !== undefined ? { image: doc.image } : {}),
    ...(doc.patch !== undefined ? { patch: doc.patch } : {}),
    ...(doc.tools !== undefined ? { tools: doc.tools } : {}),
    ...(doc.skills !== undefined ? { skills: doc.skills } : {}),
    ...(requestCache.entries !== undefined ? { request_cache_entries: requestCache.entries } : {}),
    ...(requestCache.ttl_ms !== undefined ? { request_cache_ttl_ms: requestCache.ttl_ms } : {}),
    ...(mcp.max_http_body_bytes !== undefined ? { max_http_body_bytes: mcp.max_http_body_bytes } : {}),
    ...(logging.level !== undefined ? { log_level: logging.level } : {})
  };
}

export function launcherConfigFromUnified(value: unknown): Record<string, unknown> {
  const doc = parseUnifiedUserConfig(value);
  const tunnel = doc.tunnel ?? {};
  const runtime = doc.runtime ?? {};
  const logging = doc.logging ?? {};
  return {
    ...(runtime.state_dir !== undefined ? { state_dir: runtime.state_dir } : {}),
    ...(runtime.logs_dir !== undefined ? { logs_dir: runtime.logs_dir } : {}),
    ...(runtime.env_file !== undefined ? { env_file: runtime.env_file } : {}),
    ...(runtime.shell_env !== undefined ? { shell_env: runtime.shell_env } : {}),
    ...(tunnel.enabled !== undefined ? { tunnel_enabled: tunnel.enabled } : {}),
    ...(tunnel.health_port !== undefined ? { tunnel_health_port: tunnel.health_port } : {}),
    ...(tunnel.ready_timeout_ms !== undefined ? { ready_timeout_ms: tunnel.ready_timeout_ms } : {}),
    ...(tunnel.health_interval_ms !== undefined ? { health_interval_ms: tunnel.health_interval_ms } : {}),
    ...(tunnel.binary !== undefined ? { tunnel_bin: tunnel.binary } : {}),
    ...(logging.max_bytes !== undefined ? { log_max_bytes: logging.max_bytes } : {}),
    ...(logging.files !== undefined ? { log_files: logging.files } : {})
  };
}
