import type { OkSlidesOpenResult, OkSlidesStatusResult } from '../../shared/ipc-channels.ts';
import type { SlidesDeckRegistry, SlidesDeckWindow } from '../slides-registry.ts';
import type { SlidesWindowOutcome } from '../slides-window.ts';
import { resolveSlidev, type SlidevResolveProbes } from '../slidev-resolve.ts';
import { type SlidevProcess, type StartSlidevDeps, startSlidevServer } from '../slidev-server.ts';

export async function handleSlidesStatus(
  projectRoot: string | undefined,
  probes: SlidevResolveProbes,
): Promise<OkSlidesStatusResult> {
  const resolution = await resolveSlidev(projectRoot, probes);
  return resolution.available
    ? { kind: 'status', available: true, source: resolution.source }
    : { kind: 'status', available: false };
}

export interface SlidesOpenDeps {
  registry: Pick<
    SlidesDeckRegistry,
    'get' | 'getOpenInFlight' | 'setOpenInFlight' | 'clearOpenInFlight' | 'trackSpawned'
  >;
  startDeps: StartSlidevDeps;
  openWindow(deck: {
    docPath: string;
    port: number;
    process: SlidevProcess;
  }): Promise<SlidesWindowOutcome>;
  focusWindow(window: SlidesDeckWindow): void;
  recordOpenAttempt(result: OkSlidesOpenResult): void;
}

export async function handleSlidesOpen(
  docPath: string,
  deps: SlidesOpenDeps,
): Promise<OkSlidesOpenResult> {
  const existing = deps.registry.get(docPath);
  if (existing !== undefined) {
    deps.focusWindow(existing.window);
    return { kind: 'open', ok: true };
  }
  const inFlight = deps.registry.getOpenInFlight(docPath);
  if (inFlight !== undefined) return inFlight;

  const attempt = (async (): Promise<OkSlidesOpenResult> => {
    const started = await startSlidevServer({
      ...deps.startDeps,
      onSpawned: (process) => deps.registry.trackSpawned(docPath, process),
    });
    if (!started.ok) {
      const result: OkSlidesOpenResult = { kind: 'open', ok: false, reason: started.reason };
      deps.recordOpenAttempt(result);
      return result;
    }
    let opened: SlidesWindowOutcome;
    try {
      opened = await deps.openWindow({
        docPath,
        port: started.port,
        process: started.process,
      });
    } catch (err) {
      void started.process.signal('SIGTERM');
      throw err;
    }
    const result: OkSlidesOpenResult = opened.shown
      ? { kind: 'open', ok: true }
      : { kind: 'open', ok: false, reason: opened.reason };
    if (!opened.shown && opened.reason === 'cancelled') return result;
    deps.recordOpenAttempt(result);
    return result;
  })();
  deps.registry.setOpenInFlight(docPath, attempt);
  try {
    return await attempt;
  } finally {
    deps.registry.clearOpenInFlight(docPath);
  }
}

export function shouldLogSlidesOpenError(
  result: OkSlidesOpenResult,
): result is Extract<OkSlidesOpenResult, { ok: false }> {
  return !result.ok && result.reason !== 'cancelled';
}
