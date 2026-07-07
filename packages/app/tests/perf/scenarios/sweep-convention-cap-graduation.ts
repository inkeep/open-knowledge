/**
 * Convention-cap graduation sweep scenario.
 *
 * Measures the cold-mount cycle distribution under 5 RTT-bound latency
 * profiles to inform two cap-graduation methodologies:
 *
 *   - SYNC_TIMEOUT_MS: p99-percentile-with-multiplier bounded by the
 *     Hocuspocus server-timeout coherence ceiling.
 *   - MOUNT_STALLED_THRESHOLD_MS: kneedle inflection of the aggregated
 *     mount-time CDF, clamped to Nielsen-Norman perception bounds.
 *
 * 1-pass distribution-fit measurement, not a multi-cell Cartesian sweep
 * (uses `defineScenario`, never `defineSweep`).
 *
 * Lifecycle per scenario invocation:
 *
 *   1. LGTM stack pre-flight (`docker compose ps` on the otel-dev stack).
 *      Without the stack the Tempo enrichment downstream would produce
 *      null span timings for every cycle — wasted operator time. Fail
 *      fast with `STOP_IF: lgtm-stack-unavailable`.
 *   2. CDP smoke-test calibration. Verifies that Chromium CDP
 *      `Network.emulateNetworkConditions` actually shapes the WebSocket
 *      round-trip and compares CDP against a `page.routeWebSocket()`
 *      fallback on localhost + one slow profile. If the distributions
 *      diverge >1.5x, exit with `STOP_IF: throttling-method-mismatch` —
 *      do NOT silently fall back to routeWebSocket. The rest of the
 *      sweep depends on CDP shaping being faithful.
 *   3. Per-profile cycle loop — fresh BrowserContext per cycle, drain
 *      ok/sync/resolve-elapsed-ms + ok/mount/resolve-elapsed-ms marks,
 *      build per-cycle JSON rows. Resumable via `withCheckpoint` so a
 *      mid-run crash doesn't force a re-run from cycle 0.
 *   4. Tempo query per cycle folds OTel span decomposition (server
 *      sync.handshake + 4 frontend spans) into the perCycle rows so
 *      the engineer can attribute latency variance to transport,
 *      server processing, and client setup at flip time.
 *   5. SYNC + MOUNT methodologies + differentials rollup computed
 *      from the captured distribution and written to cell-results JSON.
 *
 * Invocation: `bun run sweep:convention-cap-graduation`. The script
 * writes `<outDir>/cell-results-<ISO8601>.json` — the canonical
 * artifact the engineer reads at flip time.
 *
 * Chromium-only: the scenario uses CDP for WS throttling, and CDP
 * throttling fidelity outside Chromium is undocumented. The OK
 * Playwright config is already Chromium-only.
 */

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

// ---------------------------------------------------------------------------
// Latency profiles (5 RTT-bound bands)
// ---------------------------------------------------------------------------

/**
 * Profile envelope for Chromium CDP `Network.emulateNetworkConditions`.
 * `latencyMs` is the full round-trip latency added on top of native
 * (CDP semantics — NOT one-way RTT). `downloadKbps`/`uploadKbps` are
 * absolute throughput caps; 0 = no throttle on that direction. Profile
 * names are kebab-case so they round-trip cleanly to the cell-results
 * JSON without quoting.
 */
export interface LatencyProfile {
  readonly name: 'localhost' | 'fast-wifi' | 'cafe-lte' | 'slow-4g' | 'slow-3g';
  /** Approximate one-way RTT in ms (for documentation; not used by CDP). */
  readonly approxOneWayRttMs: number;
  /** Full round-trip latency added by CDP throttling, in ms. */
  readonly latencyMs: number;
  /** Download throughput cap in Kbps; 0 = no cap. */
  readonly downloadKbps: number;
  /** Upload throughput cap in Kbps; 0 = no cap. */
  readonly uploadKbps: number;
}

/**
 * The 5 RTT-bound profiles. Numbers reflect:
 *   - localhost: native (no throttle) — measurement floor
 *   - fast-wifi: ~5-10ms RTT band (corporate LAN / home wifi)
 *   - cafe-lte: ~70-150ms RTT band (LTE on coffee-shop Wi-Fi)
 *   - slow-4g: WPT canonical "slow 4G" (562ms RTT)
 *   - slow-3g: WPT canonical "slow 3G" (2000ms RTT) — measurement ceiling
 * `as const satisfies` to make additions explicit and prevent drift on
 * the discriminator union.
 */
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

/** Lookup helper. Throws on unknown name — caller controls input. */
export function getLatencyProfile(name: LatencyProfileName): LatencyProfile {
  const profile = LATENCY_PROFILES.find((p) => p.name === name);
  if (!profile) {
    throw new Error(`unknown latency profile: ${name}`);
  }
  return profile;
}

// ---------------------------------------------------------------------------
// STOP_IF catalog (sweep-scoped reasons that flag in cell-results JSON)
// ---------------------------------------------------------------------------

/**
 * Runtime guards. Each name flags in the cell-results JSON so the
 * engineer reads a specific actionable string at flip time rather than
 * a generic "sweep failed."
 */
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
  // SYNC methodology — input-quality tier. preSyncDisconnect rate
  // exceeding the Tier-1 threshold means the profile is breaking the
  // WS handshake (not just slowing it); the campaign aborts.
  | 'sync-tier-1-pre-sync-disconnect-rate-exceeded'
  // SYNC methodology — output-failure-rate tier. The projected reject
  // rate at the recommended cap exceeds the Tier-2 threshold; the cap
  // is miscalibrated for that profile but the campaign continues.
  | 'sync-tier-2-projected-reject-rate-exceeded'
  // SYNC methodology — warm-path spot-check on slow-3g. Warm sync p99
  // exceeded cold sync p99 by more than 2x: the Pattern-A cold-only
  // measurement assumption is violated (warm tail dominates) and the
  // cap-calibration's failure-rate target may be wrong by that much.
  | 'warm-path-tail-exceeds-cold-tail-on-slow-3g';

// ---------------------------------------------------------------------------
// Calibration — verifies CDP shaping is faithful before the campaign starts
// ---------------------------------------------------------------------------

/**
 * Per-method round-trip-time samples captured during calibration. Two
 * methods race the same workload: CDP `Network.emulateNetworkConditions`
 * and `page.routeWebSocket()` (Playwright's higher-level shaping
 * primitive). If the medians of the same profile diverge beyond the
 * tolerance, neither method is trustworthy as a sole source — exit loud.
 */
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

/**
 * Divergence tolerance. >1.5x ratio between CDP and routeWebSocket
 * on the same profile means the shaping is unreliable; the sweep aborts.
 */
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

/**
 * Pure-function analysis of calibration samples. Splits out from the
 * Playwright-driven measurement so the STOP_IF logic is testable without
 * a browser. Returns the verdict the calling scenario flows into the
 * cell-results JSON.
 */
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

  // Any non-finite median is a failed calibration — typically caused by
  // empty sample arrays (the workload didn't complete a round-trip). The
  // mismatch arm produces a structured `reason` so the cell-results JSON
  // surfaces an actionable string for the operator.
  if (![cdpLocal, cdpSlow, rwsLocal, rwsSlow].every(Number.isFinite)) {
    return {
      kind: 'mismatch',
      reason: 'throttling-method-mismatch',
      detail: 'one or more calibration medians are non-finite (empty sample array?)',
      medians,
      divergenceRatio: Number.NaN,
    };
  }

  // Avoid divide-by-zero on a localhost native run where median can be 0.
  // Use 1ms as the floor for the ratio comparison; below that, treat as
  // "indistinguishable" (no real signal to compare against).
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

// ---------------------------------------------------------------------------
// CDP throttling — single source of truth for applying a profile
// ---------------------------------------------------------------------------

/**
 * Apply a profile via Chromium CDP `Network.emulateNetworkConditions`.
 * CDPSession is per-context — each fresh BrowserContext gets a new CDP
 * session, so the profile must be re-applied per context.
 *
 * `offline=false` is explicit so a future regression that flips it to
 * true (which would block the WS handshake entirely) is loud.
 */
