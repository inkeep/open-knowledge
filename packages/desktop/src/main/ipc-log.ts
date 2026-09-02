import { getLogger } from './desktop-logger.ts';

interface IpcErrorLogPayload {
  readonly event: 'ipc.error';
  readonly channel: string;
  readonly reason: string;
  readonly handler: string;
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

function normalizeCause(cause: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (cause instanceof Error) {
    if (seen.has(cause)) {
      return {
        name: cause.name,
        message: cause.message,
        stack: cause.stack,
        cause: '<circular>',
      };
    }
    seen.add(cause);
    return {
      name: cause.name,
      message: cause.message,
      stack: cause.stack,
      ...(cause.cause !== undefined ? { cause: normalizeCause(cause.cause, seen) } : {}),
    };
  }
  return cause;
}

const CAUSE_CHAIN_MAX_DEPTH = 5;

function boundedCauseFacts(cause: unknown): Record<string, string> {
  const facts: Record<string, string> = {};
  if (cause instanceof Error) facts.errName = cause.name;

  const seen = new Set<unknown>();
  let cursor: unknown = cause;
  for (
    let depth = 0;
    depth < CAUSE_CHAIN_MAX_DEPTH && cursor !== null && cursor !== undefined;
    depth += 1
  ) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') {
      facts.errCode = code;
      break;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return facts;
}

export function logIpcError(payload: IpcErrorLogPayload): void {
  const normalized: IpcErrorLogPayload =
    payload.cause !== undefined ? { ...payload, cause: normalizeCause(payload.cause) } : payload;

  let causeFacts: Record<string, string> = {};
  if (payload.cause !== undefined) {
    try {
      causeFacts = boundedCauseFacts(payload.cause);
    } catch {}
  }

  try {
    getLogger('ipc').warn(
      {
        ...causeFacts,
        ...payload.details,
        channel: payload.channel,
        handler: payload.handler,
        reason: payload.reason,
      },
      `IPC error: ${payload.channel} — ${payload.reason}`,
    );
  } catch {}

  try {
    console.warn(JSON.stringify(normalized));
  } catch {
    const { cause: _omit, ...safe } = payload;
    console.warn(JSON.stringify({ ...safe, _causeSerializationFailed: true }));
  }
}

export async function withIpcErrorLogging<T>(
  payload: Omit<IpcErrorLogPayload, 'event' | 'cause'>,
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    logIpcError({ event: 'ipc.error', ...payload, cause });
    throw cause;
  }
}
