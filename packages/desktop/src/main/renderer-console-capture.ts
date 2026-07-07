/**
 * Capture renderer/browser `console` output from an Electron webContents into
 * the desktop pino log via `getLogger('renderer')` — i.e.
 * `~/.ok/logs/desktop.<date>.log`, which `ok bug-report` bundles. The renderer
 * runs with `contextIsolation`+`sandbox` and cannot call pino directly, so the
 * main process listens to the `console-message` event. This captures the
 * structured `ok-provider-*` events the renderer already emits (including the
 * collab "Failed to connect" events) with zero renderer changes.
 *
 * The web/browser build (no Electron main process) uses the `/api/client-logs`
 * HTTP ingest path instead — see
 * `packages/app/src/lib/install-client-log-forwarder.ts`.
 */

import {
  mapConsoleLevel,
  parseStructuredConsoleMessage,
  truncateLogMessage,
} from '@inkeep/open-knowledge-core';
import { getLogger } from './desktop-logger.ts';

/**
 * Modern Electron `console-message` event shape (Electron ≥ 37): the data
 * lives on the event object; the legacy positional `(level, message, line,
 * sourceId)` args are deprecated. `level` is a string union — note `'warning'`
 * (not `'warn'`); `mapConsoleLevel` normalizes it.
 */
interface ConsoleMessageEvent {
  readonly message: string;
  readonly level: string;
  readonly lineNumber?: number;
  readonly sourceId?: string;
}

/**
 * Narrow webContents subset — just the `console-message` subscription. Lets
 * tests inject a fake without pulling the full `electron` module into test-land
 * (mirrors `WebContentsLike` in `asset-safety-net.ts`). A real Electron
 * `WebContents` is structurally assignable.
 */
export interface ConsoleCapturingWebContents {
  on(event: 'console-message', listener: (event: ConsoleMessageEvent) => void): unknown;
}

interface RendererConsoleLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}

interface AttachRendererConsoleCaptureDeps {
  /** Override the logger factory (tests). Defaults to the desktop `getLogger`. */
  readonly getLogger?: (subsystem: string) => RendererConsoleLogger;
}

/**
 * Subscribe to a webContents' console stream and route each message to the
 * `renderer` pino subsystem. info/warn/error are captured; debug/verbose are
 * dropped (volume). Structured `JSON.stringify({event,...})` messages are
 * lifted into pino object fields (greppable + redactable); plain strings log
 * as the message body. A logging failure never propagates back into the
 * listener.
 */
export function attachRendererConsoleCapture(
  webContents: ConsoleCapturingWebContents,
  deps: AttachRendererConsoleCaptureDeps = {},
): void {
  const resolveLogger = deps.getLogger ?? getLogger;

  webContents.on('console-message', (event) => {
    try {
      const level = mapConsoleLevel(event.level);
      if (!level) return;
      const message = truncateLogMessage(event.message ?? '');
      const structured = parseStructuredConsoleMessage(message);
      // Spread the renderer-supplied fields FIRST so our provenance markers
      // below always win — a renderer JSON payload must not be able to clobber
      // `source`/`transport`/`sourceId`/`lineNumber`.
      const data: Record<string, unknown> = {
        ...structured?.fields,
        source: 'renderer-console',
        transport: 'electron',
        ...(event.sourceId ? { sourceId: event.sourceId } : {}),
        ...(event.lineNumber !== undefined ? { lineNumber: event.lineNumber } : {}),
      };
      resolveLogger('renderer')[level](data, structured?.event ?? message);
    } catch {
      // A logging failure must never crash the console-message listener.
    }
  });
}