export async function applyCdpProfile(cdp: CDPSession, profile: LatencyProfile): Promise<void> {
  await cdp.send('Network.enable').catch(() => undefined);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: profile.latencyMs,
    downloadThroughput: profile.downloadKbps * 1024,
    uploadThroughput: profile.uploadKbps * 1024,
  });
}

// ---------------------------------------------------------------------------
// Scenario entry
// ---------------------------------------------------------------------------

export const SCENARIO_NAME = 'sweep-convention-cap-graduation';

/**
 * Scaffolded cell-results JSON payload. Captures the calibration outcome
 * and the scenario's exit disposition WITHOUT the per-cycle data — used
 * when the scenario aborts before the cycle loop runs (calibration
 * mismatch, LGTM unavailable). The full payload shape with perCycle /
 * perProfile / methodologies / differentials is `CellResultsFull` below.
 *
 * `schemaVersion` is bumped whenever a non-additive change lands; the
 * engineer at flip time reads this to know which methodology renderer to
 * apply.
 */
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
  /**
   * Per-method, per-profile sample count for the calibration. Default 5
   * — enough for a stable median without burning minutes on calibration.
   * The sweep's per-profile cycle count is independent (defaults to 50).
   */
  readonly samplesPerMethodPerProfile?: number;
}

/**
 * Drive the CDP smoke-test calibration. Opens fresh BrowserContexts for
 * each (method, profile) pair so the throttling is applied cleanly per
 * sample series. Returns a verdict the scenario flows into the
 * cell-results JSON.
 */
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

/**
 * Drive a Playwright workload that opens fresh BrowserContexts, applies
 * the requested shaping method (CDP `Network.emulateNetworkConditions`
 * vs `routeWebSocket` per-frame `setTimeout(latencyMs/2)`), and measures
 * the cold sync handshake elapsed for each sample. The two methods are
 * raced on identical profiles so the analyzer can detect a fidelity
 * divergence — if the medians disagree, the sweep aborts loudly with
 * `STOP_IF: throttling-method-mismatch` rather than silently picking
 * the wrong shaping primitive.
 *
 * Sample failures (no resolve before the per-sample timeout, navigation
 * error, etc.) are dropped silently. The analyzer sees a shorter array
 * and treats an entirely-empty array as `non-finite-median` →
 * `throttling-method-mismatch`. The per-sample timeout is short (15s)
 * because calibration runs on localhost or slow-3g + a one-doc cold
 * mount; a full SYNC_TIMEOUT_MS budget would be wasteful here.
 */
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
      // Drop-and-continue is correct for calibration resilience — a
      // single navigation glitch should not abort the round-trip series —
      // but log the actual error so an operator triaging
      // STOP_IF: throttling-method-mismatch later has the root cause.
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

/**
 * Open a fresh BrowserContext, apply throttling, navigate to a unique
 * doc URL, and resolve to the cold sync `elapsedMs` drained from the
 * `ok/sync/resolve` mark (cold variant — `warm: false`). Returns NaN
 * on any failure path (navigation throw, timeout waiting for the mark,
 * missing elapsedMs prop).
 *
 * This is the SHARED primitive — the calibration loop and the production
 * cycle driver both consume it. Each sample/cycle gets a unique doc name
 * so the cold-path sync handshake always fires (Pattern A: no IDB carry
 * across contexts).
 */
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

// ---------------------------------------------------------------------------
// Shared cycle primitive — drives one cold sync + drain against the dev server
// ---------------------------------------------------------------------------

interface SweepCycleOptions {
  readonly browser: Browser;
  readonly baseTarget: string;
  readonly profile: LatencyProfile;
  readonly method: 'cdp' | 'routeWebSocket';
  readonly docName: string;
  readonly mountId: string;
  /** Wall-clock budget for the entire navigate + cold-sync wait. */
  readonly timeoutMs: number;
}

/**
 * Drive one cold mount against the dev server: fresh BrowserContext,
 * shaping applied, navigate to the doc URL, wait for the cold-path
 * `ok/sync/resolve` mark to land, drain elapsed values from the perf
 * ring. Returns a `CycleOutcome` — the same shape the cycle loop and
 * downstream Tempo enrichment / methodologies consume.
 *
 * Pattern A isolation: a fresh BrowserContext means a fresh IDB which
 * means the warm-path cache is empty — the first navigation always
 * triggers the cold-path sync handshake. The `warm: true` mark variant
 * never fires here, so the drain filter for `warm === false` is the
 * canonical cold sample.
 *
 * The driver itself never throws — any failure path maps to a
 * `CycleOutcome.rejected` with a structured reason. The cycle loop +
 * checkpoint substrate both depend on this no-throw contract.
 */
