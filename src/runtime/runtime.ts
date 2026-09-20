import type { Config } from '../config.js';
import { ExecManager, type ExecArgs, type InputArgs, type ExecState } from './exec-manager.js';
import { RetryCache } from './retry-cache.js';
import { PatchEngine } from './patch-engine.js';
import { ImageReader } from './image-reader.js';
import { errorInfo, ToolError } from './errors.js';
import { expandPath } from '../config.js';
import type { HistoryFilter } from './history-store.js';

export class Runtime {
  readonly exec: ExecManager;
  readonly patch: PatchEngine;
  readonly images: ImageReader;
  constructor(readonly config: Config) {
    const retry = new RetryCache(config.request_cache_ttl_ms, config.request_cache_entries);
    this.exec = new ExecManager(config, retry); this.patch = new PatchEngine(config, retry); this.images = new ImageReader(config);
  }
  async invoke(name: string, args: Record<string, unknown>) {
    const start = performance.now();
    try {
      if (name === 'view_image') {
        const image = await this.images.read(args as { path: string; workdir?: string });
        return { content: [{ type: 'text' as const, text: JSON.stringify(image.metadata) }, image.image], structuredContent: image.metadata, isError: false };
      }
      let result: Record<string, unknown>;
      switch (name) {
        case 'exec_command': result = await this.exec.exec(args as ExecArgs); break;
        case 'write_stdin': result = await this.exec.write(args as InputArgs); break;
        case 'apply_patch': result = await this.patch.apply(args as { patch: string; workdir?: string; request_id?: string }); break;
        case 'list_exec_sessions': {
          const filters=args as HistoryFilter;
          result = args.scope==='history'
            ? await this.exec.history.list({...filters,workdir:filters.workdir?expandPath(filters.workdir,this.config.cwd):undefined})
            : this.exec.list(filters);
          break;
        }
        case 'terminate_exec_session': result = await this.exec.terminate(args as { session_id: number; force?: boolean; request_id?: string }); break;
        default: throw new ToolError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
      }
      const { output, ...metadata } = result;
      const text = JSON.stringify(metadata) + (typeof output === 'string' ? '\n' + output : '');
      // Some clients expose only structuredContent to tool callers. Keep the
      // bounded output chunk there as well as in the legacy text envelope.
      // Reuse the existing result; do not reread logs or advance the cursor.
      return { content: [{ type: 'text' as const, text }], structuredContent: result,
        isError: result.state === 'start_failed' || !!result.error };
    } catch (error) {
      const info = errorInfo(error);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: info }) }], structuredContent: { error: info }, isError: true };
    } finally {
      if (this.config.log_level === 'debug') process.stderr.write(JSON.stringify({ event: 'tool', tool: name, elapsed_ms: +(performance.now() - start).toFixed(2) }) + '\n');
    }
  }
  close() { return this.exec.close(); }
}
