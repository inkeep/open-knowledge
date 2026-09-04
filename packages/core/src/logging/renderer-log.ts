import { scrubSecrets } from './secret-scrub.ts';

export type RendererLogLevel = 'info' | 'warn' | 'error';

export const RENDERER_LOG_MAX_ENTRIES = 100;

export const RENDERER_LOG_MAX_MESSAGE_BYTES = 8192;

export const RENDERER_LOG_MAX_BATCH_BYTES = 32_768;

const TRUNCATION_SUFFIX = '…[truncated]';

export function mapConsoleLevel(level: string): RendererLogLevel | null {
  switch (level) {
    case 'error':
      return 'error';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'info':
    case 'log':
      return 'info';
    default:
      return null;
  }
}

export const LOGGER_OWNED_FIELDS = [
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'name',
  'runtime',
  'subsystem',
  'trace_id',
  'span_id',
  'trace_flags',
] as const;

export function parseStructuredConsoleMessage(
  message: string,
): { event: string | undefined; fields: Record<string, unknown> } | null {
  const trimmed = scrubSecrets(message).trim();
  if (trimmed.length === 0 || trimmed[0] !== '{') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  for (const key of LOGGER_OWNED_FIELDS) delete fields[key];
  return { event: typeof fields.event === 'string' ? fields.event : undefined, fields };
}

export function truncateLogMessage(message: string): string {
  if (message.length <= RENDERER_LOG_MAX_MESSAGE_BYTES) return message;
  return `${message.slice(0, RENDERER_LOG_MAX_MESSAGE_BYTES - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

export function prepareCapturedConsoleMessage(message: string): string {
  return truncateLogMessage(scrubSecrets(message));
}
