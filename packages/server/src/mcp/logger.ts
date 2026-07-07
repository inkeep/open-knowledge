/**
 * Structured MCP logger — JSON lines on stderr for Claude Desktop logs.
 *
 * Every log entry carries:
 *   sessionId  — stable for one MCP stdio process lifetime
 *   corrId     — rotated per logical operation (tool call, startup phase)
 *   component  — 'mcp' by default; callers can narrow
 *
 * stderr:      always JSON lines (for Claude Desktop / MCP clients)
 * OK_LOG_FILE: same single-line JSON format, appended one entry per line.
 *
 * Debug-level output is gated behind MCP_DEBUG=1 or DEBUG containing 'mcp'.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

interface McpLogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  sessionId: string;
  corrId: string;
  component: string;
  msg: string;
  [key: string]: unknown;
}

const loggerContext = new AsyncLocalStorage<McpLogger>();

export class McpLogger {
  readonly sessionId: string;
  private corrId: string;
  private readonly component: string;

  constructor(component = 'mcp', sessionId?: string) {
    this.sessionId = sessionId ?? randomUUID().slice(0, 12);
    this.corrId = randomUUID().slice(0, 8);
    this.component = component;
  }

  // ── public API ───────────────────────────────────────────────────────
  // Intentional divergence from the server package's Pino wrapper:
  // this logger owns the final JSON envelope, so MCP call sites stay
  // message-first and pass optional structured context separately.

  info(msg: string, ctx: Record<string, unknown> = {}): void {
    this.emit('info', msg, ctx);
  }

  warn(msg: string, ctx: Record<string, unknown> = {}): void {
    this.emit('warn', msg, ctx);
  }

  error(msg: string, err?: unknown, ctx: Record<string, unknown> = {}): void {
    const errCtx = err ? { error: err instanceof Error ? err.message : String(err), ...ctx } : ctx;
    this.emit('error', msg, errCtx);
  }

  debug(msg: string, ctx: Record<string, unknown> = {}): void {
    if (process.env.MCP_DEBUG === '1' || process.env.DEBUG?.includes('mcp')) {
      this.emit('debug', msg, ctx);
    }
  }

  /**
   * Return a child logger that shares sessionId but has a fresh corrId.
   * Use at the start of each tool call or startup phase.
   */
  child(component?: string): McpLogger {
    const c = new McpLogger(component ?? this.component, this.sessionId);
    return c;
  }

  /** Adapter for call sites that still pass `(msg: string) => void`. */
  asCallback(): (msg: string) => void {
    return (msg: string) => this.info(msg);
  }

  // ── internals ────────────────────────────────────────────────────────

  private emit(
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    ctx: Record<string, unknown>,
  ): void {
    const entry: McpLogEntry = {
      ts: new Date().toISOString(),
      level,
      sessionId: this.sessionId,
      corrId: this.corrId,
      component: this.component,
      msg,
      ...ctx,
    };
    const line = `${JSON.stringify(entry)}\n`;
    process.stderr.write(line);
    const logFile = process.env.OK_LOG_FILE;
    if (logFile) {
      try {
        appendFileSync(logFile, line);
      } catch (err) {
        console.warn(
          `[mcp-logger] Failed to write to OK_LOG_FILE: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}

/** Run an async/sync block with the provided logger bound as the active MCP logger. */
export function runWithMcpLogger<T>(logger: McpLogger, fn: () => T): T {
  return loggerContext.run(logger, fn);
}

/** Return the active per-call logger when one is bound, otherwise `undefined`. */
export function getCurrentMcpLogger(): McpLogger | undefined {
  return loggerContext.getStore();
}
