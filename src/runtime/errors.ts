export class ToolError extends Error {
  constructor(public readonly code: string, message: string,
    public readonly details: Record<string, unknown> = {}) {
    super(message); this.name = 'ToolError';
  }
}
export function errorInfo(error: unknown): Record<string, unknown> {
  return error instanceof ToolError
    ? { code: error.code, message: error.message, ...error.details }
    : { code: 'OPERATION_FAILED', message: error instanceof Error ? error.message : String(error) };
}
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let unlock!: () => void;
    const next = new Promise<void>(resolve => { unlock = resolve; });
    const previous = this.tail; this.tail = next;
    await previous;
    try { return await fn(); } finally { unlock(); }
  }
}
