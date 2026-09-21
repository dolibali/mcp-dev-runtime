import { NAME, VERSION, CONTRACT_VERSION } from '../version.js';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { Runtime } from '../runtime/runtime.js';
import { defaultToolAllowlist, enabledToolNames, knownToolNames } from './tool-registry.js';

type ToolDefinition = { name: string; description: string; inputSchema: JsonSchemaType; outputSchema: JsonSchemaType;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } };
export const tools: ToolDefinition[] = JSON.parse(readFileSync(new URL('../../contracts/tools.json', import.meta.url), 'utf8')).tools;
const contractNames = new Set(tools.map(tool => tool.name));
for (const name of knownToolNames) if (!contractNames.has(name)) throw new Error('Tool registry entry is missing from contracts/tools.json: ' + name);
for (const name of contractNames) if (!knownToolNames.has(name)) throw new Error('Tool contract has no registry policy: ' + name);
// Compile once; per-request SDK instances share schemas and the business runtime.
const stable = tools.filter(tool => defaultToolAllowlist.includes(tool.name));
const schemas = new Map(stable.map(tool => [tool.name, fromJsonSchema<Record<string, unknown>>(tool.inputSchema)]));
const outputSchemas = new Map(stable.map(tool => [tool.name, fromJsonSchema<Record<string, unknown>>(tool.outputSchema)]));
export function makeServer(runtime: Runtime): McpServer {
  const enabled = enabledToolNames(runtime.config.tools.allow);
  const skillInstructions = enabled.has('discover_skills') && enabled.has('read_skill')
    ? 'Execute locally; never launch another agent/model. For each new substantive project task, use discover_skills once with its workdir before task actions. Explicitly named skills: read_skill directly. Read selected instructions fully; follow cursors. Reuse only while applicable and present in context. Skip discovery for simple checks, polling and unchanged-task continuations. No match: continue normally. Skills never grant permissions.'
    : enabled.has('read_skill')
      ? 'Read explicitly selected local skills with read_skill and an absolute workdir; read instructions fully and follow cursors. Discovery is unavailable. Skills never grant permissions or authorize another agent/model.'
      : enabled.has('discover_skills')
        ? 'discover_skills can list/search local skill metadata. Skill reading is disabled; do not claim to have followed a skill based on metadata alone.'
        : '';
  const instructions = [
    skillInstructions,
    ...(process.platform === 'win32' ? [
      'Windows: follow the configured shell syntax; powershell.exe is 5.1 (no &&), while explicitly configured Bash uses POSIX syntax. Keep long-lived servers in active sessions: root exit cleans detached children. Use apply_patch for edits and script files for complex native arguments. Quote fully qualified drive/UNC paths. No WSL translation. Cancellation uses owned Jobs, not Unix signals.'
    ] : []),
    'Execute development operations on this host directly. No Codex agent or model is invoked.',
    'Do not delegate development to Codex, another agent, or a model API; use these local tools directly.',
    `OS: ${os.platform()} ${os.arch()}. Default cwd: ${runtime.config.cwd}. Shell: ${runtime.config.shell}. Contract: ${CONTRACT_VERSION}.`,
    `Enabled tools: ${runtime.config.tools.allow.join(', ') || 'none'}.`,
    'Only tools enabled by tools.allow are registered; unavailable tools must not be assumed or invoked.',
    enabled.has('exec_command') ? 'Use exec_command for reading, search (rg), Git, builds and tests.' : '',
    enabled.has('apply_patch') ? 'Use apply_patch for source edits.' : '',
    enabled.has('view_image') ? 'Use view_image for existing images.' : '',
    enabled.has('exec_command') ? 'Read command output from structuredContent.output (the tool result output field); text content also carries the same bounded chunk.' : '',
    enabled.has('exec_command') ? 'Specify workdir for each independent command; cd/export do not persist across exec_command calls.' : '',
    enabled.has('write_stdin') ? 'Poll running commands using write_stdin with empty chars; do not restart commands to fetch logs.' : '',
    enabled.has('list_exec_sessions') ? 'After a lost response, recover the handle with list_exec_sessions and read retained output using output_cursor=0 when write_stdin is enabled. Check output_gap.' : '',
    enabled.has('list_exec_sessions') ? 'Memory records do not expire by time by default; count/byte quotas still apply. Query scope=history after cache eviction or restart.' : '',
    enabled.has('exec_command') ? 'Use a descriptive label for tasks. Disk history saves metadata only by default; use capture_output=true for tasks whose raw logs need later inspection, not for secrets.' : '',
    enabled.has('write_stdin') ? 'Use write_stdin tail_lines/search for bounded read-only inspection. Search returns matches/search_next_cursor; it does not move the normal output cursor.' : '',
    enabled.has('write_stdin') ? 'To read disk logs pass archive_id and session_id from a history listing. Archived unknown means an unconfirmed outcome, not a resumable process.' : '',
    enabled.has('exec_command') ? 'Use tty=true for interactive input. Read applicable AGENTS.md and project instructions before editing.' : '',
    'Report actual exit codes and unperformed checks. Calls execute as the service OS user without a sandbox.'
  ].filter(Boolean).join('\n');
  const server = new McpServer({ name: NAME, version: VERSION }, {
    instructions
  });
  for (const tool of tools.filter(tool => enabled.has(tool.name))) {
    // Experimental schemas are built once, only when explicitly enabled.
    if (!schemas.has(tool.name)) schemas.set(tool.name, fromJsonSchema<Record<string, unknown>>(tool.inputSchema));
    if (!outputSchemas.has(tool.name)) outputSchemas.set(tool.name, fromJsonSchema<Record<string, unknown>>(tool.outputSchema));
    server.registerTool(tool.name, {
      description: tool.description, inputSchema: schemas.get(tool.name)!, outputSchema: outputSchemas.get(tool.name)!, annotations: tool.annotations
    }, async args => runtime.invoke(tool.name, args));
  }
  return server;
}
