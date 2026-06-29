import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page } from '@playwright/test';
import { type BootstrapConfidenceInterval, bcaConfidenceInterval } from '../lib/bootstrap';
import { findKnee } from '../lib/kneedle';
import { defineScenario, type ScenarioCtx } from '../lib/scenario';
import { queryTempoByMountId, type TempoQueryResult } from '../lib/tempo-client';
import { withCheckpoint } from '../lib/with-checkpoint';

export interface LatencyProfile {
  readonly name: 'localhost' | 'fast-wifi' | 'cafe-lte' | 'slow-4g' | 'slow-3g';
  readonly approxOneWayRttMs: number;
  readonly latencyMs: number;
  readonly downloadKbps: number;
  readonly uploadKbps: number;
}

export const LATENCY_PROFILES = [
  {
    name: 'localhost',
    approxOneWayRttMs: 1,
    latencyMs: 0,
    downloadKbps: 0,
    uploadKbps: 0,
  },
  {
    name: 'fast-wifi',
    approxOneWayRttMs: 7,
    latencyMs: 14,
    downloadKbps: 50_000,
    uploadKbps: 25_000,
  },
  {
    name: 'cafe-lte',
    approxOneWayRttMs: 100,
    latencyMs: 200,
    downloadKbps: 30_000,
    uploadKbps: 15_000,
  },
  {
    name: 'slow-4g',
    approxOneWayRttMs: 281,
    latencyMs: 562,
    downloadKbps: 1_600,
    uploadKbps: 750,
  },
  {
    name: 'slow-3g',
    approxOneWayRttMs: 1000,
    latencyMs: 2000,
    downloadKbps: 400,
    uploadKbps: 400,
  },
] as const satisfies ReadonlyArray<LatencyProfile>;

export type LatencyProfileName = (typeof LATENCY_PROFILES)[number]['name'];

export function getLatencyProfile(name: LatencyProfileName): LatencyProfile {
  const profile = LATENCY_PROFILES.find((p) => p.name === name);
  if (!profile) {
    throw new Error(`unknown latency profile: ${name}`);
  }
  return profile;
}

export type StopIfReason =
  | 'throttling-method-mismatch'
  | 'server-ceiling-bound'
  | 'kneedle-degenerate'
  | 'NN-floor-clamp-multiple-profiles'
  | 'lgtm-stack-unavailable'
  | 'otel-collector-unreachable'
  | 'tempo-query-empty-for-cycle'
  | 'mountid-span-correlation-missing'
  | 'empty-profile'
  | 'partial-run'
  | 'sync-tier-1-pre-sync-disconnect-rate-exceeded'
  | 'sync-tier-2-projected-reject-rate-exceeded'
  | 'warm-path-tail-exceeds-cold-tail-on-slow-3g';

export interface CalibrationSamples {
  readonly cdpLocalhostMs: ReadonlyArray<number>;
  readonly cdpSlow3gMs: ReadonlyArray<number>;
  readonly routeWebSocketLocalhostMs: ReadonlyArray<number>;
  readonly routeWebSocketSlow3gMs: ReadonlyArray<number>;
}

export type CalibrationVerdict =
  | { kind: 'ok'; medians: CalibrationMedians }
  | {
      kind: 'mismatch';
      reason: 'throttling-method-mismatch';
      detail: string;
      medians: CalibrationMedians;
      divergenceRatio: number;
    };

export interface CalibrationMedians {
  readonly cdpLocalhostMedianMs: number;
  readonly cdpSlow3gMedianMs: number;
  readonly routeWebSocketLocalhostMedianMs: number;
  readonly routeWebSocketSlow3gMedianMs: number;
}

export const CALIBRATION_DIVERGENCE_RATIO_THRESHOLD = 1.5;

function median(samples: ReadonlyArray<number>): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const a = sorted[mid - 1];
    const b = sorted[mid];
    if (a === undefined || b === undefined) return Number.NaN;
    return (a + b) / 2;
  }
  const value = sorted[mid];
  return value !== undefined ? value : Number.NaN;
}

export function analyzeCalibration(samples: CalibrationSamples): CalibrationVerdict {
  const cdpLocal = median(samples.cdpLocalhostMs);
  const cdpSlow = median(samples.cdpSlow3gMs);
  const rwsLocal = median(samples.routeWebSocketLocalhostMs);
  const rwsSlow = median(samples.routeWebSocketSlow3gMs);

  const medians: CalibrationMedians = {
    cdpLocalhostMedianMs: cdpLocal,
    cdpSlow3gMedianMs: cdpSlow,
    routeWebSocketLocalhostMedianMs: rwsLocal,
    routeWebSocketSlow3gMedianMs: rwsSlow,
  };

  if (![cdpLocal, cdpSlow, rwsLocal, rwsSlow].every(Number.isFinite)) {
    return {
      kind: 'mismatch',
      reason: 'throttling-method-mismatch',
      detail: 'one or more calibration medians are non-finite (empty sample array?)',
      medians,
      divergenceRatio: Number.NaN,
    };
  }

  const localRatio = Math.max(cdpLocal, rwsLocal, 1) / Math.max(Math.min(cdpLocal, rwsLocal), 1);
  const slowRatio = Math.max(cdpSlow, rwsSlow, 1) / Math.max(Math.min(cdpSlow, rwsSlow), 1);
  const maxRatio = Math.max(localRatio, slowRatio);

  if (maxRatio > CALIBRATION_DIVERGENCE_RATIO_THRESHOLD) {
    return {
      kind: 'mismatch',
      reason: 'throttling-method-mismatch',
      detail: `CDP vs routeWebSocket median ratio ${maxRatio.toFixed(2)} exceeds threshold ${CALIBRATION_DIVERGENCE_RATIO_THRESHOLD} (localhost=${localRatio.toFixed(2)}, slow-3g=${slowRatio.toFixed(2)})`,
      medians,
      divergenceRatio: maxRatio,
    };
  }

  return { kind: 'ok', medians };
}

export async function applyCdpProfile(cdp: CDPSession, profile: LatencyProfile): Promise<void> {
  await cdp.send('Network.enable').catch(() => undefined);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: profile.latencyMs,
    downloadThroughput: profile.downloadKbps * 1024,
    uploadThroughput: profile.uploadKbps * 1024,
  });
}

export const SCENARIO_NAME = 'sweep-convention-cap-graduation';

export interface CellResultsScaffold {
  readonly schemaVersion: 1;
  readonly scenario: typeof SCENARIO_NAME;
  readonly capturedAt: string;
  readonly calibration: CalibrationVerdict;
  readonly stopIfFlags: ReadonlyArray<StopIfReason>;
  readonly profiles: typeof LATENCY_PROFILES;
}

export interface RunCalibrationOptions {
  readonly browser: Browser;
  readonly baseTarget: string;
  readonly samplesPerMethodPerProfile?: number;
}

export async function runCdpSmokeCalibration(
  opts: RunCalibrationOptions,
): Promise<CalibrationVerdict> {
  const samples = await measureCalibrationSamples(opts);
  return analyzeCalibration(samples);
}

async function measureCalibrationSamples(opts: RunCalibrationOptions): Promise<CalibrationSamples> {
  const samplesPerSeries = opts.samplesPerMethodPerProfile ?? 5;

  const cdpLocalhostMs = await measureRoundTripSeries({
    browser: opts.browser,
    baseTarget: opts.baseTarget,
    method: 'cdp',
    profile: getLatencyProfile('localhost'),
    sampleCount: samplesPerSeries,
  });
  const cdpSlow3gMs = await measureRoundTripSeries({
    browser: opts.browser,
    baseTarget: opts.baseTarget,
    method: 'cdp',
    profile: getLatencyProfile('slow-3g'),
    sampleCount: samplesPerSeries,
  });
  const routeWebSocketLocalhostMs = await measureRoundTripSeries({
    browser: opts.browser,
    baseTarget: opts.baseTarget,
    method: 'routeWebSocket',
    profile: getLatencyProfile('localhost'),
    sampleCount: samplesPerSeries,
  });
  const routeWebSocketSlow3gMs = await measureRoundTripSeries({
    browser: opts.browser,
    baseTarget: opts.baseTarget,
    method: 'routeWebSocket',
    profile: getLatencyProfile('slow-3g'),
    sampleCount: samplesPerSeries,
  });

  return {
    cdpLocalhostMs,
    cdpSlow3gMs,
    routeWebSocketLocalhostMs,
    routeWebSocketSlow3gMs,
  };
}

interface RoundTripSeriesOptions {
  readonly browser: Browser;
  readonly baseTarget: string;
  readonly method: 'cdp' | 'routeWebSocket';
  readonly profile: LatencyProfile;
  readonly sampleCount: number;
}

