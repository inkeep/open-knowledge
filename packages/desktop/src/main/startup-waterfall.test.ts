import { describe, expect, test } from 'vitest';
import {
  type RendererMarks,
  type ServerBootTimings,
  StartupWaterfall,
  type WaterfallLogger,
  type WaterfallPayload,
} from './startup-waterfall.ts';

interface CaptureLogger extends WaterfallLogger {
  calls: Array<[Record<string, unknown>, string]>;
}

function captureLogger(): CaptureLogger {
  const calls: Array<[Record<string, unknown>, string]> = [];
  return {
    calls,
    info(obj, msg) {
      calls.push([obj, msg]);
    },
  };
}

const SERVER_BOOT: ServerBootTimings = {
  startedAt: '2026-06-30T00:00:00.000Z',
  httpListenMs: 5,
  seedWalkMs: 40,
  indexesMs: 60,
  readyMs: 120,
  fileCount: 17,
};

const RENDERER_MARKS: RendererMarks = {
  pageListReadyMs: 1000,
  firstContentMs: 1200,
};

describe('StartupWaterfall', () => {
  test('computes phase deltas from sequential marks', () => {
    const w = new StartupWaterfall({ otelEnabled: true });
    w.mark('appReady', 100);
    w.mark('bootstrapDone', 150);
    w.mark('serverSpawned', 200);
    w.mark('serverLockReady', 400);
    w.mark('windowCreated', 420);
    w.mark('loadUrlResolved', 480);
    w.mark('windowShown', 520);

    const p = w.buildPayload();
    expect(p.appReadyToBootstrapMs).toBe(50);
    expect(p.bootstrapToSpawnMs).toBe(50);
    expect(p.spawnToLockReadyMs).toBe(200);
    expect(p.lockReadyToWindowMs).toBe(20);
    expect(p.windowToLoadUrlMs).toBe(60);
    expect(p.loadUrlToShownMs).toBe(40);
    expect(p.totalLaunchToShownMs).toBe(420);
    expect(p.otelEnabled).toBe(true);
  });

  test('first-write-wins per phase (later marks do not overwrite)', () => {
    const w = new StartupWaterfall({ otelEnabled: false });
    w.mark('appReady', 100);
    w.mark('appReady', 999);
    w.mark('windowShown', 200);
    expect(w.buildPayload().totalLaunchToShownMs).toBe(100);
  });

  test('missing-bound deltas are omitted, not zero', () => {
    const w = new StartupWaterfall({ otelEnabled: false });
    w.mark('appReady', 100);
    w.mark('windowShown', 300);
    const p = w.buildPayload();
    expect(p.appReadyToBootstrapMs).toBeUndefined();
    expect(p.totalLaunchToShownMs).toBe(200);
  });

  test('passes through server boot timings + spawn→server-start vs serverSpawned', () => {
    const w = new StartupWaterfall({ otelEnabled: false });
    w.mark('appReady', 0);
    const serverStartedAtMs = Date.parse(SERVER_BOOT.startedAt);
    w.mark('serverSpawned', serverStartedAtMs - 30);
    w.ingestServerBoot(SERVER_BOOT);
    w.mark('windowShown', 50);
    const p = w.buildPayload();
    expect(p.serverHttpListenMs).toBe(5);
    expect(p.serverSeedWalkMs).toBe(40);
    expect(p.serverIndexesMs).toBe(60);
    expect(p.serverReadyMs).toBe(120);
    expect(p.serverFileCount).toBe(17);
    expect(p.spawnToServerStartMs).toBe(30);
  });

  test('mainPhaseIntervals returns present, non-decreasing phases as named spans', () => {
    const w = new StartupWaterfall({ otelEnabled: true });
    w.mark('appReady', 100);
    w.mark('bootstrapDone', 150);
    w.mark('serverLockReady', 400);
    w.mark('windowCreated', 420);
    w.mark('loadUrlResolved', 480);
    w.mark('windowShown', 520);

    const intervals = w.mainPhaseIntervals();
    const byName = new Map(intervals.map((i) => [i.name, i]));
    expect(byName.get('ok.startup.bootstrap')).toEqual({
      name: 'ok.startup.bootstrap',
      startMs: 100,
      endMs: 150,
    });
    expect(byName.has('ok.startup.spawn')).toBe(false);
    expect(byName.has('ok.startup.lock-wait')).toBe(false);
    expect(byName.get('ok.startup.window-create')).toEqual({
      name: 'ok.startup.window-create',
      startMs: 400,
      endMs: 420,
    });
    expect(byName.get('ok.startup.show')).toEqual({
      name: 'ok.startup.show',
      startMs: 480,
      endMs: 520,
    });
  });

  test('renderer marks are reported relative to appReady', () => {
    const w = new StartupWaterfall({ otelEnabled: false });
    w.mark('appReady', 800);
    w.ingestRendererMarks(RENDERER_MARKS);
    w.mark('windowShown', 1300);
    const p = w.buildPayload();
    expect(p.rendererPageListMs).toBe(200);
    expect(p.rendererFirstContentMs).toBe(400);
    expect(p.totalLaunchToFirstContentMs).toBe(400);
  });

  test('emit fires once and only after windowShown', () => {
    const w = new StartupWaterfall({ otelEnabled: false });
    const logger = captureLogger();
    expect(w.emit(logger)).toBeUndefined();
    expect(logger.calls.length).toBe(0);

    w.mark('appReady', 0);
    w.mark('windowShown', 100);
    const payload = w.emit(logger);
    expect(payload).toBeDefined();
    expect(logger.calls.length).toBe(1);
    expect(logger.calls[0][1]).toBe('desktop.startup-timeline');

    expect(w.emit(logger)).toBeUndefined();
    expect(logger.calls.length).toBe(1);
  });

  test('readyToEmit requires window-shown + both best-effort inputs', () => {
    const w = new StartupWaterfall({ otelEnabled: false });
    w.mark('appReady', 0);
    w.mark('windowShown', 100);
    expect(w.canEmit).toBe(true);
    expect(w.readyToEmit).toBe(false);
    w.ingestServerBoot(SERVER_BOOT);
    expect(w.readyToEmit).toBe(false);
    w.ingestRendererMarks(RENDERER_MARKS);
    expect(w.readyToEmit).toBe(true);
  });

  test('canEmit flips to false once emitted', () => {
    const w = new StartupWaterfall({ otelEnabled: false });
    w.mark('windowShown', 100);
    expect(w.canEmit).toBe(true);
    w.emit(captureLogger());
    expect(w.canEmit).toBe(false);
  });

  test('otelEnabled is carried onto the payload', () => {
    const w = new StartupWaterfall({ otelEnabled: false });
    w.mark('windowShown', 100);
    const p: WaterfallPayload | undefined = w.emit(captureLogger());
    expect(p?.otelEnabled).toBe(false);
  });
});