export async function driveSweepCycle(opts: SweepCycleOptions): Promise<CycleOutcome> {
  const context: BrowserContext = await opts.browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  // `routeWebSocket` is registered at the context level (before any
  // page opens) so the shaping intercepts the very first WS frame
  // from the editor's collab provider.
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

    // Surface the mountId on the renderer so the sync.handshake span
    // (server side) and the 4 cold-mount frontend spans carry it as
    // an attribute. The renderer reads `window.__ok_test_mountId` and
    // threads it through `getMountId(docName)`.
    await page.addInitScript(
      ({ docName, mountId }: { docName: string; mountId: string }) => {
        const w = window as unknown as Record<string, unknown>;
        w.__ok_test_mountId = mountId;
        // Some editor entry points read a docName hint before hash
        // routing settles — surface both.
        w.__ok_test_docName = docName;
      },
      { docName: opts.docName, mountId: opts.mountId },
    );

    // Ensure the target doc exists on disk BEFORE navigation. The OK
    // editor's mount flow doesn't auto-create missing docs on hash nav —
    // it would render the "not found" branch instead of opening a
    // sync-promise. POST /api/create-page is idempotent in this regard
    // (returns 409 / specific error on existing doc, 200 on create).
    // We don't fail the cycle if create returns a non-success — the
    // doc may already exist from a previous cycle or a prior partial
    // run. The downstream waitForFunction observes the marks ring; if
    // navigation truly can't reach a doc, that timeout surfaces it as
    // sync-timeout per the documented contract.
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
          } catch {
            // Non-fatal — see comment above.
          }
        },
        { url: createUrl, path: `${opts.docName}.md` },
      );
    } catch {
      // Bubble up to the same rejection class as a goto failure — the
      // dev server isn't reachable at all.
      return { kind: 'rejected', mountId: opts.mountId, reason: 'pre-sync-disconnect' };
    }

    const target = buildSweepDocUrl(opts.baseTarget, opts.docName);
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
    } catch {
      return { kind: 'rejected', mountId: opts.mountId, reason: 'pre-sync-disconnect' };
    }

    // Observe BOTH `ok/sync/resolve` (warm:false, the success case) AND
    // `ok/sync/reject` (the rejection case) in one waitForFunction. Polling
    // only for `ok/sync/resolve` would force the driver to wait the full
    // SAMPLE_TIMEOUT_MS on rejected cycles even though the in-page
    // sync-promise has already settled (production SYNC_TIMEOUT_MS=30s
    // emits `ok/sync/reject` with reason='timeout' as the canonical
    // settlement signal). The previous polling shape was the
    // driver-listener-race root cause: the cycle's outcome was observable
    // at second 30 (reject mark in the ring) but the driver kept polling
    // until SAMPLE_TIMEOUT_MS=60s, hanging the entire sweep on every
    // not-successful cycle.
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
      // waitForFunction timed out without seeing either mark — the cycle
      // legitimately ran past the driver's own ceiling. Map to sync-timeout
      // for the methodology (the driver ceiling is a superset of the
      // production cap).
      return { kind: 'rejected', mountId: opts.mountId, reason: 'sync-timeout' };
    }

    // Drain marks for the rejection-reason and cold-elapsed values. The
    // try/catch around page.evaluate restores the driver's no-throw
    // contract: Playwright can throw here if the page detaches
    // after a renderer crash, the context closes from a concurrent
    // navigation, or the evaluator hits a serialization error. Any throw
    // here must map to a structured CycleOutcome.rejected, not propagate
    // out and corrupt withCheckpoint's JSON or abort the campaign.
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
      // Map the in-page reject reason to the CycleOutcome discriminator.
      // The methodology's two-tier reject-rate gate distinguishes
      // pre-sync-disconnect (transport breakage) from sync-timeout
      // (genuine slow handshake) — preserve that taxonomy through the
      // driver so the SyncProfileRecommendation's preSyncDisconnectRate
      // vs projectedRejectRateAtMultiplierCap split stays accurate.
      const reason: 'pre-sync-disconnect' | 'sync-timeout' =
        drained.rejectReason === 'pre-sync-disconnect' ? 'pre-sync-disconnect' : 'sync-timeout';
      return { kind: 'rejected', mountId: opts.mountId, reason };
    }

    if (drained.syncCold === null) {
      // resolve signal observed but elapsed couldn't be read — treat as
      // sync-timeout to avoid polluting the resolve distribution with
      // NaN/null. This is defensive: a healthy resolve always carries
      // a finite elapsedMs property per sync-promise's mark contract.
      return { kind: 'rejected', mountId: opts.mountId, reason: 'sync-timeout' };
    }

    return {
      kind: 'success',
      mountId: opts.mountId,
      syncElapsedMs: drained.syncCold,
      // Mount-resolve may not have fired by the time the sync mark
      // lands (mount-promise resolves AFTER provider setup, which is
      // post-sync). Fall back to syncElapsedMs so the differential
      // ratio stays finite; null would propagate as a degenerate value
      // through the mount methodology aggregation.
      mountElapsedMs: drained.mountCold ?? drained.syncCold,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Construct the navigation URL for a single sweep cycle. The OK app's
 * canonical doc-hash format is `#/<docName>` (see `lib/doc-hash.ts`
 * `docNameFromHash` — it gates on `#/` prefix and returns null for
 * any other shape including the previous `#doc:` form). The hash
 * routing in `DocumentContext` reads from `window.location.hash` on
 * mount, so the renderer kicks off the cold-path sync without a
 * separate `__ok_open` callback. Doc names may include `/` for folder
 * paths; preserve segment boundaries so the hash router sees the same
 * path the file watcher would.
 */
export function buildSweepDocUrl(baseTarget: string, docName: string): string {
  const trimmed = baseTarget.replace(/\/+$/, '');
  const encoded = docName
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${trimmed}/#/${encoded}`;
}

// ---------------------------------------------------------------------------
// Slow 3G warm-path spot-check primitive
// ---------------------------------------------------------------------------

/**
 * Sample arrays from the slow-3g warm-path spot-check. `coldMs[i]` is
 * the first-open sync elapsed for doc `i`; `warmMs[i]` is the same
 * doc's second-open (warm-reopen) sync elapsed in the same context.
 * The two arrays are paired — `coldMs.length === warmMs.length` when
 * every cycle captured both samples; degraded cycles drop both
 * samples atomically.
 */
export interface Slow3gWarmPathSamples {
  readonly coldMs: ReadonlyArray<number>;
  readonly warmMs: ReadonlyArray<number>;
}

const SLOW_3G_WARM_PATH_DEFAULT_CYCLES = 10;
const SLOW_3G_WARM_PATH_PER_CYCLE_TIMEOUT_MS = 60_000;

/**
 * Run a small slow-3g workload that captures cold + warm sync
 * elapsed for the same doc in the same BrowserContext. Pattern A
 * (fresh-context-per-cycle) intentionally measures only the cold
 * path; this primitive complements it by checking the warm-path
 * assumption — the production methodology assumes warm sync is
 * synchronous-or-near-zero, and a warm tail dominating the cold
 * tail would invalidate the cap-calibration's failure-rate target.
 *
 * Each cycle:
 *   1. Open a fresh context with slow-3g CDP throttling applied.
 *   2. Navigate to doc A → wait for cold sync mark → record cold ms.
 *   3. Hash-route AWAY from doc A, then back, forcing the editor to
 *      remount the same doc. The sync-promise cache reuses the
 *      already-synced provider → warm path fires → record warm ms.
 *   4. Close the context.
 *
 * The driver never throws — a failed cycle (timeout, navigation
 * error) drops BOTH samples for that index so the paired arrays
 * stay aligned.
 */
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
      // Per-cycle drop is by design — one bad cycle shouldn't take out
      // the spot-check. But silent on every cycle would let "all 10
      // failed" return `{ coldMs: [], warmMs: [] }` with no operator
      // signal. Warn at cycle granularity so the live sweep log shows
      // which cycles dropped and why.

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

    // Pre-create both docs (cold + alt) so the hash-route navigations
    // open a real doc and trigger the cold-path sync. The OK editor's
    // mount flow doesn't auto-create missing docs on hash nav.
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
            } catch {
              // Best-effort; the cold-cycle goto + waitFor will surface
              // any deeper navigation failure.
            }
          }
        },
        { url: createUrl, paths: [`${input.docName}.md`, `${input.altDocName}.md`] },
      );
    } catch {
      return null;
    }

    // Cold navigation — wait for the warm:false mark.
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

    // Navigate AWAY to an alt doc (hash change in the same SPA — the
    // DocumentContext clears the active editor and the provider-pool
    // keeps the prior provider warm in cache). The canonical OK
    // doc-hash format is `#/<docName>` (see `lib/doc-hash.ts`).
    await page.evaluate(
      (hash: string) => {
        window.location.hash = hash;
      },
      `#/${encodeURIComponent(input.altDocName).replace(/%2F/g, '/')}`,
    );
    // Give the SPA a moment to acknowledge the hash change before we
    // navigate back. 200ms matches the predecessor sweep's
    // hash-change settling window.
    await page.waitForTimeout(200);

    // Navigate BACK to doc A — the provider is cached, so this hits
    // the warm path of sync-promise (warm: true).
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

/**
 * Wait for a mark with the given name + `warm` discriminator to land
 * in the perf ring, then drain its `elapsedMs` prop. Returns null on
 * timeout or missing/non-finite prop. Pure helper used by both the
 * cold-cycle driver and the warm-path spot-check.
 */
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
      // Return the LAST matching mark — closest in time to the wait.
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

/**
 * Pure-function helper to assemble the scaffolded cell-results JSON
 * given a calibration verdict. The scenario writes this to disk; tests
 * exercise the assembly logic without disk I/O.
 */
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

// ---------------------------------------------------------------------------
// Cycle loop, perCycle / perProfile rollups, full cell-results JSON
// ---------------------------------------------------------------------------

/**
 * Per-cycle row in the cell-results JSON. The (mountId, syncElapsedMs,
 * mountElapsedMs) tuple is the substrate for the sync-vs-mount tail
 * attribution differential — computed freely from the per-cycle mark
 * correlation, no OTel required. `serverSpanTimings` /
 * `clientSpanTimings` are populated by the Tempo query when OTel is
 * enabled; null when the LGTM stack isn't running or the cycle's spans
 * didn't arrive within the BatchSpanProcessor flush window.
 */
