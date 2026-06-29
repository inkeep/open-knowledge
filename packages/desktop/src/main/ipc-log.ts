interface IpcErrorLogPayload {
  readonly event: 'ipc.error';
  readonly channel: string;
  readonly reason: string;
  readonly handler: string;
  readonly cause?: unknown;
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

export function logIpcError(payload: IpcErrorLogPayload): void {
  const normalized: IpcErrorLogPayload =
    payload.cause !== undefined ? { ...payload, cause: normalizeCause(payload.cause) } : payload;

  try {
    const { getLogger } = require('./desktop-logger.ts');
    getLogger('ipc').warn(
      { channel: payload.channel, handler: payload.handler, reason: payload.reason },
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