async function measureRoundTripSeries(opts: RoundTripSeriesOptions): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < opts.sampleCount; i++) {
    let elapsed: number;
    try {
      elapsed = await measureSingleColdSync({
        browser: opts.browser,
        baseTarget: opts.baseTarget,
        method: opts.method,
        profile: opts.profile,
        sampleIndex: i,
        timeoutMs: 15_000,
      });
    } catch (err) {
      console.warn(
        `[sweep] cold-sync sample ${i} (${opts.method}/${opts.profile.name}) failed:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      samples.push(elapsed);
    }
  }
  return samples;
}

interface ColdSyncMeasurementOptions {
  readonly browser: Browser;
  readonly baseTarget: string;
  readonly method: 'cdp' | 'routeWebSocket';
  readonly profile: LatencyProfile;
  readonly sampleIndex: number;
  readonly timeoutMs: number;
}

async function measureSingleColdSync(opts: ColdSyncMeasurementOptions): Promise<number> {
  const docName = `sweep-${opts.profile.name}-${opts.method}-${opts.sampleIndex}-${randomUUID()}.md`;
  const outcome = await driveSweepCycle({
    browser: opts.browser,
    baseTarget: opts.baseTarget,
    profile: opts.profile,
    method: opts.method,
    docName,
    mountId: `${opts.profile.name}-${opts.method}-${opts.sampleIndex}-${randomUUID()}`,
    timeoutMs: opts.timeoutMs,
  });
  return outcome.kind === 'success' ? outcome.syncElapsedMs : Number.NaN;
}

interface SweepCycleOptions {
  readonly browser: Browser;
  readonly baseTarget: string;
  readonly profile: LatencyProfile;
  readonly method: 'cdp' | 'routeWebSocket';
  readonly docName: string;
  readonly mountId: string;
  readonly timeoutMs: number;
}

export async function driveSweepCycle(opts: SweepCycleOptions): Promise<CycleOutcome> {
  const context: BrowserContext = await opts.browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  if (opts.method === 'routeWebSocket') {
    const halfRttMs = Math.max(0, Math.round(opts.profile.latencyMs / 2));
    await context.routeWebSocket(/.+/, async (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => {
        setTimeout(() => server.send(msg), halfRttMs);
      });
      server.onMessage((msg) => {
        setTimeout(() => ws.send(msg), halfRttMs);
      });
    });
  }

  try {
    const page = await context.newPage();

    if (opts.method === 'cdp') {
      const cdp = await context.newCDPSession(page);
      await applyCdpProfile(cdp, opts.profile);
    }

    await page.addInitScript(
      ({ docName, mountId }: { docName: string; mountId: string }) => {
        const w = window as unknown as Record<string, unknown>;
        w.__ok_test_mountId = mountId;
        w.__ok_test_docName = docName;
      },
      { docName: opts.docName, mountId: opts.mountId },
    );

    try {
      const createUrl = `${opts.baseTarget.replace(/\/+$/, '')}/api/create-page`;
      await page.evaluate(
        async ({ url, path }: { url: string; path: string }) => {
          try {
            await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path }),
            });
          } catch {}
        },
        { url: createUrl, path: `${opts.docName}.md` },
      );
    } catch {
      return { kind: 'rejected', mountId: opts.mountId, reason: 'pre-sync-disconnect' };
    }

    const target = buildSweepDocUrl(opts.baseTarget, opts.docName);
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
    } catch {
      return { kind: 'rejected', mountId: opts.mountId, reason: 'pre-sync-disconnect' };
    }

    let outcomeSignal: 'resolve' | 'reject' | null = null;
    try {
      const found = await page.waitForFunction(
        () => {
          const g = globalThis as unknown as {
            __ok_perf?: {
              marks?: {
                toArray?: () => Array<{ name: string; properties?: Record<string, unknown> }>;
              };
            };
          };
          const buf = g.__ok_perf?.marks?.toArray?.() ?? [];
          for (const m of buf) {
            if (m.name === 'ok/sync/resolve' && m.properties?.warm === false) {
              return 'resolve';
            }
            if (m.name === 'ok/sync/reject') {
              return 'reject';
            }
          }
          return null;
        },
        { timeout: opts.timeoutMs, polling: 100 },
      );
      outcomeSignal = (await found.jsonValue()) as 'resolve' | 'reject' | null;
    } catch {
      return { kind: 'rejected', mountId: opts.mountId, reason: 'sync-timeout' };
    }

    let drained: { syncCold: number | null; mountCold: number | null; rejectReason: string | null };
    try {
      drained = await page.evaluate(() => {
        const g = globalThis as unknown as {
          __ok_perf?: {
            marks?: {
              toArray?: () => Array<{ name: string; properties?: Record<string, unknown> }>;
            };
          };
        };
        const buf = g.__ok_perf?.marks?.toArray?.() ?? [];
        let syncCold: number | null = null;
        let mountCold: number | null = null;
        let rejectReason: string | null = null;
        for (const m of buf) {
          const props = m.properties;
          if (!props) continue;
          if (m.name === 'ok/sync/resolve' && props.warm === false) {
            const elapsed = Number(props.elapsedMs);
            if (Number.isFinite(elapsed)) syncCold = elapsed;
          }
          if (m.name === 'ok/sync/reject') {
            const reason = props.reason;
            if (typeof reason === 'string') rejectReason = reason;
          }
          if (m.name === 'ok/mount/resolve') {
            const elapsed = Number(props.elapsedMs);
            if (Number.isFinite(elapsed)) mountCold = elapsed;
          }
        }
        return { syncCold, mountCold, rejectReason };
      });
    } catch {
      return { kind: 'rejected', mountId: opts.mountId, reason: 'sync-timeout' };
    }

    if (outcomeSignal === 'reject') {
      const reason: 'pre-sync-disconnect' | 'sync-timeout' =
        drained.rejectReason === 'pre-sync-disconnect' ? 'pre-sync-disconnect' : 'sync-timeout';
      return { kind: 'rejected', mountId: opts.mountId, reason };
    }

    if (drained.syncCold === null) {
      return { kind: 'rejected', mountId: opts.mountId, reason: 'sync-timeout' };
    }

    return {
      kind: 'success',
      mountId: opts.mountId,
      syncElapsedMs: drained.syncCold,
      mountElapsedMs: drained.mountCold ?? drained.syncCold,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function buildSweepDocUrl(baseTarget: string, docName: string): string {
  const trimmed = baseTarget.replace(/\/+$/, '');
  const encoded = docName
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${trimmed}/#/${encoded}`;
}

export interface Slow3gWarmPathSamples {
  readonly coldMs: ReadonlyArray<number>;
  readonly warmMs: ReadonlyArray<number>;
}

const SLOW_3G_WARM_PATH_DEFAULT_CYCLES = 10;
const SLOW_3G_WARM_PATH_PER_CYCLE_TIMEOUT_MS = 60_000;

export async function runSlow3gWarmPathSpotCheck(opts: {
  browser: Browser;
  baseTarget: string;
  cycleCount?: number;
}): Promise<Slow3gWarmPathSamples> {
  const cycleCount = opts.cycleCount ?? SLOW_3G_WARM_PATH_DEFAULT_CYCLES;
  const slow3g = getLatencyProfile('slow-3g');
  const coldMs: number[] = [];
  const warmMs: number[] = [];

  for (let i = 0; i < cycleCount; i++) {
    const docName = `sweep-slow-3g-warm-spotcheck-${i}-${randomUUID()}.md`;
    const altDocName = `sweep-slow-3g-warm-spotcheck-${i}-${randomUUID()}-alt.md`;
    let captured: { cold: number; warm: number } | null = null;
    try {
      captured = await captureColdThenWarmInOneContext({
        browser: opts.browser,
        baseTarget: opts.baseTarget,
        profile: slow3g,
        docName,
        altDocName,
      });
    } catch (err) {
      console.warn(
        `[sweep] slow-3g warm-path cycle ${i} dropped:`,
        err instanceof Error ? err.message : String(err),
      );
      captured = null;
    }
    if (captured !== null) {
      coldMs.push(captured.cold);
      warmMs.push(captured.warm);
    }
  }

  return { coldMs, warmMs };
}

async function captureColdThenWarmInOneContext(input: {
  browser: Browser;
  baseTarget: string;
  profile: LatencyProfile;
  docName: string;
  altDocName: string;
}): Promise<{ cold: number; warm: number } | null> {
  const context: BrowserContext = await input.browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await applyCdpProfile(cdp, input.profile);

    const targetCold = buildSweepDocUrl(input.baseTarget, input.docName);
    const _targetAlt = buildSweepDocUrl(input.baseTarget, input.altDocName);

    try {
      const createUrl = `${input.baseTarget.replace(/\/+$/, '')}/api/create-page`;
      await page.evaluate(
        async ({ url, paths }: { url: string; paths: string[] }) => {
          for (const path of paths) {
            try {
              await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path }),
              });
            } catch {}
          }
        },
        { url: createUrl, paths: [`${input.docName}.md`, `${input.altDocName}.md`] },
      );
    } catch {
      return null;
    }

    try {
      await page.goto(targetCold, {
        waitUntil: 'domcontentloaded',
        timeout: SLOW_3G_WARM_PATH_PER_CYCLE_TIMEOUT_MS,
      });
    } catch {
      return null;
    }

    const coldElapsed = await drainElapsedForMark(
      page,
      'ok/sync/resolve',
      false,
      SLOW_3G_WARM_PATH_PER_CYCLE_TIMEOUT_MS,
    );
    if (coldElapsed === null) return null;

    await page.evaluate(
      (hash: string) => {
        window.location.hash = hash;
      },
      `#/${encodeURIComponent(input.altDocName).replace(/%2F/g, '/')}`,
    );
    await page.waitForTimeout(200);

    await page.evaluate(
      (hash: string) => {
        window.location.hash = hash;
      },
      `#/${encodeURIComponent(input.docName).replace(/%2F/g, '/')}`,
    );

    const warmElapsed = await drainElapsedForMark(
      page,
      'ok/sync/resolve',
      true,
      SLOW_3G_WARM_PATH_PER_CYCLE_TIMEOUT_MS,
    );
    if (warmElapsed === null) return null;

    return { cold: coldElapsed, warm: warmElapsed };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function drainElapsedForMark(
  page: Page,
  markName: string,
  warm: boolean,
  timeoutMs: number,
): Promise<number | null> {
  try {
    await page.waitForFunction(
      ({ name, expectWarm }: { name: string; expectWarm: boolean }) => {
        const g = globalThis as unknown as {
          __ok_perf?: {
            marks?: {
              toArray?: () => Array<{ name: string; properties?: Record<string, unknown> }>;
            };
          };
        };
        const buf = g.__ok_perf?.marks?.toArray?.() ?? [];
        for (const m of buf) {
          if (m.name !== name) continue;
          const w = m.properties?.warm;
          if (w === expectWarm) return true;
        }
        return false;
      },
      { name: markName, expectWarm: warm },
      { timeout: timeoutMs, polling: 100 },
    );
  } catch {
    return null;
  }
  const elapsed = await page.evaluate(
    ({ name, expectWarm }: { name: string; expectWarm: boolean }) => {
      const g = globalThis as unknown as {
        __ok_perf?: {
          marks?: { toArray?: () => Array<{ name: string; properties?: Record<string, unknown> }> };
        };
      };
      const buf = g.__ok_perf?.marks?.toArray?.() ?? [];
      for (let i = buf.length - 1; i >= 0; i--) {
        const m = buf[i];
        if (!m || m.name !== name) continue;
        const w = m.properties?.warm;
        if (w !== expectWarm) continue;
        const v = Number(m.properties?.elapsedMs);
        return Number.isFinite(v) ? v : null;
      }
      return null;
    },
    { name: markName, expectWarm: warm },
  );
  return elapsed;
}

