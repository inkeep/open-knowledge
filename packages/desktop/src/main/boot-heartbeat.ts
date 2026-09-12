import {
  BOOT_HEARTBEAT_ABANDONED_SUFFIX,
  type BootHeartbeatEvent,
  SPAWN_WAIT_HEARTBEAT_MS,
} from '../shared/boot-narration.ts';

export interface BootHeartbeatDeps {
  log?: { info(obj: Record<string, unknown>, msg: string): void } | undefined;
  flushLog?: (() => void) | undefined;
  setInterval?: ((cb: () => void, ms: number) => unknown) | undefined;
  clearInterval?: ((handle: unknown) => void) | undefined;
}

export interface BootHeartbeatOptions {
  maxBeats?: number;
}

export function startBootHeartbeat(
  deps: BootHeartbeatDeps,
  event: BootHeartbeatEvent,
  message: string,
  fields: () => Record<string, unknown>,
  options: BootHeartbeatOptions = {},
): () => void {
  const startedAt = Date.now();
  const maxBeats = options.maxBeats;
  let beats = 0;
  let handle: unknown;
  const stop = () => {
    if (handle === undefined) return;
    deps.clearInterval?.(handle);
    handle = undefined;
  };
  handle = deps.setInterval?.(() => {
    beats += 1;
    const elapsedMs = Date.now() - startedAt;
    if (maxBeats !== undefined && beats > maxBeats) {
      stop();
      deps.log?.info(
        {
          event: `${event}${BOOT_HEARTBEAT_ABANDONED_SUFFIX}`,
          elapsedMs,
          beats: beats - 1,
          ...fields(),
        },
        `${message} — giving up on narration after ${elapsedMs}ms`,
      );
      deps.flushLog?.();
      return;
    }
    deps.log?.info({ event, elapsedMs, ...fields() }, message);
    deps.flushLog?.();
  }, SPAWN_WAIT_HEARTBEAT_MS);
  return stop;
}
