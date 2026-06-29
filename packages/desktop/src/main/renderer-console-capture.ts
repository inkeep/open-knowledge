
import {
  mapConsoleLevel,
  parseStructuredConsoleMessage,
  truncateLogMessage,
} from '@inkeep/open-knowledge-core';
import { getLogger } from './desktop-logger.ts';

interface ConsoleMessageEvent {
  readonly message: string;
  readonly level: string;
  readonly lineNumber?: number;
  readonly sourceId?: string;
}

export interface ConsoleCapturingWebContents {
  on(event: 'console-message', listener: (event: ConsoleMessageEvent) => void): unknown;
}

interface RendererConsoleLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}

interface AttachRendererConsoleCaptureDeps {
  readonly getLogger?: (subsystem: string) => RendererConsoleLogger;
}

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
      const data: Record<string, unknown> = {
        ...structured?.fields,
        source: 'renderer-console',
        transport: 'electron',
        ...(event.sourceId ? { sourceId: event.sourceId } : {}),
        ...(event.lineNumber !== undefined ? { lineNumber: event.lineNumber } : {}),
      };
      resolveLogger('renderer')[level](data, structured?.event ?? message);
    } catch {
    }
  });
}
