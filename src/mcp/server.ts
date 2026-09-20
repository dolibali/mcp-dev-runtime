import { NAME, VERSION, CONTRACT_VERSION } from '../version.js';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { Runtime } from '../runtime/runtime.js';

type ToolDefinition = { name: string; description: string; inputSchema: JsonSchemaType; outputSchema: JsonSchemaType;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } };
export const tools: ToolDefinition[] = JSON.parse(readFileSync(new URL('../../contracts/tools.json', import.meta.url), 'utf8')).tools;
// Compile once; per-request SDK instances share schemas and the business runtime.
const schemas = new Map(tools.map(tool => [tool.name, fromJsonSchema<Record<string, unknown>>(tool.inputSchema)]));
const outputSchemas = new Map(tools.map(tool => [tool.name, fromJsonSchema<Record<string, unknown>>(tool.outputSchema)]));
export function makeServer(runtime: Runtime): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION }, {
    instructions: [
      'Execute development operations on this host directly. No Codex agent or model is invoked.',
      'Do not delegate development to Codex, another agent, or a model API; use these local tools directly.',
      `OS: ${os.platform()} ${os.arch()}. Default cwd: ${runtime.config.cwd}. Shell: ${runtime.config.shell}. Contract: ${CONTRACT_VERSION}.`,
      'Use exec_command for reading, search (rg), Git, builds and tests; apply_patch for source edits and view_image for existing images.',
      'Read command output from structuredContent.output (the tool result output field); text content also carries the same bounded chunk.',
      'Specify workdir for each independent command; cd/export do not persist across exec_command calls.',
      'Poll running commands using write_stdin with empty chars; do not restart commands to fetch logs.',
      'After a lost response, recover the handle with list_exec_sessions and read retained output using output_cursor=0. Check output_gap.',
      'Memory records do not expire by time by default; count/byte quotas still apply. Query scope=history after cache eviction or restart.',
      'Use a descriptive label for tasks. Disk history saves metadata only by default; use capture_output=true for tasks whose raw logs need later inspection, not for secrets.',
      'Use write_stdin tail_lines/search for bounded read-only inspection. Search returns matches/search_next_cursor; it does not move the normal output cursor.',
      'To read disk logs pass archive_id and session_id from a history listing. Archived unknown means an unconfirmed outcome, not a resumable process.',
      'Use tty=true for interactive input. Read applicable AGENTS.md and project instructions before editing.',
      'Report actual exit codes and unperformed checks. Calls execute as the service OS user without a sandbox.'
    ].join('\n')
  });
  for (const tool of tools) server.registerTool(tool.name, {
    description: tool.description, inputSchema: schemas.get(tool.name)!, outputSchema: outputSchemas.get(tool.name)!, annotations: tool.annotations
  }, async args => runtime.invoke(tool.name, args));
  return server;
}
