export type WaterfallPhase =
  | 'appReady'
  | 'bootstrapDone'
  | 'serverSpawned'
  | 'serverLockReady'
  | 'windowCreated'
  | 'loadUrlResolved'
  | 'windowShown';

export interface ServerBootTimings {
  startedAt: string;
  httpListenMs?: number;
  seedWalkMs?: number;
  indexesMs?: number;
  readyMs?: number;
  fileCount?: number;
}

export interface RendererMarks {
  pageListReadyMs: number;
  firstContentMs: number;
}

export interface WaterfallLogger {
  info(payload: Record<string, unknown>, message: string): void;
}

export interface WaterfallPayload {
  appReadyToBootstrapMs?: number;
  bootstrapToSpawnMs?: number;
  spawnToLockReadyMs?: number;
  lockReadyToWindowMs?: number;
  windowToLoadUrlMs?: number;
  loadUrlToShownMs?: number;
  serverHttpListenMs?: number;
  serverSeedWalkMs?: number;
  serverIndexesMs?: number;
  serverReadyMs?: number;
  serverFileCount?: number;
  rendererPageListMs?: number;
  rendererFirstContentMs?: number;
  totalLaunchToShownMs?: number;
  totalLaunchToFirstContentMs?: number;
  spawnToServerStartMs?: number;
  otelEnabled: boolean;
}

export interface StartupWaterfallOptions {
  otelEnabled: boolean;
  flushDeadlineMs?: number;
}

function round(n: number): number {
  return Math.round(n);
}

function delta(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  return round(b - a);
}

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
  otelEnabled: boolean;
  readonly flushDeadlineMs: number;

  constructor(opts: StartupWaterfallOptions) {
    this.otelEnabled = opts.otelEnabled;
    this.flushDeadlineMs = opts.flushDeadlineMs ?? 1500;
  }

  mark(phase: WaterfallPhase, atMs: number = Date.now()): void {
    if (!this.marks.has(phase)) this.marks.set(phase, atMs);
  }

  ingestServerBoot(boot: ServerBootTimings | undefined): void {
    if (boot) this.serverBoot = boot;
  }

  ingestRendererMarks(marks: RendererMarks): void {
    this.rendererMarks = marks;
  }

  private hasBestEffortInputs(): boolean {
    return this.serverBoot !== undefined && this.rendererMarks !== undefined;
  }

  get canEmit(): boolean {
    return !this.emitted && this.marks.has('windowShown');
  }

  get readyToEmit(): boolean {
    return this.canEmit && this.hasBestEffortInputs();
  }

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

  emit(logger: WaterfallLogger): WaterfallPayload | undefined {
    if (this.emitted) return undefined;
    if (!this.marks.has('windowShown')) return undefined;
    this.emitted = true;
    const payload = this.buildPayload();
    logger.info(payload as unknown as Record<string, unknown>, 'desktop.startup-timeline');
    return payload;
  }
}