export function buildScaffoldCellResults(calibration: CalibrationVerdict): CellResultsScaffold {
  const stopIfFlags: StopIfReason[] = [];
  if (calibration.kind === 'mismatch') {
    stopIfFlags.push(calibration.reason);
  }
  return {
    schemaVersion: 1,
    scenario: SCENARIO_NAME,
    capturedAt: new Date().toISOString(),
    calibration,
    stopIfFlags,
    profiles: LATENCY_PROFILES,
  };
}

export interface PerCycleRow {
  readonly mountId: string;
  readonly profile: LatencyProfileName;
  readonly cycleIndex: number;
  readonly syncElapsedMs: number;
  readonly mountElapsedMs: number;
  readonly rejectedReason: 'pre-sync-disconnect' | 'sync-timeout' | null;
  readonly retryAfterRejectionMs: number | null;
  readonly serverSpanTimings: {
    readonly syncHandshakeMs: number | null;
    readonly persistenceLoadMs: number | null;
  } | null;
  readonly clientSpanTimings: {
    readonly coldMountMs: number | null;
    readonly providerPoolOpenMs: number | null;
    readonly mountPromiseMs: number | null;
    readonly syncPromiseMs: number | null;
  } | null;
}

export type CycleOutcome =
  | {
      kind: 'success';
      mountId: string;
      syncElapsedMs: number;
      mountElapsedMs: number;
      retryAfterRejectionMs?: number;
    }
  | {
      kind: 'rejected';
      mountId: string;
      reason: 'pre-sync-disconnect' | 'sync-timeout';
      retryAfterRejectionMs?: number;
    };

export interface PerProfileSummary {
  readonly profile: LatencyProfileName;
  readonly latencyMs: number;
  readonly samples: number;
  readonly rejectedCount: number;
  readonly rejectRate: number;
  readonly syncElapsedMs: {
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
  };
  readonly mountElapsedMs: {
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
  };
  readonly syncP99BootstrapCi95: BootstrapConfidenceInterval | null;
  readonly stopIfFlags: ReadonlyArray<StopIfReason>;
}

/** Driver function — called once per cycle. Production wires Playwright;
 *  smoke test wires a synthetic driver that returns predetermined outcomes.
 */
export type CycleDriver = (input: {
  profile: LatencyProfile;
  cycleIndex: number;
}) => Promise<CycleOutcome>;

export interface RunCycleLoopOptions {
  readonly driver: CycleDriver;
  readonly cyclesPerProfile: number;
  readonly profiles?: ReadonlyArray<LatencyProfile>;
  readonly continueOnProfileFailure?: boolean;
  readonly checkpointPath?: string;
}

export interface CycleLoopResult {
  readonly perCycle: ReadonlyArray<PerCycleRow>;
  readonly perProfile: ReadonlyArray<PerProfileSummary>;
  readonly wasPartialResume: boolean;
}