export interface PerCycleRow {
  readonly mountId: string;
  readonly profile: LatencyProfileName;
  readonly cycleIndex: number;
  readonly syncElapsedMs: number;
  readonly mountElapsedMs: number;
  /** Set to a STOP_IF reason when the cycle was rejected; null on success. */
  readonly rejectedReason: 'pre-sync-disconnect' | 'sync-timeout' | null;
  /**
   * Elapsed of the retry-after-rejection attempt for this cycle. Null
   * when no retry was attempted (the common case). Surfaces in the
   * SYNC methodology's per-profile `retryAfterRejectionMsP99` field.
   */
  readonly retryAfterRejectionMs: number | null;
  /** OTel decomposition timings — populated by the Tempo query. */
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

/** Cycle-loop outcome for a single (profile, cycleIndex) attempt. */
export type CycleOutcome =
  | {
      kind: 'success';
      mountId: string;
      syncElapsedMs: number;
      mountElapsedMs: number;
      /**
       * Elapsed of the retry-after-rejection attempt, when the first
       * sync attempt exceeded the in-app SYNC_TIMEOUT_MS and the
       * driver retried on a fresh context. Absent on healthy cycles
       * (the common case — the first attempt succeeded). Present and
       * finite means the retry succeeded; present and Infinity means
       * the retry also timed out.
       */
      retryAfterRejectionMs?: number;
    }
  | {
      kind: 'rejected';
      mountId: string;
      reason: 'pre-sync-disconnect' | 'sync-timeout';
      /**
       * Elapsed of the retry attempt after a rejected first attempt.
       * Absent when the driver did not retry (rejection was
       * pre-sync-disconnect or the retry path was disabled).
       */
      retryAfterRejectionMs?: number;
    };

/**
 * Per-profile aggregated summary. p50/p95/p99 on the non-rejected
 * sync-elapsed distribution; rejectRate is rejected/total.
 */
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
  /** Bootstrap 95% CI on the sync-elapsed p99 statistic. */
  readonly syncP99BootstrapCi95: BootstrapConfidenceInterval | null;
  /** STOP_IF flags scoped to this profile (e.g., empty-profile). */
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
  /**
   * When `true`, a thrown error from a single profile's loop is captured
   * (the profile is flagged but the sweep continues onto the next
   * profile). When `false`, the first throw aborts the whole sweep.
   * Production sweeps default to `true` (resilient); tests can pass
   * `false` to assert throw-propagation behavior.
   */
  readonly continueOnProfileFailure?: boolean;
  /**
   * Absolute path to a checkpoint file. When set, the cycle loop runs
   * through `withCheckpoint` so a mid-run crash (Bun panic, OS reboot,
   * SIGKILL) leaves prior cycle outcomes durable on disk; a re-run
   * picks up at the first missing input. When unset, the loop runs
   * without persistent state (the smoke-test path).
   *
   * The result's `wasPartialResume` flag distinguishes a fresh run
   * (no prior entries) from a resumed run (at least one prior entry
   * was loaded); the scenario surface bubbles this as a `partial-run`
   * STOP_IF so the engineer reads the partial-completion at flip time.
   */
  readonly checkpointPath?: string;
}

export interface CycleLoopResult {
  readonly perCycle: ReadonlyArray<PerCycleRow>;
  readonly perProfile: ReadonlyArray<PerProfileSummary>;
  /**
   * `true` when at least one cycle outcome was loaded from a prior
   * checkpoint file (i.e., the run is a resume, not a fresh start).
   * `false` for fresh runs and for runs with no checkpoint configured.
   */
  readonly wasPartialResume: boolean;
}

/**
 * Pure-function percentile helper. Returns null on empty input so the
 * caller can distinguish "no measurements" from "all zeros."
 */
