/**
 * Pure aggregator for the desktop launch waterfall.
 *
 * Collects per-phase epoch-ms marks from the Electron main process, folds in
 * the server's boot timings (from `/api/server-info`) and the renderer's two
 * checkpoints (page-list ready, first content), and emits ONE structured log
 * line — `desktop.startup-timeline` — carrying phase DURATIONS (integer-ms
 * deltas), not raw timestamps. No Electron imports so it is unit-testable.
 *
 * Cardinality discipline: every emitted field is a bounded number or boolean —
 * durations, a file count, and an `otelEnabled` flag. No paths, doc content, or
 * free-form strings ever reach the log payload (mirrors the OTel span/metric
 * STOP rule; the timeline log shares the same consumers/dashboards).
 *
 * The emit is idempotent and best-effort: it fires once, when the window has
 * been shown AND (best-effort) the server boot + renderer marks have been
 * ingested, or on a short deadline after window-shown so a missing server
 * fetch / renderer report never withholds the whole line.
 */

/** Main-process launch phases, in order. Each is stamped once via {@link mark}. */
export type WaterfallPhase =
  | 'appReady'
  | 'bootstrapDone'
  | 'serverSpawned'
  | 'serverLockReady'
  | 'windowCreated'
  | 'loadUrlResolved'
  | 'windowShown';

/** Server boot timings as carried on the `/api/server-info` `boot` object. */
export interface ServerBootTimings {
  startedAt: string;
  httpListenMs?: number;
  seedWalkMs?: number;
  indexesMs?: number;
  readyMs?: number;
  fileCount?: number;
}

/** Renderer launch checkpoints (epoch ms), as reported over the bridge. */
export interface RendererMarks {
  pageListReadyMs: number;
  firstContentMs: number;
}

/** Minimal logger shape — matches the desktop pino `getLogger(name)` surface. */
export interface WaterfallLogger {
  info(payload: Record<string, unknown>, message: string): void;
}

/** The bounded payload shape emitted on `desktop.startup-timeline`. */
export interface WaterfallPayload {
  // Main-process phase deltas.
  appReadyToBootstrapMs?: number;
  bootstrapToSpawnMs?: number;
  spawnToLockReadyMs?: number;
  lockReadyToWindowMs?: number;
  windowToLoadUrlMs?: number;
  loadUrlToShownMs?: number;
  // Server boot phases (passed through from /api/server-info).
  serverHttpListenMs?: number;
  serverSeedWalkMs?: number;
  serverIndexesMs?: number;
  serverReadyMs?: number;
  serverFileCount?: number;
  // Renderer checkpoints, relative to app-ready (the launch origin in main).
  rendererPageListMs?: number;
  rendererFirstContentMs?: number;
  // Totals + cross-process signals.
  totalLaunchToShownMs?: number;
  totalLaunchToFirstContentMs?: number;
  /**
   * Spawn → server-start latency (ms): server boot-start wall-clock minus when
   * main observed the spawn. Normally a small positive number; a negative or
   * wildly large value signals cross-process clock disagreement, not latency.
   */
  spawnToServerStartMs?: number;
  otelEnabled: boolean;
}

export interface StartupWaterfallOptions {
  /** Whether main initialized the OTel SDK for this launch (Plan A succeeded). */
  otelEnabled: boolean;
  /**
   * How long after `windowShown` to wait for the server-boot + renderer marks
   * before emitting anyway. Keeps a missing fetch / report from withholding the
   * line. The aggregator does NOT own a timer; the caller arms one and calls
   * {@link emit} on expiry — `flushDeadlineMs` is advisory metadata for it.
   */
  flushDeadlineMs?: number;
}

function round(n: number): number {
  return Math.round(n);
}

/**
 * Integer delta `b - a`, or undefined if either bound is missing. Only fed the
 * same-process main-phase marks (`Date.now()` in main), so the result is
 * non-negative in practice barring a backward wall-clock step mid-launch.
 */
function delta(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  return round(b - a);
}

/**
 * Main-process launch phases as consecutive (start, end) mark pairs. Replayed
 * as child spans under the `ok.app-startup` root so the trace shows the
 * main-side portion of the launch, not just the server `ok.boot` child. Span
 * names are bounded literals; see {@link StartupWaterfall.mainPhaseIntervals}.
 */
const PHASE_SPANS: ReadonlyArray<{ name: string; from: WaterfallPhase; to: WaterfallPhase }> = [
  { name: 'ok.startup.bootstrap', from: 'appReady', to: 'bootstrapDone' },
  { name: 'ok.startup.spawn', from: 'bootstrapDone', to: 'serverSpawned' },
  { name: 'ok.startup.lock-wait', from: 'serverSpawned', to: 'serverLockReady' },
  { name: 'ok.startup.window-create', from: 'serverLockReady', to: 'windowCreated' },
  { name: 'ok.startup.load-url', from: 'windowCreated', to: 'loadUrlResolved' },
  { name: 'ok.startup.show', from: 'loadUrlResolved', to: 'windowShown' },
];

export class StartupWaterfall {
  private readonly marks = new Map<WaterfallPhase, number>();
  private serverBoot: ServerBootTimings | undefined;
  private rendererMarks: RendererMarks | undefined;
  private emitted = false;
  /**
   * Whether main initialized the OTel SDK for this launch (Plan A). Mutable
   * because the waterfall is constructed at module load but `beginRoot()` only
   * resolves the answer at `app.whenReady()`; main writes it once there.
   */
  otelEnabled: boolean;
  readonly flushDeadlineMs: number;