export function percentile(samples: ReadonlyArray<number>, p: number): number | null {
  if (samples.length === 0) return null;
  if (p < 0 || p > 1) {
    throw new Error(`percentile: p must be in [0, 1]; got ${p}`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) {
    const value = sorted[lo];
    return value !== undefined ? value : null;
  }
  const loValue = sorted[lo];
  const hiValue = sorted[hi];
  if (loValue === undefined || hiValue === undefined) return null;
  const frac = rank - lo;
  return loValue + (hiValue - loValue) * frac;
}

export function buildPerProfileSummary(
  profile: LatencyProfile,
  cycles: ReadonlyArray<PerCycleRow>,
): PerProfileSummary {
  const nonRejected = cycles.filter((c) => c.rejectedReason === null);
  const rejected = cycles.length - nonRejected.length;
  const syncSamples = nonRejected.map((c) => c.syncElapsedMs);
  const mountSamples = nonRejected.map((c) => c.mountElapsedMs);
  const stopIfFlags: StopIfReason[] = [];
  if (nonRejected.length === 0) {
    stopIfFlags.push('empty-profile');
  }
  const syncP99 = percentile(syncSamples, 0.99);
  const syncP99BootstrapCi95 =
    syncSamples.length >= 2
      ? bcaConfidenceInterval(syncSamples, 0.025, {
          statistic: (s) => percentile(s, 0.99) ?? 0,
        })
      : null;
  return {
    profile: profile.name,
    latencyMs: profile.latencyMs,
    samples: nonRejected.length,
    rejectedCount: rejected,
    rejectRate: cycles.length > 0 ? rejected / cycles.length : 0,
    syncElapsedMs: {
      p50: percentile(syncSamples, 0.5),
      p95: percentile(syncSamples, 0.95),
      p99: syncP99,
    },
    mountElapsedMs: {
      p50: percentile(mountSamples, 0.5),
      p95: percentile(mountSamples, 0.95),
      p99: percentile(mountSamples, 0.99),
    },
    syncP99BootstrapCi95,
    stopIfFlags,
  };
}

function cycleCheckpointKey(input: CycleLoopInput): string {
  return `${input.profile.name}.cycle-${input.cycleIndex}`;
}

interface CycleLoopInput {
  readonly profile: LatencyProfile;
  readonly cycleIndex: number;
}

function peekCheckpointEntryCount(checkpointPath: string): number {
  if (!existsSync(checkpointPath)) return 0;
  try {
    const raw = readFileSync(checkpointPath, 'utf8');
    const parsed = JSON.parse(raw) as { entries?: ReadonlyArray<unknown> };
    return Array.isArray(parsed.entries) ? parsed.entries.length : 0;
  } catch (err) {
    console.warn(
      `[sweep] checkpoint at ${checkpointPath} unreadable; treating as empty:`,
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

export async function runCycleLoop(opts: RunCycleLoopOptions): Promise<CycleLoopResult> {
  const profiles = opts.profiles ?? LATENCY_PROFILES;
  const continueOnFailure = opts.continueOnProfileFailure ?? true;

  const inputs: CycleLoopInput[] = [];
  for (const profile of profiles) {
    for (let i = 0; i < opts.cyclesPerProfile; i++) {
      inputs.push({ profile, cycleIndex: i });
    }
  }

  const priorEntryCount =
    opts.checkpointPath !== undefined ? peekCheckpointEntryCount(opts.checkpointPath) : 0;

  const runOne = async (input: CycleLoopInput): Promise<CycleOutcome> => {
    try {
      return await opts.driver(input);
    } catch (err) {
      if (!continueOnFailure) throw err;
      console.warn(
        `[sweep] driver threw for ${input.profile.name} cycle ${input.cycleIndex}:`,
        err instanceof Error ? err.message : String(err),
      );
      return {
        kind: 'rejected',
        mountId: `error-${input.profile.name}-${input.cycleIndex}`,
        reason: 'sync-timeout',
      };
    }
  };

  const outcomes: ReadonlyArray<CycleOutcome> =
    opts.checkpointPath !== undefined
      ? await withCheckpoint(runOne, inputs, {
          checkpointPath: opts.checkpointPath,
          keyOf: cycleCheckpointKey,
          flushAfterEach: true,
        })
      : await runWithoutCheckpoint(runOne, inputs);

  const perCycle: PerCycleRow[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const outcome = outcomes[i];
    if (!input || !outcome) continue;
    perCycle.push(outcomeToRow(outcome, input.profile, input.cycleIndex));
  }

  const perProfile: PerProfileSummary[] = [];
  for (const profile of profiles) {
    const cyclesForProfile = perCycle.filter((c) => c.profile === profile.name);
    perProfile.push(buildPerProfileSummary(profile, cyclesForProfile));
  }

  const wasPartialResume = priorEntryCount > 0 && priorEntryCount < inputs.length;

  return { perCycle, perProfile, wasPartialResume };
}

async function runWithoutCheckpoint(
  op: (input: CycleLoopInput) => Promise<CycleOutcome>,
  inputs: ReadonlyArray<CycleLoopInput>,
): Promise<ReadonlyArray<CycleOutcome>> {
  const out: CycleOutcome[] = [];
  for (const input of inputs) {
    out.push(await op(input));
  }
  return out;
}

function outcomeToRow(
  outcome: CycleOutcome,
  profile: LatencyProfile,
  cycleIndex: number,
): PerCycleRow {
  const retryAfterRejectionMs =
    typeof outcome.retryAfterRejectionMs === 'number' &&
    Number.isFinite(outcome.retryAfterRejectionMs)
      ? outcome.retryAfterRejectionMs
      : null;
  if (outcome.kind === 'success') {
    return {
      mountId: outcome.mountId,
      profile: profile.name,
      cycleIndex,
      syncElapsedMs: outcome.syncElapsedMs,
      mountElapsedMs: outcome.mountElapsedMs,
      rejectedReason: null,
      retryAfterRejectionMs,
      serverSpanTimings: null,
      clientSpanTimings: null,
    };
  }
  return {
    mountId: outcome.mountId,
    profile: profile.name,
    cycleIndex,
    syncElapsedMs: 0,
    mountElapsedMs: 0,
    rejectedReason: outcome.reason,
    retryAfterRejectionMs,
    serverSpanTimings: null,
    clientSpanTimings: null,
  };
}

export interface CellResultsFull {
  readonly schemaVersion: 1;
  readonly scenario: typeof SCENARIO_NAME;
  readonly capturedAt: string;
  readonly calibration: CalibrationVerdict;
  readonly stopIfFlags: ReadonlyArray<StopIfReason>;
  readonly profiles: typeof LATENCY_PROFILES;
  readonly perCycle: ReadonlyArray<PerCycleRow>;
  readonly perProfile: ReadonlyArray<PerProfileSummary>;
  readonly syncMethodology?: SyncMethodologyResult;
  readonly mountMethodology?: MountMethodologyResult;
  readonly differentials?: DifferentialsRollup;
  readonly hostFingerprint?: HostFingerprint;
}

export interface PerProfileDifferentials {
  readonly profile: LatencyProfileName;
  readonly serverProcessingShareOfP99: number | null;
  readonly providerSetupContaminationMs: number | null;
  readonly syncDominatesMountTailRatio: number | null;
}

export interface GlobalFalsifiabilityChecks {
  readonly deploymentTopologyRobustness: 'PASS' | 'FAIL';
  readonly mountVsSyncTailIndependence: 'PASS' | 'FAIL';
}

export interface DifferentialsRollup {
  readonly perProfile: ReadonlyArray<PerProfileDifferentials>;
  readonly globalFalsifiabilityChecks: GlobalFalsifiabilityChecks;
}

export const DEPLOYMENT_TOPOLOGY_FAIL_THRESHOLD = 0.5;

export const MOUNT_VS_SYNC_TAIL_INDEPENDENCE_FAIL_THRESHOLD = 0.85;

const SLOW_PROFILE_NAMES: ReadonlySet<LatencyProfileName> = new Set(['slow-4g', 'slow-3g']);

function safeRatio(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
): number | null {
  if (numerator === null || numerator === undefined) return null;
  if (denominator === null || denominator === undefined) return null;
  if (denominator === 0) return null;
  return numerator / denominator;
}

function medianNullable(samples: ReadonlyArray<number>): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const a = sorted[mid - 1];
    const b = sorted[mid];
    if (a === undefined || b === undefined) return null;
    return (a + b) / 2;
  }
  const value = sorted[mid];
  return value !== undefined ? value : null;
}

export function computeDifferentials(opts: {
  perProfile: ReadonlyArray<PerProfileSummary>;
  perCycle: ReadonlyArray<PerCycleRow>;
}): DifferentialsRollup {
  const perProfile: PerProfileDifferentials[] = [];

  for (const profile of opts.perProfile) {
    const cyclesForProfile = opts.perCycle.filter(
      (c) => c.profile === profile.profile && c.rejectedReason === null,
    );

    const serverHandshakeSamples = cyclesForProfile
      .map((c) => c.serverSpanTimings?.syncHandshakeMs)
      .filter((v): v is number => v !== null && v !== undefined);
    const handshakeP99 =
      serverHandshakeSamples.length > 0 ? percentile(serverHandshakeSamples, 0.99) : null;
    const serverProcessingShareOfP99 = safeRatio(handshakeP99, profile.syncElapsedMs.p99);

    const providerOpenSamples = cyclesForProfile
      .map((c) => c.clientSpanTimings?.providerPoolOpenMs)
      .filter((v): v is number => v !== null && v !== undefined);
    const providerSetupContaminationMs =
      providerOpenSamples.length > 0 ? medianNullable(providerOpenSamples) : null;

    const syncDominatesMountTailRatio = safeRatio(
      profile.syncElapsedMs.p99,
      profile.mountElapsedMs.p99,
    );

    perProfile.push({
      profile: profile.profile,
      serverProcessingShareOfP99,
      providerSetupContaminationMs,
      syncDominatesMountTailRatio,
    });
  }

  let deploymentTopologyRobustness: 'PASS' | 'FAIL' = 'PASS';
  for (const d of perProfile) {
    if (!SLOW_PROFILE_NAMES.has(d.profile)) continue;
    if (
      d.serverProcessingShareOfP99 !== null &&
      d.serverProcessingShareOfP99 > DEPLOYMENT_TOPOLOGY_FAIL_THRESHOLD
    ) {
      deploymentTopologyRobustness = 'FAIL';
      break;
    }
  }

  let mountVsSyncTailIndependence: 'PASS' | 'FAIL' = 'PASS';
  for (const d of perProfile) {
    if (
      d.syncDominatesMountTailRatio !== null &&
      d.syncDominatesMountTailRatio > MOUNT_VS_SYNC_TAIL_INDEPENDENCE_FAIL_THRESHOLD
    ) {
      mountVsSyncTailIndependence = 'FAIL';
      break;
    }
  }

  return {
    perProfile,
    globalFalsifiabilityChecks: {
      deploymentTopologyRobustness,
      mountVsSyncTailIndependence,
    },
  };
}

export interface HostFingerprint {
  readonly cpu: string;
  readonly ramGb: number;
  readonly concurrentDevServerLoad: 'idle' | 'active' | 'unknown';
  readonly devServerUptimeMinutes: number | null;
  readonly fixtureDocSizeBytes: number | null;
}

export type HostFingerprintEnv = Readonly<Record<string, string | undefined>>;

export function detectHostFingerprint(env: HostFingerprintEnv = process.env): HostFingerprint {
  const cpu = env.OK_HOST_CPU ?? 'unknown';
  const ramGbRaw = Number(env.OK_HOST_RAM_GB ?? 16);
  const ramGb = Number.isFinite(ramGbRaw) ? ramGbRaw : 16;
  const concurrentDevServerLoad: HostFingerprint['concurrentDevServerLoad'] =
    env.OK_HOST_DEV_SERVER_LOAD === 'idle'
      ? 'idle'
      : env.OK_HOST_DEV_SERVER_LOAD === 'active'
        ? 'active'
        : 'unknown';
  const uptimeRaw = env.OK_HOST_DEV_SERVER_UPTIME_MINUTES
    ? Number(env.OK_HOST_DEV_SERVER_UPTIME_MINUTES)
    : Number.NaN;
  const devServerUptimeMinutes = Number.isFinite(uptimeRaw) ? uptimeRaw : null;
  const fixtureBytesRaw = env.OK_HOST_FIXTURE_DOC_SIZE_BYTES
    ? Number(env.OK_HOST_FIXTURE_DOC_SIZE_BYTES)
    : Number.NaN;
  const fixtureDocSizeBytes = Number.isFinite(fixtureBytesRaw) ? fixtureBytesRaw : null;
  return {
    cpu,
    ramGb,
    concurrentDevServerLoad,
    devServerUptimeMinutes,
    fixtureDocSizeBytes,
  };
}

export interface SyncMethodologyLevers {
  readonly percentile: 'p99';
  readonly safetyMargin: number;
  readonly hocuspocusTimeoutMs: number;
  readonly serverCeilingMargin: number;
}

export const DEFAULT_SYNC_METHODOLOGY_LEVERS = {
  percentile: 'p99',
  safetyMargin: 4,
  hocuspocusTimeoutMs: 60_000,
  serverCeilingMargin: 5_000,
} as const satisfies SyncMethodologyLevers;

export const SYNC_METHODOLOGY_SAFETY_MARGIN_RANGE = { min: 3, max: 5 } as const;

export interface SyncProfileRecommendation {
  readonly profile: LatencyProfileName;
  readonly p99Ms: number | null;
  readonly multiplierRecommendationMs: number | null;
  readonly bcaUpperRecommendationMs: number | null;
  readonly preSyncDisconnectRate: number;
  readonly projectedRejectRateAtMultiplierCap: number;
  readonly tier1Exceeded: boolean;
  readonly tier2Exceeded: boolean;
  readonly retryAfterRejectionMsP99: number | null;
  readonly retryAfterRejectionSampleCount: number;
  readonly stopIfFlags: ReadonlyArray<StopIfReason>;
}

export interface Slow3gWarmPathSpotCheck {
  readonly coldP99Ms: number | null;
  readonly warmP99Ms: number | null;
  readonly ratio: number | null;
  readonly warmTailExceedsCold: boolean;
  readonly coldSampleCount: number;
  readonly warmSampleCount: number;
}

export interface SyncMethodologyResult {
  readonly methodology: 'p99-percentile-with-multiplier-bounded-by-server-ceiling';
  readonly designLevers: SyncMethodologyLevers;
  readonly serverCeilingMs: number;
  readonly perProfile: ReadonlyArray<SyncProfileRecommendation>;
  readonly globalMultiplierRecommendationMs: number | null;
  readonly globalBcaUpperRecommendationMs: number | null;
  readonly slow3gWarmPath?: Slow3gWarmPathSpotCheck;
  readonly stopIfFlags: ReadonlyArray<StopIfReason>;
}

export const SYNC_REJECT_RATE_TIER_1_THRESHOLD = 0.01;
export const SYNC_REJECT_RATE_TIER_2_THRESHOLD = 0.01;

function clampToCeiling(valueMs: number | null, ceilingMs: number): number | null {
  if (valueMs === null) return null;
  return Math.min(valueMs, ceilingMs);
}

export function projectRejectRateAtCap(syncSamples: ReadonlyArray<number>, capMs: number): number {
  if (syncSamples.length === 0) return 0;
  const above = syncSamples.filter((s) => s > capMs).length;
  return above / syncSamples.length;
}

export const SLOW_3G_WARM_PATH_RATIO_THRESHOLD = 2;

export function computeSyncMethodology(opts: {
  perProfile: ReadonlyArray<PerProfileSummary>;
  perCycle: ReadonlyArray<PerCycleRow>;
  levers?: Partial<SyncMethodologyLevers>;
  slow3gWarmPathSamples?: {
    coldMs: ReadonlyArray<number>;
    warmMs: ReadonlyArray<number>;
  };
}): SyncMethodologyResult {
  const levers: SyncMethodologyLevers = {
    percentile: 'p99',
    safetyMargin: opts.levers?.safetyMargin ?? DEFAULT_SYNC_METHODOLOGY_LEVERS.safetyMargin,
    hocuspocusTimeoutMs:
      opts.levers?.hocuspocusTimeoutMs ?? DEFAULT_SYNC_METHODOLOGY_LEVERS.hocuspocusTimeoutMs,
    serverCeilingMargin:
      opts.levers?.serverCeilingMargin ?? DEFAULT_SYNC_METHODOLOGY_LEVERS.serverCeilingMargin,
  };
  if (
    levers.safetyMargin < SYNC_METHODOLOGY_SAFETY_MARGIN_RANGE.min ||
    levers.safetyMargin > SYNC_METHODOLOGY_SAFETY_MARGIN_RANGE.max
  ) {
    throw new Error(
      `SYNC methodology: safetyMargin ${levers.safetyMargin} outside documented range [${SYNC_METHODOLOGY_SAFETY_MARGIN_RANGE.min}, ${SYNC_METHODOLOGY_SAFETY_MARGIN_RANGE.max}].`,
    );
  }
  const serverCeilingMs = levers.hocuspocusTimeoutMs - levers.serverCeilingMargin;

  const perProfile: SyncProfileRecommendation[] = [];
  const globalFlags: StopIfReason[] = [];

  for (const profile of opts.perProfile) {
    const cyclesForProfile = opts.perCycle.filter((c) => c.profile === profile.profile);
    const nonRejected = cyclesForProfile
      .filter((c) => c.rejectedReason === null)
      .map((c) => c.syncElapsedMs);
    const preSyncDisconnects = cyclesForProfile.filter(
      (c) => c.rejectedReason === 'pre-sync-disconnect',
    ).length;
    const preSyncDisconnectRate =
      cyclesForProfile.length > 0 ? preSyncDisconnects / cyclesForProfile.length : 0;

    const p99 = profile.syncElapsedMs.p99;
    const multiplierRecommendationUnclamped = p99 !== null ? p99 * levers.safetyMargin : null;
    const multiplierRecommendation = clampToCeiling(
      multiplierRecommendationUnclamped,
      serverCeilingMs,
    );
    const bcaUpperRecommendation = clampToCeiling(
      profile.syncP99BootstrapCi95?.hi ?? null,
      serverCeilingMs,
    );
    const projectedRejectRate =
      multiplierRecommendation !== null
        ? projectRejectRateAtCap(nonRejected, multiplierRecommendation)
        : 0;

    const tier1Exceeded = preSyncDisconnectRate > SYNC_REJECT_RATE_TIER_1_THRESHOLD;
    const tier2Exceeded = projectedRejectRate > SYNC_REJECT_RATE_TIER_2_THRESHOLD;

    const retrySamples = cyclesForProfile
      .map((c) => c.retryAfterRejectionMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const retryP99 = retrySamples.length > 0 ? percentile(retrySamples, 0.99) : null;

    const profileFlags: StopIfReason[] = [];
    if (
      multiplierRecommendationUnclamped !== null &&
      multiplierRecommendationUnclamped > serverCeilingMs
    ) {
      profileFlags.push('server-ceiling-bound');
      if (!globalFlags.includes('server-ceiling-bound')) globalFlags.push('server-ceiling-bound');
    }
    if (tier1Exceeded) {
      profileFlags.push('sync-tier-1-pre-sync-disconnect-rate-exceeded');
      if (!globalFlags.includes('sync-tier-1-pre-sync-disconnect-rate-exceeded')) {
        globalFlags.push('sync-tier-1-pre-sync-disconnect-rate-exceeded');
      }
    }
    if (tier2Exceeded) {
      profileFlags.push('sync-tier-2-projected-reject-rate-exceeded');
      if (!globalFlags.includes('sync-tier-2-projected-reject-rate-exceeded')) {
        globalFlags.push('sync-tier-2-projected-reject-rate-exceeded');
      }
    }

    perProfile.push({
      profile: profile.profile,
      p99Ms: p99,
      multiplierRecommendationMs: multiplierRecommendation,
      bcaUpperRecommendationMs: bcaUpperRecommendation,
      preSyncDisconnectRate,
      projectedRejectRateAtMultiplierCap: projectedRejectRate,
      tier1Exceeded,
      tier2Exceeded,
      retryAfterRejectionMsP99: retryP99,
      retryAfterRejectionSampleCount: retrySamples.length,
      stopIfFlags: profileFlags,
    });
  }

  const multiplierValues = perProfile
    .map((p) => p.multiplierRecommendationMs)
    .filter((v): v is number => v !== null);
  const bcaUpperValues = perProfile
    .map((p) => p.bcaUpperRecommendationMs)
    .filter((v): v is number => v !== null);
  const globalMultiplier =
    multiplierValues.length > 0 ? Math.min(Math.max(...multiplierValues), serverCeilingMs) : null;
  const globalBcaUpper =
    bcaUpperValues.length > 0 ? Math.min(Math.max(...bcaUpperValues), serverCeilingMs) : null;

  let slow3gWarmPath: Slow3gWarmPathSpotCheck | undefined;
  if (opts.slow3gWarmPathSamples !== undefined) {
    const coldMs = opts.slow3gWarmPathSamples.coldMs;
    const warmMs = opts.slow3gWarmPathSamples.warmMs;
    const coldP99 = coldMs.length > 0 ? percentile(coldMs, 0.99) : null;
    const warmP99 = warmMs.length > 0 ? percentile(warmMs, 0.99) : null;
    const ratio = safeRatio(warmP99, coldP99);
    const warmTailExceedsCold = ratio !== null && ratio > SLOW_3G_WARM_PATH_RATIO_THRESHOLD;
    slow3gWarmPath = {
      coldP99Ms: coldP99,
      warmP99Ms: warmP99,
      ratio,
      warmTailExceedsCold,
      coldSampleCount: coldMs.length,
      warmSampleCount: warmMs.length,
    };
    if (warmTailExceedsCold) {
      if (!globalFlags.includes('warm-path-tail-exceeds-cold-tail-on-slow-3g')) {
        globalFlags.push('warm-path-tail-exceeds-cold-tail-on-slow-3g');
      }
    }
  }

  return {
    methodology: 'p99-percentile-with-multiplier-bounded-by-server-ceiling',
    designLevers: levers,
    serverCeilingMs,
    perProfile,
    globalMultiplierRecommendationMs: globalMultiplier,
    globalBcaUpperRecommendationMs: globalBcaUpper,
    ...(slow3gWarmPath ? { slow3gWarmPath } : {}),
    stopIfFlags: globalFlags,
  };
}

export function buildFullCellResults(
  calibration: CalibrationVerdict,
  cycleResult: CycleLoopResult,
  opts?: {
    readonly syncLevers?: Partial<SyncMethodologyLevers>;
    readonly skipSyncMethodology?: boolean;
    readonly mountLevers?: Partial<MountMethodologyLevers>;
    readonly skipMountMethodology?: boolean;
    readonly skipDifferentials?: boolean;
    readonly skipHostFingerprint?: boolean;
    readonly hostFingerprintEnv?: HostFingerprintEnv;
    readonly slow3gWarmPathSamples?: Slow3gWarmPathSamples;
  },
): CellResultsFull {
  const stopIfFlags: StopIfReason[] = [];
  if (calibration.kind === 'mismatch') {
    stopIfFlags.push(calibration.reason);
  }
  if (cycleResult.wasPartialResume) {
    stopIfFlags.push('partial-run');
  }
  for (const profile of cycleResult.perProfile) {
    for (const flag of profile.stopIfFlags) {
      if (!stopIfFlags.includes(flag)) stopIfFlags.push(flag);
    }
  }

  let syncMethodology: SyncMethodologyResult | undefined;
  if (!opts?.skipSyncMethodology) {
    syncMethodology = computeSyncMethodology({
      perProfile: cycleResult.perProfile,
      perCycle: cycleResult.perCycle,
      ...(opts?.syncLevers ? { levers: opts.syncLevers } : {}),
      ...(opts?.slow3gWarmPathSamples ? { slow3gWarmPathSamples: opts.slow3gWarmPathSamples } : {}),
    });
    for (const flag of syncMethodology.stopIfFlags) {
      if (!stopIfFlags.includes(flag)) stopIfFlags.push(flag);
    }
  }

  let mountMethodology: MountMethodologyResult | undefined;
  if (!opts?.skipMountMethodology) {
    mountMethodology = computeMountMethodology({
      perProfile: cycleResult.perProfile,
      perCycle: cycleResult.perCycle,
      ...(opts?.mountLevers ? { levers: opts.mountLevers } : {}),
    });
    for (const flag of mountMethodology.stopIfFlags) {
      if (!stopIfFlags.includes(flag)) stopIfFlags.push(flag);
    }
  }

  let differentials: DifferentialsRollup | undefined;
  if (!opts?.skipDifferentials) {
    differentials = computeDifferentials({
      perProfile: cycleResult.perProfile,
      perCycle: cycleResult.perCycle,
    });
  }

  const hostFingerprint = opts?.skipHostFingerprint
    ? undefined
    : detectHostFingerprint(opts?.hostFingerprintEnv);

  return {
    schemaVersion: 1,
    scenario: SCENARIO_NAME,
    capturedAt: new Date().toISOString(),
    calibration,
    stopIfFlags,
    profiles: LATENCY_PROFILES,
    perCycle: cycleResult.perCycle,
    perProfile: cycleResult.perProfile,
    ...(syncMethodology ? { syncMethodology } : {}),
    ...(mountMethodology ? { mountMethodology } : {}),
    ...(differentials ? { differentials } : {}),
    ...(hostFingerprint ? { hostFingerprint } : {}),
  };
}

export type LgtmPreflightResult =
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: 'lgtm-stack-unavailable'; detail: string };

export type DockerComposeExec = (args: ReadonlyArray<string>) => string;

export const LGTM_TEMPO_CONTAINER_NAME = 'ok-otel-tempo';

export function isTempoRunning(dockerComposeJsonOutput: string): boolean {
  if (dockerComposeJsonOutput.trim().length === 0) return false;
  for (const line of dockerComposeJsonOutput.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: { Name?: unknown; State?: unknown };
    try {
      parsed = JSON.parse(trimmed) as { Name?: unknown; State?: unknown };
    } catch {
      continue;
    }
    const name = typeof parsed.Name === 'string' ? parsed.Name : '';
    const state = typeof parsed.State === 'string' ? parsed.State : '';
    if (name === LGTM_TEMPO_CONTAINER_NAME && state === 'running') {
      return true;
    }
  }
  return false;
}

export async function checkLgtmStackPreflight(opts: {
  exec: DockerComposeExec;
}): Promise<LgtmPreflightResult> {
  let output: string;
  try {
    output = opts.exec([
      'compose',
      '-f',
      'docker/otel-dev/docker-compose.yml',
      'ps',
      '--format',
      'json',
    ]);
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: 'lgtm-stack-unavailable',
      detail: `docker compose ps failed: ${err instanceof Error ? err.message : String(err)}. Start the stack with: cd docker/otel-dev && docker compose up -d`,
    };
  }
  if (isTempoRunning(output)) {
    return { kind: 'available' };
  }
  return {
    kind: 'unavailable',
    reason: 'lgtm-stack-unavailable',
    detail: `Tempo container ${LGTM_TEMPO_CONTAINER_NAME} is not running. Start the stack with: cd docker/otel-dev && docker compose up -d`,
  };
}

export function defaultDockerComposeExec(args: ReadonlyArray<string>): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export type OtelCollectorPreflightResult =
  | { kind: 'reachable' }
  | { kind: 'unreachable'; reason: 'otel-collector-unreachable'; detail: string };

export type OtelCollectorFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export async function checkOtelCollectorReachable(opts: {
  otelBaseUrl: string;
  fetchFn?: OtelCollectorFetch;
  timeoutMs?: number;
}): Promise<OtelCollectorPreflightResult> {
  const fetchFn: OtelCollectorFetch =
    opts.fetchFn ??
    (async (url, init) => {
      const res = await fetch(url, init);
      return { ok: res.ok, status: res.status };
    });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2_000);
  try {
    const res = await fetchFn(`${opts.otelBaseUrl}/v1/traces`, { signal: controller.signal });
    if (res.ok || res.status === 405 || res.status === 404 || res.status === 400) {
      return { kind: 'reachable' };
    }
    return {
      kind: 'unreachable',
      reason: 'otel-collector-unreachable',
      detail: `OTLP/HTTP probe to ${opts.otelBaseUrl}/v1/traces returned HTTP ${res.status}. Expected 4xx (collector bound). Verify VITE_OTEL_COLLECTOR_URL matches the docker-compose port mapping (default canonical: http://localhost:14318).`,
    };
  } catch (err) {
    return {
      kind: 'unreachable',
      reason: 'otel-collector-unreachable',
      detail: `OTLP/HTTP probe to ${opts.otelBaseUrl}/v1/traces failed: ${err instanceof Error ? err.message : String(err)}. The collector container may be up (docker ps reports healthy) but the host port is not bound. Verify VITE_OTEL_COLLECTOR_URL matches docker/otel-dev/docker-compose.yml's port mapping (canonical: http://localhost:14318).`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface TempoEnrichmentResult {
  readonly enriched: ReadonlyArray<PerCycleRow>;
  readonly emptyCount: number;
  readonly correlationMissingCount: number;
  readonly errorCount: number;
}

export type TempoQueryFn = (input: {
  mountId: string;
  startTimeMs: number;
  endTimeMs: number;
}) => Promise<TempoQueryResult>;

export interface EnrichCyclesOptions {
  readonly cycles: ReadonlyArray<PerCycleRow>;
  readonly query: TempoQueryFn;
  readonly windowPaddingMs?: number;
  readonly cycleTimestampMs?: ReadonlyArray<number>;
}

export async function enrichCyclesWithTempo(
  opts: EnrichCyclesOptions,
): Promise<TempoEnrichmentResult> {
  const windowPaddingMs = opts.windowPaddingMs ?? 5_000;
  const nowMs = Date.now();
  const enriched: PerCycleRow[] = [];
  let emptyCount = 0;
  let correlationMissingCount = 0;
  let errorCount = 0;

  for (let i = 0; i < opts.cycles.length; i++) {
    const cycle = opts.cycles[i];
    if (!cycle) continue;
    const center = opts.cycleTimestampMs?.[i] ?? nowMs;
    const startTimeMs = center - windowPaddingMs;
    const endTimeMs = center + windowPaddingMs;

    const result = await opts.query({
      mountId: cycle.mountId,
      startTimeMs,
      endTimeMs,
    });

    if (result.kind === 'success') {
      enriched.push({
        ...cycle,
        serverSpanTimings: result.serverSpanTimings,
        clientSpanTimings: result.clientSpanTimings,
      });
      continue;
    }

    if (result.kind === 'empty') emptyCount += 1;
    else if (result.kind === 'correlation-missing') correlationMissingCount += 1;
    else if (result.kind === 'error') errorCount += 1;

    enriched.push({
      ...cycle,
      serverSpanTimings: null,
      clientSpanTimings: null,
    });
  }

  return { enriched, emptyCount, correlationMissingCount, errorCount };
}

export const TEMPO_PROFILE_ABORT_THRESHOLD = 0.1;

export function classifyProfileTempoHealth(opts: {
  totalCycles: number;
  emptyCount: number;
  correlationMissingCount: number;
}): ReadonlyArray<StopIfReason> {
  const flags: StopIfReason[] = [];
  if (opts.totalCycles === 0) return flags;
  const emptyRatio = opts.emptyCount / opts.totalCycles;
  if (emptyRatio > TEMPO_PROFILE_ABORT_THRESHOLD) {
    flags.push('tempo-query-empty-for-cycle');
  }
  if (opts.correlationMissingCount > 0) {
    flags.push('mountid-span-correlation-missing');
  }
  return flags;
}

export interface MountMethodologyLevers {
  readonly nnFloorMs: number;
  readonly nnCeilingMs: number;
}

export const DEFAULT_MOUNT_METHODOLOGY_LEVERS = {
  nnFloorMs: 3_000,
  nnCeilingMs: 10_000,
} as const satisfies MountMethodologyLevers;

export interface MountMethodologyResult {
  readonly methodology: 'kneedle-bounded-by-NN';
  readonly designLevers: MountMethodologyLevers;
  readonly inflectionMs: number;
  readonly recommendedCapMs: number;
  readonly clamp: 'floor' | 'ceiling' | 'none';
  readonly stopIfFlags: ReadonlyArray<StopIfReason>;
  readonly perProfileRejectRates: ReadonlyArray<{
    readonly profile: LatencyProfileName;
    readonly rejectRate: number;
  }>;
  readonly nnFloorContributingProfileCount: number;
}

export function buildMountTimeCdf(samples: ReadonlyArray<number>): Array<{ x: number; y: number }> {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => a - b);
  const cdf: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const x = sorted[i];
    if (x === undefined) continue;
    if (i + 1 < sorted.length && sorted[i + 1] === x) continue;
    cdf.push({ x, y: (i + 1) / sorted.length });
  }
  return cdf;
}

export function computeMountMethodology(opts: {
  perProfile: ReadonlyArray<PerProfileSummary>;
  perCycle: ReadonlyArray<PerCycleRow>;
  levers?: Partial<MountMethodologyLevers>;
}): MountMethodologyResult {
  const levers: MountMethodologyLevers = {
    nnFloorMs: opts.levers?.nnFloorMs ?? DEFAULT_MOUNT_METHODOLOGY_LEVERS.nnFloorMs,
    nnCeilingMs: opts.levers?.nnCeilingMs ?? DEFAULT_MOUNT_METHODOLOGY_LEVERS.nnCeilingMs,
  };
  if (levers.nnFloorMs >= levers.nnCeilingMs) {
    throw new Error(
      `MOUNT methodology: nnFloorMs (${levers.nnFloorMs}) must be < nnCeilingMs (${levers.nnCeilingMs}).`,
    );
  }

  const stopIfFlags: StopIfReason[] = [];
  const perProfileRejectRates = opts.perProfile.map((p) => ({
    profile: p.profile,
    rejectRate: p.rejectRate,
  }));

  const allMountSamples: number[] = [];
  for (const cycle of opts.perCycle) {
    if (cycle.rejectedReason === null) {
      allMountSamples.push(cycle.mountElapsedMs);
    }
  }

  if (allMountSamples.length === 0) {
    return {
      methodology: 'kneedle-bounded-by-NN',
      designLevers: levers,
      inflectionMs: Number.NaN,
      recommendedCapMs: levers.nnCeilingMs,
      clamp: 'ceiling',
      stopIfFlags: ['kneedle-degenerate'],
      perProfileRejectRates,
      nnFloorContributingProfileCount: 0,
    };
  }

  let nnFloorContributingProfileCount = 0;
  for (const profile of opts.perProfile) {
    const samples = opts.perCycle
      .filter((c) => c.profile === profile.profile && c.rejectedReason === null)
      .map((c) => c.mountElapsedMs);
    if (samples.length === 0) continue;
    if (Math.max(...samples) <= levers.nnFloorMs) {
      nnFloorContributingProfileCount += 1;
    }
  }
  if (nnFloorContributingProfileCount > 1) {
    stopIfFlags.push('NN-floor-clamp-multiple-profiles');
  }

  const cdf = buildMountTimeCdf(allMountSamples);
  const knee = findKnee(cdf, { direction: 'increasing' });

  const isDegenerate =
    !Number.isFinite(knee.x) || knee.x === undefined || knee.x <= 0 || knee.confidence === 'LOW';

  if (isDegenerate) {
    stopIfFlags.push('kneedle-degenerate');
    return {
      methodology: 'kneedle-bounded-by-NN',
      designLevers: levers,
      inflectionMs: Number.isFinite(knee.x) ? knee.x : Number.NaN,
      recommendedCapMs: levers.nnCeilingMs,
      clamp: 'ceiling',
      stopIfFlags,
      perProfileRejectRates,
      nnFloorContributingProfileCount,
    };
  }

  const inflectionMs = knee.x;
  let recommendedCapMs: number;
  let clamp: 'floor' | 'ceiling' | 'none';
  if (inflectionMs < levers.nnFloorMs) {
    recommendedCapMs = levers.nnFloorMs;
    clamp = 'floor';
  } else if (inflectionMs > levers.nnCeilingMs) {
    recommendedCapMs = levers.nnCeilingMs;
    clamp = 'ceiling';
  } else {
    recommendedCapMs = inflectionMs;
    clamp = 'none';
  }

  return {
    methodology: 'kneedle-bounded-by-NN',
    designLevers: levers,
    inflectionMs,
    recommendedCapMs,
    clamp,
    stopIfFlags,
    perProfileRejectRates,
    nnFloorContributingProfileCount,
  };
}

/** Per-cycle wall-clock budget for the production driver, in ms.
 *  Covers navigation + cold-sync wait. Padding above the in-app
 *  `SYNC_TIMEOUT_MS` (30000) so the test driver's timeout doesn't fire
 *  BEFORE the in-app sync-timeout — otherwise the driver records a
 *  `sync-timeout` cycle when the in-app code would have rejected
 *  with the same reason a moment later. Padding keeps the in-app code
 *  the source of timeout truth.
 */
const PRODUCTION_CYCLE_TIMEOUT_MS = 45_000;

const PRODUCTION_RETRY_TIMEOUT_MS = PRODUCTION_CYCLE_TIMEOUT_MS;

export function buildProductionCycleDriver(opts: {
  browser: Browser;
  baseTarget: string;
}): CycleDriver {
  return async (input) => {
    const mountId = `${input.profile.name}-cycle-${input.cycleIndex}-${randomUUID()}`;
    const docName = `sweep-${input.profile.name}-${input.cycleIndex}-${randomUUID()}.md`;
    const firstAttempt = await driveSweepCycle({
      browser: opts.browser,
      baseTarget: opts.baseTarget,
      profile: input.profile,
      method: 'cdp',
      docName,
      mountId,
      timeoutMs: PRODUCTION_CYCLE_TIMEOUT_MS,
    });

    if (firstAttempt.kind === 'rejected' && firstAttempt.reason === 'sync-timeout') {
      const retryDocName = `sweep-${input.profile.name}-${input.cycleIndex}-retry-${randomUUID()}.md`;
      const retryMountId = `${mountId}-retry`;
      const retryStart = performance.now();
      const retryAttempt = await driveSweepCycle({
        browser: opts.browser,
        baseTarget: opts.baseTarget,
        profile: input.profile,
        method: 'cdp',
        docName: retryDocName,
        mountId: retryMountId,
        timeoutMs: PRODUCTION_RETRY_TIMEOUT_MS,
      });
      const retryElapsedMs = performance.now() - retryStart;
      if (retryAttempt.kind === 'success') {
        return {
          ...firstAttempt,
          retryAfterRejectionMs: retryAttempt.syncElapsedMs,
        };
      }
      return {
        ...firstAttempt,
        retryAfterRejectionMs: retryElapsedMs,
      };
    }

    return firstAttempt;
  };
}

async function productionTempoQuery(input: {
  mountId: string;
  startTimeMs: number;
  endTimeMs: number;
}): Promise<TempoQueryResult> {
  return queryTempoByMountId(input);
}

export default defineScenario({
  name: SCENARIO_NAME,
  description:
    'Convention-cap graduation distribution-measurement sweep. Chromium-only. Engineer-local. The full campaign runs ~40-60 min across 5 profiles × ~50 cycles.',
  async run(ctx: ScenarioCtx): Promise<void> {
    const lgtm = await checkLgtmStackPreflight({ exec: defaultDockerComposeExec });
    ctx.recordMetric('sweep.lgtmStackKind', lgtm.kind);
    if (lgtm.kind === 'unavailable') {
      const scaffold = buildScaffoldCellResults({
        kind: 'mismatch',
        reason: 'throttling-method-mismatch',
        detail: lgtm.detail,
        medians: {
          cdpLocalhostMedianMs: 0,
          cdpSlow3gMedianMs: 0,
          routeWebSocketLocalhostMedianMs: 0,
          routeWebSocketSlow3gMedianMs: 0,
        },
        divergenceRatio: 0,
      });
      const stopIfFlags: StopIfReason[] = ['lgtm-stack-unavailable'];
      const payload = { ...scaffold, stopIfFlags };
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const cellResultsPath = resolve(ctx.opts.outDir, `cell-results-${timestamp}.json`);
      writeFileSync(cellResultsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      ctx.recordMetric('sweep.cellResultsPath', cellResultsPath);
      ctx.note(`STOP_IF: lgtm-stack-unavailable — ${lgtm.detail}`);
      return;
    }

    const collector = await checkOtelCollectorReachable({
      otelBaseUrl: 'http://localhost:14318',
    });
    ctx.recordMetric('sweep.otelCollectorKind', collector.kind);
    if (collector.kind === 'unreachable') {
      const scaffold = buildScaffoldCellResults({
        kind: 'mismatch',
        reason: 'throttling-method-mismatch',
        detail: collector.detail,
        medians: {
          cdpLocalhostMedianMs: 0,
          cdpSlow3gMedianMs: 0,
          routeWebSocketLocalhostMedianMs: 0,
          routeWebSocketSlow3gMedianMs: 0,
        },
        divergenceRatio: 0,
      });
      const stopIfFlags: StopIfReason[] = ['otel-collector-unreachable'];
      const payload = { ...scaffold, stopIfFlags };
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const cellResultsPath = resolve(ctx.opts.outDir, `cell-results-${timestamp}.json`);
      writeFileSync(cellResultsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      ctx.recordMetric('sweep.cellResultsPath', cellResultsPath);
      ctx.note(`STOP_IF: otel-collector-unreachable — ${collector.detail}`);
      return;
    }

    const calibration = await runCdpSmokeCalibration({
      browser: ctx.browser,
      baseTarget: ctx.opts.target,
    });
    ctx.recordMetric('sweep.calibrationKind', calibration.kind);

    if (calibration.kind === 'mismatch') {
      const cellResults = buildScaffoldCellResults(calibration);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const cellResultsPath = resolve(ctx.opts.outDir, `cell-results-${timestamp}.json`);
      writeFileSync(cellResultsPath, `${JSON.stringify(cellResults, null, 2)}\n`, 'utf8');
      ctx.recordMetric('sweep.cellResultsPath', cellResultsPath);
      ctx.note(
        `STOP_IF: throttling-method-mismatch — ${calibration.detail}. Cell-results JSON written at ${cellResultsPath}; the cycle loop was NOT executed. Investigate CDP shaping fidelity before re-running the sweep.`,
      );
      return;
    }

    const checkpointPath = resolve(
      ctx.opts.outDir,
      `sweep-convention-cap-graduation.checkpoint.json`,
    );
    const driver = buildProductionCycleDriver({
      browser: ctx.browser,
      baseTarget: ctx.opts.target,
    });
    const cycleResult = await runCycleLoop({
      driver,
      cyclesPerProfile: 50,
      checkpointPath,
    });

    const tempoEnriched = await enrichCyclesWithTempo({
      cycles: cycleResult.perCycle,
      query: productionTempoQuery,
    });
    const finalCycleResult: CycleLoopResult = {
      perCycle: tempoEnriched.enriched,
      perProfile: cycleResult.perProfile,
      wasPartialResume: cycleResult.wasPartialResume,
    };

    let slow3gWarmPathSamples: Slow3gWarmPathSamples | undefined;
    try {
      slow3gWarmPathSamples = await runSlow3gWarmPathSpotCheck({
        browser: ctx.browser,
        baseTarget: ctx.opts.target,
      });
      ctx.recordMetric('sweep.slow3gWarmPathColdSamples', slow3gWarmPathSamples.coldMs.length);
      ctx.recordMetric('sweep.slow3gWarmPathWarmSamples', slow3gWarmPathSamples.warmMs.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sweep] slow-3g warm-path spot-check failed:`, msg);
      ctx.note(`slow-3g warm-path spot-check threw: ${msg}. Main cell-results still emitted.`);
      slow3gWarmPathSamples = undefined;
    }

    const cellResults = buildFullCellResults(
      calibration,
      finalCycleResult,
      slow3gWarmPathSamples ? { slow3gWarmPathSamples } : undefined,
    );
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const cellResultsPath = resolve(ctx.opts.outDir, `cell-results-${timestamp}.json`);
    writeFileSync(cellResultsPath, `${JSON.stringify(cellResults, null, 2)}\n`, 'utf8');
    ctx.recordMetric('sweep.cellResultsPath', cellResultsPath);
    ctx.recordMetric('sweep.totalCycles', finalCycleResult.perCycle.length);
    ctx.recordMetric('sweep.stopIfFlagCount', cellResults.stopIfFlags.length);
    ctx.recordMetric('sweep.tempoEmpty', tempoEnriched.emptyCount);
    ctx.recordMetric('sweep.tempoCorrelationMissing', tempoEnriched.correlationMissingCount);

    ctx.note(
      `cycle loop complete: ${finalCycleResult.perCycle.length} cycles across ${finalCycleResult.perProfile.length} profiles. Tempo: ${tempoEnriched.emptyCount} empty, ${tempoEnriched.correlationMissingCount} correlation-missing. STOP_IF flags: ${cellResults.stopIfFlags.join(', ') || 'none'}.`,
    );
  },
});