export function percentile(samples: ReadonlyArray<number>, p: number): number | null {
  if (samples.length === 0) return null;
  if (p < 0 || p > 1) {
    throw new Error(`percentile: p must be in [0, 1]; got ${p}`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank with linear interpolation — matches what most percentile
  // libraries return; the sweep's distribution is large enough that the
  // choice between nearest-rank variants doesn't move the verdict.
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

/**
 * Build the per-profile summary from a cycle list. Pure function — feeds
 * the cell-results JSON's `perProfile[]` array. Splits out from the
 * cycle-driving loop so tests can exercise it with synthetic per-cycle
 * arrays without a browser.
 */
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
  // BCa CI on the p99 statistic. The default statistic is mean — we pass
  // a custom p99 statistic so the bootstrap correctly resamples for the
  // 99th-percentile rank. Returns null on empty / single-sample arrays
  // (per `bcaConfidenceInterval`'s degenerate-input handling).
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

/**
 * Stable key for a (profile, cycleIndex) pair used by the checkpoint
 * store. The combination is the natural primary key — repeating the
 * same key for distinct inputs is a programmer error that
 * `withCheckpoint` surfaces with a named throw.
 */
function cycleCheckpointKey(input: CycleLoopInput): string {
  return `${input.profile.name}.cycle-${input.cycleIndex}`;
}

interface CycleLoopInput {
  readonly profile: LatencyProfile;
  readonly cycleIndex: number;
}

/**
 * Peek at the entry count of an existing checkpoint without invoking
 * the full `withCheckpoint` machinery. Returns 0 when the file is
 * missing or malformed — the partial-resume detection treats both as
 * "no prior entries." If the checkpoint is structurally broken,
 * `withCheckpoint` itself throws the actionable error a moment later.
 */
function peekCheckpointEntryCount(checkpointPath: string): number {
  if (!existsSync(checkpointPath)) return 0;
  try {
    const raw = readFileSync(checkpointPath, 'utf8');
    const parsed = JSON.parse(raw) as { entries?: ReadonlyArray<unknown> };
    return Array.isArray(parsed.entries) ? parsed.entries.length : 0;
  } catch (err) {
    // Drop-and-continue: structurally broken checkpoint is treated as
    // "no prior entries" so the resume detection cleanly classifies a
    // fresh run. Log so an operator who re-ran after a crash can see
    // why `wasPartialResume` came back false despite expecting a resume.
    console.warn(
      `[sweep] checkpoint at ${checkpointPath} unreadable; treating as empty:`,
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

/**
 * Drive the cycle loop across all profiles. Pure-with-driver — the
 * `driver` arg is the only side-effecting dependency, so production
 * wires Playwright + a dev server while the smoke test injects a
 * synthetic driver. Failures in one profile do NOT abort other
 * profiles when `continueOnProfileFailure` is true (default).
 *
 * When `checkpointPath` is provided, the loop runs through
 * `withCheckpoint` so a mid-run crash leaves prior cycle outcomes
 * durable on disk. The `wasPartialResume` flag in the result is
 * `true` when at least one entry was loaded from a prior run.
 */
export async function runCycleLoop(opts: RunCycleLoopOptions): Promise<CycleLoopResult> {
  const profiles = opts.profiles ?? LATENCY_PROFILES;
  const continueOnFailure = opts.continueOnProfileFailure ?? true;

  // Build a flat input list spanning every (profile, cycleIndex) pair.
  // `withCheckpoint` operates on flat arrays — the per-profile rollup
  // happens after the inputs collapse back into per-cycle rows.
  const inputs: CycleLoopInput[] = [];
  for (const profile of profiles) {
    for (let i = 0; i < opts.cyclesPerProfile; i++) {
      inputs.push({ profile, cycleIndex: i });
    }
  }

  const priorEntryCount =
    opts.checkpointPath !== undefined ? peekCheckpointEntryCount(opts.checkpointPath) : 0;

  // Wrap the driver to convert any throw into a structured rejected
  // outcome (when `continueOnFailure` is on). This makes the operation
  // safe for `withCheckpoint`, which treats throws as fatal — the per-
  // cycle resilience semantics belong to the cycle loop, not the
  // persistence substrate.
  const runOne = async (input: CycleLoopInput): Promise<CycleOutcome> => {
    try {
      return await opts.driver(input);
    } catch (err) {
      if (!continueOnFailure) throw err;
      // Log the actual error before mapping to 'sync-timeout'. The
      // mapping is intentional — withCheckpoint requires a no-throw
      // shape, and the methodology's per-cycle resilience semantics
      // belong here — but the raw err is the only signal of WHY a
      // cycle failed (Playwright crash, CDP drop, OOM, dev server
      // restart). Without this log, all driver throws look like real
      // sync timeouts in the cell-results JSON and inflate the
      // projected reject rate.
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

  // Project outcomes back into PerCycleRow + per-profile rollups.
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
  // Coerce undefined → null so the JSON shape is stable (undefined
  // is dropped by JSON.stringify; null is preserved as an explicit
  // "no retry" signal the engineer reads at flip time).
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

/**
 * Full cell-results JSON shape — extends the scaffold with the per-cycle
 * + per-profile data the sweep captures plus the methodology blocks
 * (SYNC + MOUNT recommendations and differentials rollup).
 */
export interface CellResultsFull {
  readonly schemaVersion: 1;
  readonly scenario: typeof SCENARIO_NAME;
  readonly capturedAt: string;
  readonly calibration: CalibrationVerdict;
  readonly stopIfFlags: ReadonlyArray<StopIfReason>;
  readonly profiles: typeof LATENCY_PROFILES;
  readonly perCycle: ReadonlyArray<PerCycleRow>;
  readonly perProfile: ReadonlyArray<PerProfileSummary>;
  /** SYNC methodology block — populated by `computeSyncMethodology`. */
  readonly syncMethodology?: SyncMethodologyResult;
  /** MOUNT methodology block — populated by `computeMountMethodology`. */
  readonly mountMethodology?: MountMethodologyResult;
  /** Differentials rollup + falsifiability checks — populated by `computeDifferentials`. */
  readonly differentials?: DifferentialsRollup;
  /** Host fingerprint for measurement-context tagging — populated by `detectHostFingerprint`. */
  readonly hostFingerprint?: HostFingerprint;
}

// ---------------------------------------------------------------------------
// Differentials rollup + falsifiability checks
// ---------------------------------------------------------------------------

/**
 * Per-profile differentials. Three metrics:
 *
 * - `serverProcessingShareOfP99`: fraction of the sync p99 attributable
 *   to server-side processing (the `sync.handshake` span timing
 *   divided by the total sync elapsed). High share → server is the
 *   bottleneck; low share → network is.
 *
 * - `providerSetupContaminationMs`: median `ok.provider-pool.open`
 *   span duration. Above the perception floor → the cold-mount path
 *   carries non-trivial setup latency unrelated to the WS handshake.
 *
 * - `syncDominatesMountTailRatio`: ratio of sync.p99 to mount.p99.
 *   Above 0.85 → sync and mount tails are correlated (likely
 *   on the same critical path); below → they're independent and the
 *   methodologies can be tuned separately.
 */
export interface PerProfileDifferentials {
  readonly profile: LatencyProfileName;
  readonly serverProcessingShareOfP99: number | null;
  readonly providerSetupContaminationMs: number | null;
  readonly syncDominatesMountTailRatio: number | null;
}

/**
 * Global falsifiability checks across all profiles. Each check is
 * binary PASS/FAIL — the verdict block at flip time consults these to
 * decide whether the methodology's assumptions hold under the captured
 * data. A FAIL means a documented assumption is violated; the engineer
 * inspects the contributing profile data to decide whether to flip the
 * cap value or re-run the campaign.
 */
export interface GlobalFalsifiabilityChecks {
  readonly deploymentTopologyRobustness: 'PASS' | 'FAIL';
  readonly mountVsSyncTailIndependence: 'PASS' | 'FAIL';
}

export interface DifferentialsRollup {
  readonly perProfile: ReadonlyArray<PerProfileDifferentials>;
  readonly globalFalsifiabilityChecks: GlobalFalsifiabilityChecks;
}

/**
 * Threshold above which `deploymentTopologyRobustness` FAILS for the
 * slow-4g / slow-3g profiles (the "slow" profile band). A
 * server processing share above 50% on a slow profile means the
 * server is the dominant contributor even at high RTT — the cap-vector
 * doesn't generalize to other deployment topologies.
 */
export const DEPLOYMENT_TOPOLOGY_FAIL_THRESHOLD = 0.5;

/**
 * Threshold above which `mountVsSyncTailIndependence` FAILS for any
 * profile. A sync-dominates-mount ratio above 0.85 means sync and
 * mount tails are correlated — the methodologies can't be tuned
 * independently.
 */
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

/**
 * Pure-function differentials rollup. Operates on the per-profile
 * rollups + per-cycle rows (after Tempo enrichment) to compute the
 * three Differential metrics and the two falsifiability checks.
 *
 * Differential E (sync-dominates-mount-tail) is computed FREELY from
 * the mark-histogram mountId correlation — it does NOT require OTel.
 * The other two metrics (serverProcessingShare, providerSetupContamination)
 * require OTel spans; null when serverSpanTimings/clientSpanTimings
 * are unpopulated.
 */
export function computeDifferentials(opts: {
  perProfile: ReadonlyArray<PerProfileSummary>;
  perCycle: ReadonlyArray<PerCycleRow>;
}): DifferentialsRollup {
  const perProfile: PerProfileDifferentials[] = [];

  for (const profile of opts.perProfile) {
    const cyclesForProfile = opts.perCycle.filter(
      (c) => c.profile === profile.profile && c.rejectedReason === null,
    );

    // serverProcessingShareOfP99: requires OTel server spans.
    const serverHandshakeSamples = cyclesForProfile
      .map((c) => c.serverSpanTimings?.syncHandshakeMs)
      .filter((v): v is number => v !== null && v !== undefined);
    const handshakeP99 =
      serverHandshakeSamples.length > 0 ? percentile(serverHandshakeSamples, 0.99) : null;
    const serverProcessingShareOfP99 = safeRatio(handshakeP99, profile.syncElapsedMs.p99);

    // providerSetupContaminationMs: requires OTel client spans.
    const providerOpenSamples = cyclesForProfile
      .map((c) => c.clientSpanTimings?.providerPoolOpenMs)
      .filter((v): v is number => v !== null && v !== undefined);
    const providerSetupContaminationMs =
      providerOpenSamples.length > 0 ? medianNullable(providerOpenSamples) : null;

    // syncDominatesMountTailRatio: from mark-histogram correlation (free).
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

  // Global falsifiability checks.
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

// ---------------------------------------------------------------------------
// Host fingerprint — measurement-context tagging
// ---------------------------------------------------------------------------

/**
 * Host fingerprint for measurement-context tagging. The engineer at
 * Phase E reads this to know which hardware / load profile produced
 * the cell-results JSON. Best-effort attestation via env vars; the
 * canonical host spec for verdict-PR review still comes from the
 * engineer's PR body.
 */
export interface HostFingerprint {
  readonly cpu: string;
  readonly ramGb: number;
  readonly concurrentDevServerLoad: 'idle' | 'active' | 'unknown';
  readonly devServerUptimeMinutes: number | null;
  readonly fixtureDocSizeBytes: number | null;
}

/**
 * Default host-fingerprint env-var bag — keeps the type narrow to the
 * keys the function reads.
 */
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

// ---------------------------------------------------------------------------
// SYNC methodology — failure-rate-target + server-ceiling + BCa
// ---------------------------------------------------------------------------

/**
 * Design levers for the SYNC methodology. Engineer can override any field
 * via the sweep CLI; defaults reflect the documented design band.
 *
 * `safetyMargin` is the multiplier applied to per-profile p99. Range 3-5
 * is the documented band; below 3 risks routine timeouts under transient
 * congestion, above 5 wastes the user's patience floor on a hung sync.
 *
 * `hocuspocusTimeoutMs` is Hocuspocus's own connect/sync timeout — the
 * client-side cap can never exceed this minus a safety margin (the server
 * would close the WS first, producing a confusing pre-sync-disconnect
 * error). `serverCeilingMargin` is the buffer below the Hocuspocus
 * timeout — default 5000 → effective ceiling 55000.
 */
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

/**
 * Per-profile recommendation derived from the captured distribution.
 * The methodology emits BOTH (a) the p99 × safetyMargin multiplier
 * recommendation AND (b) the BCa upper-bound recommendation — the
 * engineer picks the more-conservative of the two (or `max(both)` as
 * an envelope) at flip time.
 */
export interface SyncProfileRecommendation {
  readonly profile: LatencyProfileName;
  readonly p99Ms: number | null;
  /** p99 × safetyMargin clamped to the server ceiling. */
  readonly multiplierRecommendationMs: number | null;
  /** BCa-upper-bound on p99 (the upper edge of the 95% CI). */
  readonly bcaUpperRecommendationMs: number | null;
  readonly preSyncDisconnectRate: number;
  /** Projected reject rate at the multiplier recommendation. */
  readonly projectedRejectRateAtMultiplierCap: number;
  /**
   * Tier 1 input-quality gate: `true` when `preSyncDisconnectRate`
   * exceeds the Tier-1 threshold (default 1%). A `true` value means
   * the profile is breaking the WS handshake rather than slowing it;
   * the SCENARIO surfaces a `sync-tier-1-pre-sync-disconnect-rate-
   * exceeded` STOP_IF at the global level so the operator aborts the
   * campaign and investigates.
   */
  readonly tier1Exceeded: boolean;
  /**
   * Tier 2 output-failure gate: `true` when
   * `projectedRejectRateAtMultiplierCap` exceeds the Tier-2 threshold
   * (default 1%). A `true` value means the recommended cap leaves >1%
   * of cycles above the cap for that profile — the cap is
   * miscalibrated. Campaign continues; the engineer reviews at flip.
   */
  readonly tier2Exceeded: boolean;
  /**
   * p99 of `retryAfterRejectionMs` across this profile's cycles whose
   * first sync attempt exceeded the in-app SYNC_TIMEOUT_MS convention
   * and triggered a retry. Null when no cycles in this profile produced
   * a retry sample (the common case — most healthy profiles never hit
   * the in-app cap).
   */
  readonly retryAfterRejectionMsP99: number | null;
  /** Count of cycles in this profile that produced a retry sample. */
  readonly retryAfterRejectionSampleCount: number;
  /** STOP_IF flags scoped to this profile (subset of the global catalog). */
  readonly stopIfFlags: ReadonlyArray<StopIfReason>;
}

/**
 * Warm-path spot-check on Slow 3G. Compares warm-reopen sync p99 to
 * the cold-mount sync p99 captured during the spot-check workload.
 * `null` ratio/cold/warm fields when no samples were captured (the
 * spot check was skipped or the driver couldn't reach the dev
 * server). `warmTailExceedsCold` is `true` when the ratio exceeds
 * the 2x threshold — flag the assumption violation.
 */
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
  /** Server ceiling = hocuspocusTimeoutMs - serverCeilingMargin. */
  readonly serverCeilingMs: number;
  readonly perProfile: ReadonlyArray<SyncProfileRecommendation>;
  /** Max of per-profile multiplier recommendations, clamped to ceiling. */
  readonly globalMultiplierRecommendationMs: number | null;
  /** Max of per-profile BCa upper bounds, clamped to ceiling. */
  readonly globalBcaUpperRecommendationMs: number | null;
  /**
   * Slow-3g warm-path spot-check. Null when the spot-check workload
   * was not invoked (the smoke-test path, or when the driver returns
   * empty samples). The flag surfaces in `stopIfFlags` as
   * `warm-path-tail-exceeds-cold-tail-on-slow-3g` when fired.
   */
  readonly slow3gWarmPath?: Slow3gWarmPathSpotCheck;
  /** STOP_IF flags scoped to the SYNC methodology output. */
  readonly stopIfFlags: ReadonlyArray<StopIfReason>;
}

/**
 * Tier 1 + Tier 2 reject-rate thresholds. The two-tier check lets the
 * operator distinguish a profile that's BREAKING the WS handshake
 * (tier 1 — abort the campaign) from a profile whose recommended cap
 * still leaves >1% of cycles above the cap (tier 2 — miscalibrated cap;
 * surface but continue).
 */
export const SYNC_REJECT_RATE_TIER_1_THRESHOLD = 0.01;
export const SYNC_REJECT_RATE_TIER_2_THRESHOLD = 0.01;

function clampToCeiling(valueMs: number | null, ceilingMs: number): number | null {
  if (valueMs === null) return null;
  return Math.min(valueMs, ceilingMs);
}

/**
 * Project the cycle-rejection rate at a candidate cap value, given the
 * captured non-rejected sync samples. Counts the fraction of samples
 * whose latency exceeds the cap.
 */
export function projectRejectRateAtCap(syncSamples: ReadonlyArray<number>, capMs: number): number {
  if (syncSamples.length === 0) return 0;
  const above = syncSamples.filter((s) => s > capMs).length;
  return above / syncSamples.length;
}

/**
 * Pure-function SYNC methodology. Operates on the per-profile rollups
 * + per-cycle rows so tests can drive it with synthetic distributions
 * without a browser.
 */
export const SLOW_3G_WARM_PATH_RATIO_THRESHOLD = 2;

export function computeSyncMethodology(opts: {
  perProfile: ReadonlyArray<PerProfileSummary>;
  perCycle: ReadonlyArray<PerCycleRow>;
  levers?: Partial<SyncMethodologyLevers>;
  /**
   * Optional slow-3g warm-path spot-check samples. Cold and warm
   * sample arrays come from `runSlow3gWarmPathSpotCheck` against the
   * dev server. Empty / undefined arrays mean the spot-check was
   * skipped — the methodology omits the `slow3gWarmPath` block in
   * that case.
   */
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

    // Tier 1 + Tier 2 reject-rate checks. The thresholds are strict-
    // greater-than so an exactly-at-threshold profile passes — the
    // engineer's review still sees the rate in the perProfile output.
    const tier1Exceeded = preSyncDisconnectRate > SYNC_REJECT_RATE_TIER_1_THRESHOLD;
    const tier2Exceeded = projectedRejectRate > SYNC_REJECT_RATE_TIER_2_THRESHOLD;

    // Retry aggregation — null-out cycles that didn't produce a retry
    // sample (the common case). The p99 statistic is meaningful only
    // when at least one retry sample exists.
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

  // Globals: max-of-profiles, clamped to ceiling.
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

  // Slow-3g warm-path spot-check rollup. When samples were captured,
  // compute p99 for each side and decide whether the warm tail
  // exceeds the cold tail by more than the threshold. Empty arrays
  // produce an explicit "skipped" result (all-null) so the cell-
  // results JSON makes the gap visible.
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

/**
 * Assemble the full cell-results JSON from calibration + cycle-loop
 * results. Pure function — testable without disk I/O. The disk write
 * happens in the scenario's run() body. SYNC methodology runs when
 * `opts.syncLevers` is provided (or always, with defaults).
 */
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
    /**
     * Slow-3g warm-path spot-check samples — captured by
     * `runSlow3gWarmPathSpotCheck` against the dev server. Folded
     * into the SYNC methodology so the engineer sees the warm-tail
     * vs cold-tail comparison alongside the per-profile rollups.
     */
    readonly slow3gWarmPathSamples?: Slow3gWarmPathSamples;
  },
): CellResultsFull {
  const stopIfFlags: StopIfReason[] = [];
  if (calibration.kind === 'mismatch') {
    stopIfFlags.push(calibration.reason);
  }
  // Partial-run bubbles before the per-profile flags so the operator
  // reads it first in the cell-results JSON. Resume detection happens
  // INSIDE `runCycleLoop` (via the checkpoint entry-count peek), so the
  // flag here is just a relay.
  if (cycleResult.wasPartialResume) {
    stopIfFlags.push('partial-run');
  }
  // Per-profile STOP_IF reasons (empty-profile) bubble up to the
  // top-level flag list so the operator sees one consolidated set at
  // flip time without crawling perProfile[].stopIfFlags.
  for (const profile of cycleResult.perProfile) {
    for (const flag of profile.stopIfFlags) {
      if (!stopIfFlags.includes(flag)) stopIfFlags.push(flag);
    }
  }

  // SYNC methodology — runs by default. Tests that don't care can pass
  // `skipSyncMethodology: true` to keep their assertions narrow.
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

  // MOUNT methodology — runs by default. Same opt-out as SYNC.
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

  // Differentials rollup + falsifiability checks — runs by default.
  let differentials: DifferentialsRollup | undefined;
  if (!opts?.skipDifferentials) {
    differentials = computeDifferentials({
      perProfile: cycleResult.perProfile,
      perCycle: cycleResult.perCycle,
    });
  }

  // Host fingerprint — runs by default. Pass `hostFingerprintEnv` to
  // inject a synthetic env (used by tests that want a deterministic
  // host block in the JSON output).
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

// ---------------------------------------------------------------------------
// LGTM stack pre-flight + Tempo per-cycle enrichment
// ---------------------------------------------------------------------------

/**
 * Discriminated-union result for the LGTM stack pre-flight check.
 * `available` means `docker compose ps` reported the Tempo container
 * up + healthy; `unavailable` carries an actionable operator message.
 */
export type LgtmPreflightResult =
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: 'lgtm-stack-unavailable'; detail: string };

/** Injectable exec shim — production wires `execFileSync`, tests wire a stub. */
export type DockerComposeExec = (args: ReadonlyArray<string>) => string;

/**
 * The expected container name in `docker/otel-dev/docker-compose.yml`.
 * `docker compose ps` returns one row per container; we look for this
 * one and check its STATE field is `running` (or `healthy`).
 */
export const LGTM_TEMPO_CONTAINER_NAME = 'ok-otel-tempo';

/**
 * Parse `docker compose ps --format json` output. Each line is a JSON
 * object with at least `Name` and `State` fields (and usually `Status`).
 * Returns true when the Tempo container is in a running state.
 *
 * Pure function — splits out from the exec boundary so tests can drive
 * partial / malformed output without spawning Docker.
 */
export function isTempoRunning(dockerComposeJsonOutput: string): boolean {
  // `docker compose ps --format json` emits NDJSON (one container per
  // line). An empty stdout means no containers at all — stack is down.
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

/**
 * Run the LGTM stack pre-flight check. Calls `docker compose ps` via
 * the injectable exec; returns a structured verdict so the scenario
 * surface can flag `STOP_IF: lgtm-stack-unavailable` without throwing.
 *
 * Production exec target: `docker compose -f docker/otel-dev/docker-compose.yml ps --format json`.
 * The cwd-relative path resolution happens at the call site; this
 * function does not assume any working directory.
 */
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

/**
 * Production exec — execFileSync without shell. Catches non-zero exit
 * and returns the stdout buffer for the parser. The pre-flight handler
 * upstream translates any spawn error into the unavailable verdict.
 */
export function defaultDockerComposeExec(args: ReadonlyArray<string>): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Discriminated-union result for the OTel collector reachability check.
 * `reachable` means the host's configured OTLP/HTTP endpoint accepted a
 * GET to `/` (or its v1/traces health probe) without a connection error;
 * `unreachable` carries an actionable operator message.
 *
 * Symmetric with LgtmPreflightResult: the LGTM-stack pre-flight confirms
 * `docker compose` reports the Tempo container up, but `docker ps` alone
 * isn't sufficient — the per-process bind on the host port could still
 * be wrong. The OK LGTM stack remaps the collector's OTLP/HTTP port
 * 4318 → host 14318 (to avoid conflicting with other local collectors);
 * a fresh `bun run dev` without `VITE_OTEL_COLLECTOR_URL` set would
 * default to 4318 — the OTel-default port — and silently route traces
 * into the void on a docker daemon where 14318 is the only port bound.
 * The OTLP/HTTP POSTs would fire-and-forget with no error surfaced to
 * the renderer (BatchSpanProcessor logs warnings only at the SDK level).
 * Catch the gap pre-flight rather than discovering it post-campaign.
 */
export type OtelCollectorPreflightResult =
  | { kind: 'reachable' }
  | { kind: 'unreachable'; reason: 'otel-collector-unreachable'; detail: string };

/** Injectable fetch shim — production wires global fetch, tests wire a stub. */
export type OtelCollectorFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Run the OTel collector reachability check. Calls `fetch(<otelBaseUrl>/v1/traces)`
 * with a HEAD-style probe (small timeout) and returns a discriminated-union
 * verdict the sweep can fan into `STOP_IF: otel-collector-unreachable`. The
 * OTel collector's OTLP/HTTP endpoint returns 405 (Method Not Allowed) on
 * GET — that still counts as reachable; what we're checking is whether the
 * port responds at all, not whether a real OTLP request would succeed.
 *
 * Defaults match the canonical OK LGTM stack (`http://localhost:14318`).
 * Operators on a non-default collector pass `otelBaseUrl` explicitly.
 */
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
    // 405 Method Not Allowed is the canonical signal that the collector's
    // OTLP/HTTP endpoint is bound and listening (GET isn't its protocol).
    // 404 / 400 also count as reachable. Connection-refused / DNS errors
    // throw from fetch and surface via the catch below.
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

/**
 * Per-cycle Tempo query → enriched PerCycleRow. The query is injectable
 * (production wires `queryTempoByMountId`; tests wire a stub).
 *
 * Tracks three counters at the per-profile level so the caller can
 * decide whether to abort a profile on >10% missing-spans:
 *   - `enriched`: cycles whose serverSpan/clientSpan timings were
 *     successfully populated.
 *   - `emptyCycles`: cycles whose Tempo query returned no spans
 *     (BSP not flushed yet, or stack not exporting).
 *   - `correlationMissingCycles`: cycles where Tempo returned spans
 *     in the time window but none matched mountId — actionable
 *     operator bug.
 */
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
  /**
   * Window padding around each cycle's measurement. Tempo queries by
   * time-window — too tight risks missing the BSP flush; too wide
   * risks pulling in unrelated traces. Default 5s per side.
   */
  readonly windowPaddingMs?: number;
  /**
   * Reference timestamp for each cycle's window center. v1 uses
   * `Date.now()` at enrichment time minus a fixed offset per cycle
   * index — the exact wall-clock alignment lands when the production
   * driver records per-cycle timestamps. For unit tests, the stub
   * query ignores the window entirely.
   */
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

    // Cycle still goes in the enriched array but with null timings —
    // the perProfile rollup can still compute mark-histogram-based
    // metrics (Differential E) even when OTel decomposition is missing.
    enriched.push({
      ...cycle,
      serverSpanTimings: null,
      clientSpanTimings: null,
    });
  }

  return { enriched, emptyCount, correlationMissingCount, errorCount };
}

/**
 * Per-profile abort threshold. When >10% of a profile's cycles are
 * missing OTel spans, that profile's measurements are unreliable and
 * the rollup flags `tempo-query-empty-for-cycle` at the profile level.
 * The threshold is a constant so a future tuning doesn't drift the
 * test fixtures.
 */
export const TEMPO_PROFILE_ABORT_THRESHOLD = 0.1;

/**
 * Pure-function classifier — given per-profile cycle counts, returns
 * the STOP_IF flags to surface in the profile's `stopIfFlags` array.
 * Splits out from the orchestration so the threshold logic is tested
 * in isolation.
 */
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

// ---------------------------------------------------------------------------
// MOUNT methodology — kneedle bounded by Nielsen-Norman
// ---------------------------------------------------------------------------

/**
 * Design levers for the MOUNT methodology. NN_floor and NN_ceiling are
 * the Nielsen-Norman psychological perception bounds — below 3000ms a
 * UI feels responsive without explicit progress feedback; above 10000ms
 * users disengage. The kneedle inflection on the aggregated mount-time
 * CDF tells us where the distribution's tail starts; clamping it to
 * [3000, 10000] keeps the cap within the perception band even when
 * the inflection lands outside.
 */
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
  /** Pre-clamp kneedle inflection (in ms). NaN when degenerate. */
  readonly inflectionMs: number;
  /** Post-clamp recommended cap. NaN when no samples. */
  readonly recommendedCapMs: number;
  /** Which bound applied: 'floor' if clamped up, 'ceiling' if clamped down, 'none' if natural. */
  readonly clamp: 'floor' | 'ceiling' | 'none';
  readonly stopIfFlags: ReadonlyArray<StopIfReason>;
  /** Per-profile reject rates for input-quality validation. */
  readonly perProfileRejectRates: ReadonlyArray<{
    readonly profile: LatencyProfileName;
    readonly rejectRate: number;
  }>;
  /**
   * Number of profiles whose contributed samples ALL fall below the NN
   * floor. >1 triggers the `NN-floor-clamp-multiple-profiles` STOP_IF —
   * indicates multiple profiles have mount times so fast that the
   * methodology's input isn't probing the perception band.
   */
  readonly nnFloorContributingProfileCount: number;
}

/**
 * Build a cumulative distribution function (CDF) from a sample array.
 * Output is sorted (x, y) where x = unique sample value, y = fraction
 * of samples ≤ x. Returns empty array on empty input.
 *
 * Pure function. The MOUNT methodology runs kneedle on this CDF curve.
 */
export function buildMountTimeCdf(samples: ReadonlyArray<number>): Array<{ x: number; y: number }> {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => a - b);
  const cdf: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const x = sorted[i];
    if (x === undefined) continue;
    // Skip duplicate x — keep the last (highest) cumulative y at each x.
    if (i + 1 < sorted.length && sorted[i + 1] === x) continue;
    cdf.push({ x, y: (i + 1) / sorted.length });
  }
  return cdf;
}

/**
 * Pure-function MOUNT methodology. Aggregates non-rejected mount-time
 * samples across ALL profiles (the affordance is global per-user; one
 * threshold serves all conditions), builds the CDF, runs kneedle for
 * the inflection, clamps to NN bounds.
 *
 * Degenerate handling:
 *   - Empty samples → recommendedCapMs falls back to the NN ceiling;
 *     flag `kneedle-degenerate` so the operator sees the loud fallback.
 *   - findKnee returns non-finite or LOW-confidence-at-boundary →
 *     same fallback path. The NN ceiling is psychologically defensible
 *     (Nielsen 1993 attention-loss boundary) — never returning a NaN
 *     means the cell-results JSON always has a usable number.
 */
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

  // Aggregate mount samples across all non-rejected cycles.
  const allMountSamples: number[] = [];
  for (const cycle of opts.perCycle) {
    if (cycle.rejectedReason === null) {
      allMountSamples.push(cycle.mountElapsedMs);
    }
  }

  // Empty samples → degenerate path.
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

  // NN-floor-clamp-multiple-profiles input-quality check: count profiles
  // whose entire mount distribution sits below the NN floor. The check
  // operates on per-profile samples so a profile with 1 fast outlier
  // doesn't get flagged.
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

  // Degenerate detection: kneedle returns x=0 / non-finite / LOW-confidence
  // with the inflection at a boundary point. The boundary check is
  // important — kneedle on a uniform distribution returns the midpoint
  // x but with LOW confidence; the methodology should fall back to NN
  // ceiling in that case.
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

// ---------------------------------------------------------------------------
// Production driver
// ---------------------------------------------------------------------------

/** Per-cycle wall-clock budget for the production driver, in ms.
 *  Covers navigation + cold-sync wait. Padding above the in-app
 *  `SYNC_TIMEOUT_MS` (30000) so the test driver's timeout doesn't fire
 *  BEFORE the in-app sync-timeout — otherwise the driver records a
 *  `sync-timeout` cycle when the in-app code would have rejected
 *  with the same reason a moment later. Padding keeps the in-app code
 *  the source of timeout truth.
 */
const PRODUCTION_CYCLE_TIMEOUT_MS = 45_000;

/**
 * Production driver retries the cycle ONCE on sync-timeout. The retry
 * runs on a fresh BrowserContext so it tests the retry-after-rejection
 * path the production UX surfaces. The retry timeout shares the
 * primary budget — long enough to land a slow-but-eventually-syncing
 * doc but short enough to keep the campaign on its 40-60 min budget.
 */
const PRODUCTION_RETRY_TIMEOUT_MS = PRODUCTION_CYCLE_TIMEOUT_MS;

/**
 * Build a production cycle driver bound to a launched Playwright
 * Browser + base target URL. The returned driver is what `runCycleLoop`
 * invokes for each (profile, cycleIndex) pair. Production sweeps run
 * via the OK `bun run sweep:convention-cap-graduation` entry point;
 * tests inject a synthetic driver instead.
 *
 * On a first-attempt sync-timeout, the driver retries ONCE on a
 * fresh context and records the retry's elapsed as
 * `retryAfterRejectionMs`. The methodology aggregates these into
 * `retryAfterRejectionMsP99` per profile so the engineer sees the
 * actual retry-tail at flip time. A pre-sync-disconnect first attempt
 * does NOT trigger a retry — those failures are connection-level and
 * a retry would face the same shaping issue.
 */
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

    // Retry-after-rejection runs only on a true sync-timeout. A
    // pre-sync-disconnect indicates the shaping or transport is
    // unhealthy; a retry against the same shaping would face the
    // same failure mode and pollute the retry distribution.
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
      // Surface the retry elapsed regardless of the retry's outcome —
      // an unbounded retry tail is part of the user's experience.
      // When the retry SUCCEEDED we still report the original outcome
      // as rejected (the cycle is one logical user action — the retry
      // is the same action's second attempt) but with the retry timing.
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

/**
 * Production Tempo query — wraps `queryTempoByMountId` from
 * `tempo-client.ts`. Adapts the signature so the cycle enricher's
 * injection point stays narrow.
 */
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
    // LGTM stack pre-flight — fail fast when the OTel substrate is
    // not running. The Tempo enrichment downstream depends on the
    // stack; running the sweep without it would produce a cell-results
    // JSON with every cycle's spanTimings null — wasted operator time.
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

    // OTel collector reachability pre-flight — `docker compose ps`
    // reports the container up, but doesn't confirm the host port is
    // bound and accepting OTLP/HTTP. The OK stack remaps 4318 → 14318;
    // a fresh `bun run dev` without VITE_OTEL_COLLECTOR_URL set would
    // (historically) default to :4318 and silently route traces into
    // the void. Verify the canonical port responds before measuring.
    // The base URL matches `telemetry-impl.ts`'s default; operators on
    // a non-default collector can rely on VITE_OTEL_COLLECTOR_URL to
    // override the renderer's exporter target but the pre-flight here
    // probes the canonical port — operators on a non-default port
    // must also reconfigure the docker-compose remap to match.
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

    // Calibration — bail loud if shaping is not faithful before
    // measuring any cycle.
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

    // Cycle loop — driven against the live dev server. Resumable via
    // a checkpoint file under the scenario's outDir so a mid-run crash
    // doesn't force a re-run from cycle 0.
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

    // Tempo enrichment — fold OTel decomposition into perCycle rows.
    const tempoEnriched = await enrichCyclesWithTempo({
      cycles: cycleResult.perCycle,
      query: productionTempoQuery,
    });
    const finalCycleResult: CycleLoopResult = {
      perCycle: tempoEnriched.enriched,
      perProfile: cycleResult.perProfile,
      wasPartialResume: cycleResult.wasPartialResume,
    };

    // Slow-3g warm-path spot-check — runs a small workload AFTER the
    // main cycle loop completes. Pattern A (fresh-context-per-cycle)
    // intentionally only measures cold mounts; this spot-check
    // complements it by checking the warm-path assumption that
    // warm-reopen is synchronous-or-near-zero. A warm tail dominating
    // the cold tail would invalidate the cap's failure-rate target.
    let slow3gWarmPathSamples: Slow3gWarmPathSamples | undefined;
    try {
      slow3gWarmPathSamples = await runSlow3gWarmPathSpotCheck({
        browser: ctx.browser,
        baseTarget: ctx.opts.target,
      });
      ctx.recordMetric('sweep.slow3gWarmPathColdSamples', slow3gWarmPathSamples.coldMs.length);
      ctx.recordMetric('sweep.slow3gWarmPathWarmSamples', slow3gWarmPathSamples.warmMs.length);
    } catch (err) {
      // Spot-check failure does NOT abort the campaign — the main
      // cell-results are still valuable. Surface on two channels: a
      // `ctx.note()` so the engineer sees it at flip time (persisted
      // into the cell-results JSON's notes), AND a live console.warn
      // so a live tail of the sweep log catches it during the run.
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
