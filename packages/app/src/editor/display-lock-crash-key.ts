import { OK_CHUNK_WRAPPER_CLASS } from './extensions/chunk-wrapper-decoration.ts';

export interface DisplayLockSnapshot {
  locked: boolean;
  inFrame: number;
  total: number;
  settled: boolean;
}

const COUNTER_CEILING = 99_999;

function saturate(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > COUNTER_CEILING ? COUNTER_CEILING : Math.floor(n);
}

export function encodeDisplayLockState(snapshot: DisplayLockSnapshot): string {
  const lock = snapshot.locked ? '1' : '0';
  const settled = snapshot.settled ? '1' : '0';
  return `v1 lock=${lock} f=${saturate(snapshot.inFrame)} n=${saturate(snapshot.total)} s=${settled}`;
}

interface ClassListBearing {
  classList: { contains(token: string): boolean };
}

function isChunkWrapper(target: EventTarget | null): boolean {
  const classList = (target as ClassListBearing | null)?.classList;
  if (typeof classList?.contains !== 'function') return false;
  return classList.contains(OK_CHUNK_WRAPPER_CLASS);
}

interface ListenerTarget {
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: { capture?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: { capture?: boolean },
  ): void;
}

function desktopSink(): ((state: string) => void) | undefined {
  if (typeof window === 'undefined') return undefined;
  const publish = window.okDesktop?.setDisplayLockCrashKey;
  if (typeof publish !== 'function') return undefined;
  return publish;
}

export interface DisplayLockReporterOptions {
  root: ListenerTarget;
  publish?: (state: string) => void;
  schedule?: (run: () => void) => void;
}

export function startDisplayLockCrashKeyReporter(options: DisplayLockReporterOptions): () => void {
  const publish = options.publish ?? desktopSink();
  if (publish === undefined) return () => {};
  const schedule = options.schedule ?? ((run: () => void) => requestAnimationFrame(run));

  let stopped = false;
  let frameScheduled = false;
  let inFrame = 0;
  let total = 0;
  let locked = false;
  let lastBurst = 0;
  let burstLive = false;

  const publishSafely = (state: string): void => {
    try {
      publish(state);
    } catch {}
  };

  const onFrame = (): void => {
    frameScheduled = false;
    if (stopped) return;

    if (inFrame === 0) {
      if (burstLive) {
        burstLive = false;
        publishSafely(encodeDisplayLockState({ locked, inFrame: lastBurst, total, settled: true }));
      }
      return;
    }

    const burst = inFrame;
    lastBurst = burst;
    inFrame = 0;
    burstLive = true;
    frameScheduled = true;
    schedule(onFrame);
    publishSafely(encodeDisplayLockState({ locked, inFrame: burst, total, settled: false }));
  };

  const onTransition = (event: Event): void => {
    if (!isChunkWrapper(event.target)) return;
    locked = (event as ContentVisibilityAutoStateChangeEvent).skipped;
    inFrame += 1;
    total += 1;
    if (frameScheduled) return;
    frameScheduled = true;
    schedule(onFrame);
  };

  options.root.addEventListener('contentvisibilityautostatechange', onTransition, {
    capture: true,
  });
  return () => {
    stopped = true;
    options.root.removeEventListener('contentvisibilityautostatechange', onTransition, {
      capture: true,
    });
  };
}