  constructor(opts: StartupWaterfallOptions) {
    this.otelEnabled = opts.otelEnabled;
    this.flushDeadlineMs = opts.flushDeadlineMs ?? 1500;
  }

  /** Stamp a main-process phase with `Date.now()`. First write per phase wins. */
  mark(phase: WaterfallPhase, atMs: number = Date.now()): void {
    if (!this.marks.has(phase)) this.marks.set(phase, atMs);
  }

  /** Fold in the server's boot timings (from `/api/server-info`). Idempotent-ish: last wins. */
  ingestServerBoot(boot: ServerBootTimings | undefined): void {
    if (boot) this.serverBoot = boot;
  }

  /** Fold in the renderer's two launch checkpoints. */
  ingestRendererMarks(marks: RendererMarks): void {
    this.rendererMarks = marks;
  }

  /** True once both best-effort inputs (server boot + renderer marks) are present. */
  private hasBestEffortInputs(): boolean {
    return this.serverBoot !== undefined && this.rendererMarks !== undefined;
  }

  /** Whether {@link emit} would fire now (window shown; not yet emitted). */
  get canEmit(): boolean {
    return !this.emitted && this.marks.has('windowShown');
  }

  /**
   * Whether the line is ready to emit on the happy path — window shown AND both
   * best-effort inputs present. The deadline path emits regardless once shown.
   */
  get readyToEmit(): boolean {
    return this.canEmit && this.hasBestEffortInputs();
  }

  /** Build the bounded payload from whatever has been collected so far. */
  buildPayload(): WaterfallPayload {
    const appReady = this.marks.get('appReady');
    const bootstrapDone = this.marks.get('bootstrapDone');
    const serverSpawned = this.marks.get('serverSpawned');
    const serverLockReady = this.marks.get('serverLockReady');
    const windowCreated = this.marks.get('windowCreated');
    const loadUrlResolved = this.marks.get('loadUrlResolved');
    const windowShown = this.marks.get('windowShown');

    const payload: WaterfallPayload = {
      appReadyToBootstrapMs: delta(appReady, bootstrapDone),
      bootstrapToSpawnMs: delta(bootstrapDone, serverSpawned),
      spawnToLockReadyMs: delta(serverSpawned, serverLockReady),
      lockReadyToWindowMs: delta(serverLockReady, windowCreated),
      windowToLoadUrlMs: delta(windowCreated, loadUrlResolved),
      loadUrlToShownMs: delta(loadUrlResolved, windowShown),
      totalLaunchToShownMs: delta(appReady, windowShown),
      otelEnabled: this.otelEnabled,
    };

    if (this.serverBoot) {
      payload.serverHttpListenMs = this.serverBoot.httpListenMs;
      payload.serverSeedWalkMs = this.serverBoot.seedWalkMs;
      payload.serverIndexesMs = this.serverBoot.indexesMs;
      payload.serverReadyMs = this.serverBoot.readyMs;
      payload.serverFileCount = this.serverBoot.fileCount;
      // Spawn → server-start latency: the server's self-reported boot-start
      // (`startedAt`) minus when main observed the spawn. Both are same-machine
      // wall-clock, so a normal launch yields a small POSITIVE value (the gap
      // is spawn + process init, not clock error). It doubles as the only
      // cross-process clock signal: a negative or wildly large value ⇒ the two
      // process clocks disagree (e.g. a wrong VM clock), not a real latency.
      const serverStartedAtMs = Date.parse(this.serverBoot.startedAt);
      if (!Number.isNaN(serverStartedAtMs) && serverSpawned !== undefined) {
        payload.spawnToServerStartMs = round(serverStartedAtMs - serverSpawned);
      }
    }

    if (this.rendererMarks && appReady !== undefined) {
      payload.rendererPageListMs = round(this.rendererMarks.pageListReadyMs - appReady);
      payload.rendererFirstContentMs = round(this.rendererMarks.firstContentMs - appReady);
      payload.totalLaunchToFirstContentMs = round(this.rendererMarks.firstContentMs - appReady);
    }

    return payload;
  }

  /**
   * Main-process phase intervals (epoch-ms start/end) to replay as child spans
   * under the launch root. Only intervals whose BOTH marks are present and
   * non-decreasing are returned, so a missing or out-of-order mark drops just
   * that one span rather than emitting a zero/negative-duration span.
   */
  mainPhaseIntervals(): Array<{ name: string; startMs: number; endMs: number }> {
    const out: Array<{ name: string; startMs: number; endMs: number }> = [];
    for (const { name, from, to } of PHASE_SPANS) {
      const startMs = this.marks.get(from);
      const endMs = this.marks.get(to);
      if (startMs !== undefined && endMs !== undefined && endMs >= startMs) {
        out.push({ name, startMs, endMs });
      }
    }
    return out;
  }

  /**
   * Emit the single `desktop.startup-timeline` log line. Idempotent — only the
   * first call logs and returns the payload it logged; every subsequent call is
   * a no-op returning undefined. Also returns undefined (without emitting) when
   * the window has not been shown yet.
   */
  emit(logger: WaterfallLogger): WaterfallPayload | undefined {
    if (this.emitted) return undefined;
    if (!this.marks.has('windowShown')) return undefined;
    this.emitted = true;
    const payload = this.buildPayload();
    // `WaterfallPayload` is a closed shape of optional numbers + a boolean, so
    // it satisfies the logger's `Record<string, unknown>` structurally; the
    // cast just bridges the missing index signature.
    logger.info(payload as unknown as Record<string, unknown>, 'desktop.startup-timeline');
    return payload;
  }
}