describe('mark-time narration (the boot log the smoke harness reads)', () => {
  test('reports every phase as it happens, not only at emit time', () => {
    const seen: { phase: string; elapsedMs: number }[] = [];
    let clock = 500;
    const w = new StartupWaterfall({
      otelEnabled: false,
      now: () => clock,
      onMark: (m) => seen.push(m),
    });
    clock = 1_500;
    w.mark('appReady', clock);
    clock = 9_000;
    w.mark('serverSpawned', clock);
    clock = 26_000;
    w.mark('serverLockReady', clock);
    expect(seen.map((s) => s.phase)).toEqual(['appReady', 'serverSpawned', 'serverLockReady']);
    expect(seen.map((s) => s.elapsedMs)).toEqual([0, 7_500, 24_500]);
  });

  test('shares one time origin with the waterfall payload, so both are comparable', () => {
    const seen: { phase: string; elapsedMs: number }[] = [];
    const w = new StartupWaterfall({
      otelEnabled: false,
      now: () => 0,
      onMark: (m) => seen.push(m),
    });
    w.mark('appReady', 1_000);
    w.mark('windowShown', 4_200);
    expect(seen.find((s) => s.phase === 'windowShown')?.elapsedMs).toBe(
      w.buildPayload().totalLaunchToShownMs,
    );
  });

  test('measures a mark that precedes appReady from construction, the only origin it has', () => {
    const seen: { phase: string; elapsedMs: number }[] = [];
    const w = new StartupWaterfall({
      otelEnabled: false,
      now: () => 500,
      onMark: (m) => seen.push(m),
    });
    w.mark('bootstrapDone', 900);
    expect(seen[0]?.elapsedMs).toBe(400);
  });

  test('never lets a telemetry callback abandon boot', () => {
    const w = new StartupWaterfall({
      otelEnabled: false,
      now: () => 0,
      onMark: () => {
        throw new Error('logger not ready');
      },
    });
    expect(() => w.mark('appReady', 10)).not.toThrow();
    expect(() => w.mark('windowShown', 2_010)).not.toThrow();
    expect(w.buildPayload().totalLaunchToShownMs).toBe(2_000);
  });

  test('narrates a phase once, matching the first-write-wins mark semantics', () => {
    const seen: string[] = [];
    const w = new StartupWaterfall({
      otelEnabled: false,
      now: () => 0,
      onMark: (m) => seen.push(m.phase),
    });
    w.mark('appReady', 10);
    w.mark('appReady', 20);
    expect(seen).toEqual(['appReady']);
  });
});

describe('lastPhase (what the boot heartbeat names while it waits)', () => {
  test('is undefined before anything is marked', () => {
    expect(new StartupWaterfall({ otelEnabled: false }).lastPhase).toBeUndefined();
  });

  test('names the phase with the latest timestamp, not the last call', () => {
    const w = new StartupWaterfall({ otelEnabled: false });
    w.mark('serverSpawned', 9_000);
    w.mark('appReady', 1_000);
    expect(w.lastPhase).toBe('serverSpawned');
  });

  test('a repeat mark cannot rewind the phase, since the first write wins', () => {
    const w = new StartupWaterfall({ otelEnabled: false });
    w.mark('appReady', 1_000);
    w.mark('serverSpawned', 2_000);
    w.mark('appReady', 9_000);
    expect(w.lastPhase).toBe('serverSpawned');
  });

  test('advances as boot advances', () => {
    const w = new StartupWaterfall({ otelEnabled: false });
    w.mark('appReady', 1_000);
    expect(w.lastPhase).toBe('appReady');
    w.mark('windowCreated', 3_000);
    expect(w.lastPhase).toBe('windowCreated');
  });
});
