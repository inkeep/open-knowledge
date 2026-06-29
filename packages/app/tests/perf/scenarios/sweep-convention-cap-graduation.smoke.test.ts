
import { describe, expect, test } from 'bun:test';
import type { TempoQueryResult } from '../lib/tempo-client';
import {
  analyzeCalibration,
  buildFullCellResults,
  buildPerProfileSummary,
  buildScaffoldCellResults,
  CALIBRATION_DIVERGENCE_RATIO_THRESHOLD,
  type CalibrationSamples,
  type CycleDriver,
  type CycleOutcome,
  checkLgtmStackPreflight,
  checkOtelCollectorReachable,
  classifyProfileTempoHealth,
  enrichCyclesWithTempo,
  getLatencyProfile,
  isTempoRunning,
  LATENCY_PROFILES,
  type LatencyProfileName,
  LGTM_TEMPO_CONTAINER_NAME,
  type PerCycleRow,
  type PerProfileSummary,
  percentile,
  runCycleLoop,
  SCENARIO_NAME,
  TEMPO_PROFILE_ABORT_THRESHOLD,
  type TempoQueryFn,
} from './sweep-convention-cap-graduation';


describe('LATENCY_PROFILES', () => {
  test('has exactly 5 profiles', () => {
    expect(LATENCY_PROFILES.length).toBe(5);
  });

  test('profile names match the documented set in canonical order', () => {
    const names = LATENCY_PROFILES.map((p) => p.name);
    expect(names).toEqual(['localhost', 'fast-wifi', 'cafe-lte', 'slow-4g', 'slow-3g']);
  });

  test('latencyMs is monotonically non-decreasing across the band', () => {
    for (let i = 1; i < LATENCY_PROFILES.length; i++) {
      const prev = LATENCY_PROFILES[i - 1];
      const cur = LATENCY_PROFILES[i];
      if (!prev || !cur) continue;
      expect(cur.latencyMs).toBeGreaterThanOrEqual(prev.latencyMs);
    }
  });

  test('localhost has zero latency + zero throttling', () => {
    const local = getLatencyProfile('localhost');
    expect(local.latencyMs).toBe(0);
    expect(local.downloadKbps).toBe(0);
    expect(local.uploadKbps).toBe(0);
  });

  test('slow-3g matches WPT canonical 2000ms RTT', () => {
    const slow3g = getLatencyProfile('slow-3g');
    expect(slow3g.latencyMs).toBe(2000);
  });

  test('slow-4g matches WPT canonical 562ms RTT', () => {
    const slow4g = getLatencyProfile('slow-4g');
    expect(slow4g.latencyMs).toBe(562);
  });

  test('getLatencyProfile throws on unknown name', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate invalid input to exercise the throw arm
    expect(() => getLatencyProfile('bogus' as any as LatencyProfileName)).toThrow(
      /unknown latency profile/,
    );
  });
});


function uniformSamples(count: number, value: number): number[] {
  return Array.from({ length: count }, () => value);
}

describe('analyzeCalibration', () => {
  test('returns ok when CDP and routeWebSocket medians match within tolerance', () => {
    const samples: CalibrationSamples = {
      cdpLocalhostMs: uniformSamples(10, 2),
      routeWebSocketLocalhostMs: uniformSamples(10, 2.5),
      cdpSlow3gMs: uniformSamples(10, 2010),
      routeWebSocketSlow3gMs: uniformSamples(10, 2030),
    };
    const verdict = analyzeCalibration(samples);
    expect(verdict.kind).toBe('ok');
    if (verdict.kind === 'ok') {
      expect(verdict.medians.cdpSlow3gMedianMs).toBe(2010);
    }
  });

  test('flags throttling-method-mismatch when slow-3g medians diverge >1.5x', () => {
    const samples: CalibrationSamples = {
      cdpLocalhostMs: uniformSamples(10, 2),
      routeWebSocketLocalhostMs: uniformSamples(10, 2),
      cdpSlow3gMs: uniformSamples(10, 2000),
      routeWebSocketSlow3gMs: uniformSamples(10, 4000),
    };
    const verdict = analyzeCalibration(samples);
    expect(verdict.kind).toBe('mismatch');
    if (verdict.kind === 'mismatch') {
      expect(verdict.reason).toBe('throttling-method-mismatch');
      expect(verdict.divergenceRatio).toBeGreaterThan(CALIBRATION_DIVERGENCE_RATIO_THRESHOLD);
      expect(verdict.detail).toMatch(/2\.\d+/); // includes the actual ratio
    }
  });

  test('flags mismatch on empty sample arrays (non-finite medians)', () => {
    const samples: CalibrationSamples = {
      cdpLocalhostMs: [],
      routeWebSocketLocalhostMs: [],
      cdpSlow3gMs: [],
      routeWebSocketSlow3gMs: [],
    };
    const verdict = analyzeCalibration(samples);
    expect(verdict.kind).toBe('mismatch');
    if (verdict.kind === 'mismatch') {
      expect(verdict.reason).toBe('throttling-method-mismatch');
      expect(verdict.detail).toMatch(/non-finite/);
    }
  });

  test('localhost-only divergence above 1.5x still flags mismatch', () => {
    const samples: CalibrationSamples = {
      cdpLocalhostMs: uniformSamples(10, 2),
      routeWebSocketLocalhostMs: uniformSamples(10, 10),
      cdpSlow3gMs: uniformSamples(10, 2010),
      routeWebSocketSlow3gMs: uniformSamples(10, 2020),
    };
    const verdict = analyzeCalibration(samples);
    expect(verdict.kind).toBe('mismatch');
    if (verdict.kind === 'mismatch') {
      expect(verdict.divergenceRatio).toBeGreaterThan(CALIBRATION_DIVERGENCE_RATIO_THRESHOLD);
    }
  });
});


describe('buildScaffoldCellResults', () => {
  test('emits scenario name + schemaVersion + profile list', () => {
    const result = buildScaffoldCellResults({
      kind: 'ok',
      medians: {
        cdpLocalhostMedianMs: 2,
        cdpSlow3gMedianMs: 2000,
        routeWebSocketLocalhostMedianMs: 2,
        routeWebSocketSlow3gMedianMs: 2010,
      },
    });
    expect(result.scenario).toBe(SCENARIO_NAME);
    expect(result.schemaVersion).toBe(1);
    expect(result.profiles).toEqual(LATENCY_PROFILES);
  });

  test('stopIfFlags is empty on a successful calibration', () => {
    const result = buildScaffoldCellResults({
      kind: 'ok',
      medians: {
        cdpLocalhostMedianMs: 2,
        cdpSlow3gMedianMs: 2000,
        routeWebSocketLocalhostMedianMs: 2,
        routeWebSocketSlow3gMedianMs: 2010,
      },
    });
    expect(result.stopIfFlags).toEqual([]);
  });

  test('stopIfFlags includes throttling-method-mismatch on a failed calibration', () => {
    const result = buildScaffoldCellResults({
      kind: 'mismatch',
      reason: 'throttling-method-mismatch',
      detail: 'CDP vs routeWebSocket median ratio 2.00 exceeds threshold 1.5',
      medians: {
        cdpLocalhostMedianMs: 2,
        cdpSlow3gMedianMs: 2000,
        routeWebSocketLocalhostMedianMs: 2,
        routeWebSocketSlow3gMedianMs: 4000,
      },
      divergenceRatio: 2.0,
    });
    expect(result.stopIfFlags).toContain('throttling-method-mismatch');
  });
});


describe('percentile', () => {
  test('returns null on empty input', () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  test('returns the only sample for single-element input', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
  });

  test('p50 of a sorted set is the median', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  test('p99 lands near the tail', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(samples, 0.99)).toBe(99.01);
  });

  test('throws on out-of-range p', () => {
    expect(() => percentile([1, 2, 3], 1.5)).toThrow(/p must be in/);
    expect(() => percentile([1, 2, 3], -0.1)).toThrow(/p must be in/);
  });
});


function makeSyntheticDriver(opts: {
  syncMsByProfile?: Partial<Record<LatencyProfileName, number>>;
  mountMsByProfile?: Partial<Record<LatencyProfileName, number>>;
  rejectAt?: ReadonlyArray<number>; // cycle indices that should be rejected
}): CycleDriver {
  return async ({ profile, cycleIndex }) => {
    const rejectAt = opts.rejectAt ?? [];
    if (rejectAt.includes(cycleIndex)) {
      const outcome: CycleOutcome = {
        kind: 'rejected',
        mountId: `mid-${profile.name}-${cycleIndex}`,
        reason: 'sync-timeout',
      };
      return outcome;
    }
    const syncMs = opts.syncMsByProfile?.[profile.name] ?? profile.latencyMs + 10;
    const mountMs = opts.mountMsByProfile?.[profile.name] ?? 30;
    const outcome: CycleOutcome = {
      kind: 'success',
      mountId: `mid-${profile.name}-${cycleIndex}`,
      syncElapsedMs: syncMs + cycleIndex, // adds a little spread per cycle
      mountElapsedMs: mountMs + cycleIndex * 0.5,
    };
    return outcome;
  };
}

describe('runCycleLoop', () => {
  test('a 2-cycle minimal run produces a well-formed cell-results JSON shape', async () => {
    const driver = makeSyntheticDriver({});
    const result = await runCycleLoop({ driver, cyclesPerProfile: 2 });
    expect(result.perCycle.length).toBe(LATENCY_PROFILES.length * 2);
    expect(result.perProfile.length).toBe(LATENCY_PROFILES.length);

    for (const profile of result.perProfile) {
      expect(profile.samples).toBe(2);
      expect(profile.rejectedCount).toBe(0);
      expect(profile.stopIfFlags).toEqual([]);
      expect(profile.syncElapsedMs.p50).toBeGreaterThan(0);
    }

    const first = result.perCycle[0];
    expect(first).toBeDefined();
    expect(first?.mountId).toMatch(/^mid-/);
    expect(first?.syncElapsedMs).toBeGreaterThan(0);
    expect(first?.mountElapsedMs).toBeGreaterThan(0);
    expect(first?.rejectedReason).toBeNull();
  });

  test('per-profile rollup computes p50/p95/p99 from the non-rejected samples', async () => {
    const driver: CycleDriver = async ({ profile, cycleIndex }) => ({
      kind: 'success',
      mountId: `mid-${profile.name}-${cycleIndex}`,
      syncElapsedMs: cycleIndex + 1, // 1..5
      mountElapsedMs: 30,
    });
    const result = await runCycleLoop({
      driver,
      cyclesPerProfile: 5,
      profiles: [getLatencyProfile('localhost')],
    });
    const profile = result.perProfile[0];
    expect(profile?.syncElapsedMs.p50).toBe(3);
    expect(profile?.syncElapsedMs.p95).toBeCloseTo(4.8, 2);
    expect(profile?.syncElapsedMs.p99).toBeCloseTo(4.96, 2);
  });

  test('empty-profile flag fires when all cycles in a profile are rejected', async () => {
    const driver = makeSyntheticDriver({ rejectAt: [0, 1, 2, 3, 4] });
    const result = await runCycleLoop({
      driver,
      cyclesPerProfile: 5,
      profiles: [getLatencyProfile('localhost')],
    });
    const profile = result.perProfile[0];
    expect(profile?.samples).toBe(0);
    expect(profile?.rejectedCount).toBe(5);
    expect(profile?.rejectRate).toBe(1);
    expect(profile?.stopIfFlags).toContain('empty-profile');
  });

  test('a single profile throwing does not abort other profiles (continueOnProfileFailure=true)', async () => {
    let callCount = 0;
    const driver: CycleDriver = async ({ profile, cycleIndex }) => {
      callCount += 1;
      if (profile.name === 'slow-3g' && cycleIndex === 0) {
        throw new Error('synthetic driver failure');
      }
      return {
        kind: 'success',
        mountId: `mid-${profile.name}-${cycleIndex}`,
        syncElapsedMs: profile.latencyMs + 10,
        mountElapsedMs: 30,
      };
    };
    const result = await runCycleLoop({
      driver,
      cyclesPerProfile: 2,
    });
    expect(result.perProfile.length).toBe(LATENCY_PROFILES.length);
    const slow3g = result.perProfile.find((p) => p.profile === 'slow-3g');
    expect(slow3g?.rejectedCount).toBe(1);
    expect(slow3g?.samples).toBe(1);
    expect(callCount).toBe(10);
  });

  test('continueOnProfileFailure=false propagates the first throw', async () => {
    const driver: CycleDriver = async () => {
      throw new Error('synthetic abort');
    };
    await expect(
      runCycleLoop({ driver, cyclesPerProfile: 1, continueOnProfileFailure: false }),
    ).rejects.toThrow(/synthetic abort/);
  });
});

describe('buildPerProfileSummary — direct unit test', () => {
  test('p99 BCa CI is computed when there are 2+ non-rejected samples', () => {
    const rows: PerCycleRow[] = Array.from({ length: 20 }, (_, i) => ({
      mountId: `mid-${i}`,
      profile: 'localhost' as LatencyProfileName,
      cycleIndex: i,
      syncElapsedMs: 10 + i,
      mountElapsedMs: 30,
      rejectedReason: null,
      serverSpanTimings: null,
      clientSpanTimings: null,
    }));
    const summary = buildPerProfileSummary(getLatencyProfile('localhost'), rows);
    expect(summary.syncP99BootstrapCi95).not.toBeNull();
    if (summary.syncP99BootstrapCi95) {
      expect(summary.syncP99BootstrapCi95.estimate).toBeGreaterThan(0);
      expect(summary.syncP99BootstrapCi95.lo).toBeLessThanOrEqual(summary.syncP99BootstrapCi95.hi);
      expect(summary.syncP99BootstrapCi95.lo).toBeLessThanOrEqual(
        summary.syncP99BootstrapCi95.estimate,
      );
      expect(summary.syncP99BootstrapCi95.estimate).toBeLessThanOrEqual(
        summary.syncP99BootstrapCi95.hi,
      );
    }
  });

  test('p99 BCa CI is null when fewer than 2 non-rejected samples', () => {
    const summary = buildPerProfileSummary(getLatencyProfile('localhost'), []);
    expect(summary.syncP99BootstrapCi95).toBeNull();
    expect(summary.samples).toBe(0);
    expect(summary.stopIfFlags).toContain('empty-profile');
  });
});

describe('buildFullCellResults — JSON assembly', () => {
  test('bubbles empty-profile STOP_IF flags from perProfile up to the top level', async () => {
    const driver: CycleDriver = async ({ profile, cycleIndex }) => {
      if (profile.name === 'slow-3g') {
        return { kind: 'rejected', mountId: `mid-${cycleIndex}`, reason: 'sync-timeout' };
      }
      return {
        kind: 'success',
        mountId: `mid-${profile.name}-${cycleIndex}`,
        syncElapsedMs: profile.latencyMs + 10,
        mountElapsedMs: 30,
      };
    };
    const cycleResult = await runCycleLoop({ driver, cyclesPerProfile: 2 });
    const full = buildFullCellResults(
      {
        kind: 'ok',
        medians: {
          cdpLocalhostMedianMs: 2,
          cdpSlow3gMedianMs: 2000,
          routeWebSocketLocalhostMedianMs: 2,
          routeWebSocketSlow3gMedianMs: 2010,
        },
      },
      cycleResult,
    );
    expect(full.stopIfFlags).toContain('empty-profile');
    expect(full.schemaVersion).toBe(1);
    expect(full.scenario).toBe(SCENARIO_NAME);
    expect(full.perCycle.length).toBe(LATENCY_PROFILES.length * 2);
    expect(full.perProfile.length).toBe(LATENCY_PROFILES.length);
  });

  test('JSON-serializes round-trip cleanly', async () => {
    const driver = makeSyntheticDriver({});
    const cycleResult = await runCycleLoop({
      driver,
      cyclesPerProfile: 2,
      profiles: [getLatencyProfile('localhost')],
    });
    const full = buildFullCellResults(
      {
        kind: 'ok',
        medians: {
          cdpLocalhostMedianMs: 2,
          cdpSlow3gMedianMs: 2000,
          routeWebSocketLocalhostMedianMs: 2,
          routeWebSocketSlow3gMedianMs: 2010,
        },
      },
      cycleResult,
    );
    const json = JSON.stringify(full);
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.perCycle.length).toBe(2);
  });
});


describe('isTempoRunning', () => {
  test('returns true when the Tempo container row is present and running', () => {
    const ndjson = `{"Name":"${LGTM_TEMPO_CONTAINER_NAME}","State":"running","Status":"Up 5 minutes"}
{"Name":"ok-otel-grafana","State":"running","Status":"Up 5 minutes"}`;
    expect(isTempoRunning(ndjson)).toBe(true);
  });

  test('returns false when the Tempo container is exited / not running', () => {
    const ndjson = `{"Name":"${LGTM_TEMPO_CONTAINER_NAME}","State":"exited","Status":"Exited (1) 5 seconds ago"}`;
    expect(isTempoRunning(ndjson)).toBe(false);
  });

  test('returns false when the output has no containers at all', () => {
    expect(isTempoRunning('')).toBe(false);
    expect(isTempoRunning('\n\n')).toBe(false);
  });

  test('tolerates non-JSON noise mixed into the stream', () => {
    const noisy = `WARN[0000] some upstream warning
{"Name":"${LGTM_TEMPO_CONTAINER_NAME}","State":"running"}
not-json-blob`;
    expect(isTempoRunning(noisy)).toBe(true);
  });
});

describe('checkLgtmStackPreflight', () => {
  test('returns available when docker compose ps shows Tempo running', async () => {
    const result = await checkLgtmStackPreflight({
      exec: () => `{"Name":"${LGTM_TEMPO_CONTAINER_NAME}","State":"running"}\n`,
    });
    expect(result.kind).toBe('available');
  });

  test('returns lgtm-stack-unavailable with operator message when stack is down', async () => {
    const result = await checkLgtmStackPreflight({
      exec: () => '', // empty ps output — stack down
    });
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('lgtm-stack-unavailable');
      expect(result.detail).toMatch(/docker compose up -d/);
      expect(result.detail).toContain('docker/otel-dev');
    }
  });

  test('returns lgtm-stack-unavailable when docker exec throws', async () => {
    const result = await checkLgtmStackPreflight({
      exec: () => {
        throw new Error('docker: command not found');
      },
    });
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('lgtm-stack-unavailable');
      expect(result.detail).toMatch(/docker compose ps failed/);
      expect(result.detail).toMatch(/docker compose up -d/);
    }
  });
});

describe('checkOtelCollectorReachable', () => {
  test('returns reachable on HTTP 405 (collector bound, GET not its protocol)', async () => {
    const result = await checkOtelCollectorReachable({
      otelBaseUrl: 'http://localhost:14318',
      fetchFn: async () => ({ ok: false, status: 405 }),
    });
    expect(result.kind).toBe('reachable');
  });

  test('returns reachable on HTTP 200 (some collectors return 200 on health probe)', async () => {
    const result = await checkOtelCollectorReachable({
      otelBaseUrl: 'http://localhost:14318',
      fetchFn: async () => ({ ok: true, status: 200 }),
    });
    expect(result.kind).toBe('reachable');
  });

  test('returns otel-collector-unreachable on fetch throw (connection refused / DNS fail)', async () => {
    const result = await checkOtelCollectorReachable({
      otelBaseUrl: 'http://localhost:14318',
      fetchFn: async () => {
        throw new Error('fetch failed: ECONNREFUSED');
      },
    });
    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') {
      expect(result.reason).toBe('otel-collector-unreachable');
      expect(result.detail).toMatch(/VITE_OTEL_COLLECTOR_URL/);
      expect(result.detail).toMatch(/14318/);
    }
  });

  test('returns otel-collector-unreachable on unexpected non-4xx (e.g. 500)', async () => {
    const result = await checkOtelCollectorReachable({
      otelBaseUrl: 'http://localhost:14318',
      fetchFn: async () => ({ ok: false, status: 500 }),
    });
    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') {
      expect(result.reason).toBe('otel-collector-unreachable');
      expect(result.detail).toMatch(/HTTP 500/);
    }
  });

  test('respects custom otelBaseUrl in the probe URL', async () => {
    let probedUrl = '';
    await checkOtelCollectorReachable({
      otelBaseUrl: 'http://collector.example:9999',
      fetchFn: async (url) => {
        probedUrl = url;
        return { ok: false, status: 405 };
      },
    });
    expect(probedUrl).toBe('http://collector.example:9999/v1/traces');
  });
});

describe('classifyProfileTempoHealth', () => {
  test('no flags when totalCycles is 0', () => {
    const flags = classifyProfileTempoHealth({
      totalCycles: 0,
      emptyCount: 0,
      correlationMissingCount: 0,
    });
    expect(flags).toEqual([]);
  });

  test('flags tempo-query-empty-for-cycle when emptyRatio > 10%', () => {
    const flags = classifyProfileTempoHealth({
      totalCycles: 50,
      emptyCount: 6,
      correlationMissingCount: 0,
    });
    expect(flags).toContain('tempo-query-empty-for-cycle');
    const flagsAtBoundary = classifyProfileTempoHealth({
      totalCycles: 50,
      emptyCount: 5,
      correlationMissingCount: 0,
    });
    expect(flagsAtBoundary).not.toContain('tempo-query-empty-for-cycle');
  });

  test('flags mountid-span-correlation-missing on ANY correlation-missing cycle', () => {
    const flags = classifyProfileTempoHealth({
      totalCycles: 50,
      emptyCount: 0,
      correlationMissingCount: 1,
    });
    expect(flags).toContain('mountid-span-correlation-missing');
  });

  test('threshold constant matches the documented 10%', () => {
    expect(TEMPO_PROFILE_ABORT_THRESHOLD).toBe(0.1);
  });
});

describe('enrichCyclesWithTempo', () => {
  function makeCycle(mountId: string): PerCycleRow {
    return {
      mountId,
      profile: 'localhost' as LatencyProfileName,
      cycleIndex: 0,
      syncElapsedMs: 10,
      mountElapsedMs: 30,
      rejectedReason: null,
      serverSpanTimings: null,
      clientSpanTimings: null,
    };
  }

  test('populates server + client span timings on success', async () => {
    const successResult: TempoQueryResult = {
      kind: 'success',
      serverSpanTimings: { syncHandshakeMs: 5, persistenceLoadMs: 3 },
      clientSpanTimings: {
        coldMountMs: 200,
        providerPoolOpenMs: 4,
        mountPromiseMs: 40,
        syncPromiseMs: 190,
      },
    };
    const query: TempoQueryFn = async () => successResult;
    const out = await enrichCyclesWithTempo({
      cycles: [makeCycle('mid-1')],
      query,
    });
    expect(out.enriched.length).toBe(1);
    expect(out.enriched[0]?.serverSpanTimings).toEqual({
      syncHandshakeMs: 5,
      persistenceLoadMs: 3,
    });
    expect(out.enriched[0]?.clientSpanTimings?.coldMountMs).toBe(200);
    expect(out.emptyCount).toBe(0);
    expect(out.correlationMissingCount).toBe(0);
  });

  test('counts empty results and leaves timings null', async () => {
    const query: TempoQueryFn = async () => ({ kind: 'empty' });
    const out = await enrichCyclesWithTempo({
      cycles: [makeCycle('mid-1'), makeCycle('mid-2')],
      query,
    });
    expect(out.emptyCount).toBe(2);
    expect(out.enriched[0]?.serverSpanTimings).toBeNull();
    expect(out.enriched[1]?.clientSpanTimings).toBeNull();
  });

  test('counts correlation-missing results separately from empty', async () => {
    const query: TempoQueryFn = async () => ({ kind: 'correlation-missing' });
    const out = await enrichCyclesWithTempo({
      cycles: [makeCycle('mid-cm')],
      query,
    });
    expect(out.correlationMissingCount).toBe(1);
    expect(out.emptyCount).toBe(0);
    expect(out.enriched[0]?.serverSpanTimings).toBeNull();
  });

  test('counts error results separately', async () => {
    const query: TempoQueryFn = async () => ({ kind: 'error', reason: 'http 500' });
    const out = await enrichCyclesWithTempo({
      cycles: [makeCycle('mid-err')],
      query,
    });
    expect(out.errorCount).toBe(1);
  });

  test('passes per-cycle window when cycleTimestampMs is provided', async () => {
    const seen: Array<{ startTimeMs: number; endTimeMs: number }> = [];
    const query: TempoQueryFn = async (input) => {
      seen.push({ startTimeMs: input.startTimeMs, endTimeMs: input.endTimeMs });
      return { kind: 'empty' };
    };
    const center = 1_700_000_000_000;
    await enrichCyclesWithTempo({
      cycles: [makeCycle('mid-w'), makeCycle('mid-w2')],
      query,
      cycleTimestampMs: [center, center + 1000],
      windowPaddingMs: 2000,
    });
    expect(seen.length).toBe(2);
    expect(seen[0]).toEqual({ startTimeMs: center - 2000, endTimeMs: center + 2000 });
    expect(seen[1]).toEqual({ startTimeMs: center - 1000, endTimeMs: center + 3000 });
  });
});


import {
  computeSyncMethodology,
  DEFAULT_SYNC_METHODOLOGY_LEVERS,
  projectRejectRateAtCap,
  SYNC_METHODOLOGY_SAFETY_MARGIN_RANGE,
  SYNC_REJECT_RATE_TIER_1_THRESHOLD,
  SYNC_REJECT_RATE_TIER_2_THRESHOLD,
} from './sweep-convention-cap-graduation';

describe('projectRejectRateAtCap', () => {
  test('zero rate when samples are empty', () => {
    expect(projectRejectRateAtCap([], 1000)).toBe(0);
  });

  test('counts the fraction above the cap', () => {
    expect(projectRejectRateAtCap([100, 200, 300, 400, 500], 350)).toBe(0.4);
  });

  test('zero when all samples are below the cap', () => {
    expect(projectRejectRateAtCap([10, 20, 30], 1000)).toBe(0);
  });

  test('one when all samples are above the cap', () => {
    expect(projectRejectRateAtCap([5000, 6000, 7000], 1000)).toBe(1);
  });
});

describe('computeSyncMethodology', () => {
  function syntheticCycles(profile: LatencyProfileName, samples: number[]): PerCycleRow[] {
    return samples.map((s, i) => ({
      mountId: `mid-${profile}-${i}`,
      profile,
      cycleIndex: i,
      syncElapsedMs: s,
      mountElapsedMs: 30,
      rejectedReason: null,
      retryAfterRejectionMs: null,
      serverSpanTimings: null,
      clientSpanTimings: null,
    }));
  }

  test('produces a recommendation on a well-formed distribution', async () => {
    const perCycle = syntheticCycles(
      'localhost',
      Array.from({ length: 20 }, () => 10),
    );
    const result = await runCycleLoop({
      driver: async ({ profile: p, cycleIndex }) => ({
        kind: 'success',
        mountId: `mid-${p.name}-${cycleIndex}`,
        syncElapsedMs: 10,
        mountElapsedMs: 30,
      }),
      cyclesPerProfile: 20,
      profiles: [getLatencyProfile('localhost')],
    });
    const methodology = computeSyncMethodology({
      perProfile: result.perProfile,
      perCycle: result.perCycle,
    });
    expect(methodology.methodology).toBe(
      'p99-percentile-with-multiplier-bounded-by-server-ceiling',
    );
    expect(methodology.designLevers).toEqual(DEFAULT_SYNC_METHODOLOGY_LEVERS);
    expect(methodology.serverCeilingMs).toBe(55_000);
    const local = methodology.perProfile.find((p) => p.profile === 'localhost');
    expect(local?.multiplierRecommendationMs).toBeGreaterThan(0);
    expect(local?.multiplierRecommendationMs).toBeLessThan(55_000);
    expect(local?.stopIfFlags).not.toContain('server-ceiling-bound');
    expect(perCycle.length).toBe(20);
  });

  test('flags server-ceiling-bound when p99 × safetyMargin exceeds the ceiling', () => {
    const perProfile: PerProfileSummary[] = [
      {
        profile: 'slow-3g',
        latencyMs: 2000,
        samples: 10,
        rejectedCount: 0,
        rejectRate: 0,
        syncElapsedMs: { p50: 19_000, p95: 19_500, p99: 20_000 },
        mountElapsedMs: { p50: 30, p95: 35, p99: 40 },
        syncP99BootstrapCi95: { lo: 19_500, hi: 20_500, estimate: 20_000 },
        stopIfFlags: [],
      },
    ];
    const result = computeSyncMethodology({
      perProfile,
      perCycle: [],
    });
    expect(result.stopIfFlags).toContain('server-ceiling-bound');
    expect(result.perProfile.find((p) => p.profile === 'slow-3g')?.stopIfFlags).toContain(
      'server-ceiling-bound',
    );
    const slow = result.perProfile.find((p) => p.profile === 'slow-3g');
    expect(slow?.multiplierRecommendationMs).toBe(55_000);
  });

  test('emits BOTH multiplier and BCa-upper recommendations', () => {
    const perProfile: PerProfileSummary[] = [
      {
        profile: 'localhost',
        latencyMs: 0,
        samples: 20,
        rejectedCount: 0,
        rejectRate: 0,
        syncElapsedMs: { p50: 20, p95: 40, p99: 50 },
        mountElapsedMs: { p50: 30, p95: 35, p99: 40 },
        syncP99BootstrapCi95: { lo: 40, hi: 100, estimate: 50 },
        stopIfFlags: [],
      },
    ];
    const result = computeSyncMethodology({
      perProfile,
      perCycle: [],
    });
    const local = result.perProfile.find((p) => p.profile === 'localhost');
    expect(local?.multiplierRecommendationMs).toBe(200); // 50 × 4
    expect(local?.bcaUpperRecommendationMs).toBe(100);
  });

  test('respects safetyMargin override within the documented range', () => {
    const perProfile: PerProfileSummary[] = [
      {
        profile: 'fast-wifi',
        latencyMs: 14,
        samples: 10,
        rejectedCount: 0,
        rejectRate: 0,
        syncElapsedMs: { p50: 50, p95: 80, p99: 100 },
        mountElapsedMs: { p50: 30, p95: 35, p99: 40 },
        syncP99BootstrapCi95: { lo: 80, hi: 120, estimate: 100 },
        stopIfFlags: [],
      },
    ];
    const result = computeSyncMethodology({
      perProfile,
      perCycle: [],
      levers: { safetyMargin: 3 },
    });
    const profile = result.perProfile.find((p) => p.profile === 'fast-wifi');
    expect(profile?.multiplierRecommendationMs).toBe(300); // 100 × 3
    expect(result.designLevers.safetyMargin).toBe(3);
  });

  test('throws when safetyMargin is outside [3, 5]', () => {
    expect(() =>
      computeSyncMethodology({
        perProfile: [],
        perCycle: [],
        levers: { safetyMargin: 2 },
      }),
    ).toThrow(/safetyMargin/);
    expect(() =>
      computeSyncMethodology({
        perProfile: [],
        perCycle: [],
        levers: { safetyMargin: 10 },
      }),
    ).toThrow(/safetyMargin/);
  });

  test('SAFETY_MARGIN_RANGE matches the documented bounds [3, 5]', () => {
    expect(SYNC_METHODOLOGY_SAFETY_MARGIN_RANGE).toEqual({ min: 3, max: 5 });
  });

  test('globalMultiplierRecommendation is max-of-profiles clamped to ceiling', () => {
    const perProfile: PerProfileSummary[] = [
      {
        profile: 'localhost',
        latencyMs: 0,
        samples: 10,
        rejectedCount: 0,
        rejectRate: 0,
        syncElapsedMs: { p50: 5, p95: 8, p99: 10 },
        mountElapsedMs: { p50: 30, p95: 35, p99: 40 },
        syncP99BootstrapCi95: { lo: 9, hi: 11, estimate: 10 },
        stopIfFlags: [],
      },
      {
        profile: 'slow-3g',
        latencyMs: 2000,
        samples: 10,
        rejectedCount: 0,
        rejectRate: 0,
        syncElapsedMs: { p50: 2500, p95: 2900, p99: 3000 },
        mountElapsedMs: { p50: 30, p95: 35, p99: 40 },
        syncP99BootstrapCi95: { lo: 2900, hi: 3100, estimate: 3000 },
        stopIfFlags: [],
      },
    ];
    const result = computeSyncMethodology({
      perProfile,
      perCycle: [],
    });
    expect(result.globalMultiplierRecommendationMs).toBe(12_000);
    expect(result.globalBcaUpperRecommendationMs).toBe(3100);
  });
});


import {
  buildMountTimeCdf,
  computeMountMethodology,
  DEFAULT_MOUNT_METHODOLOGY_LEVERS,
} from './sweep-convention-cap-graduation';

describe('buildMountTimeCdf', () => {
  test('returns empty array on empty samples', () => {
    expect(buildMountTimeCdf([])).toEqual([]);
  });

  test('builds a monotonic CDF from sorted samples', () => {
    const cdf = buildMountTimeCdf([10, 20, 30, 40, 50]);
    expect(cdf.length).toBe(5);
    expect(cdf[0]).toEqual({ x: 10, y: 0.2 });
    expect(cdf[4]).toEqual({ x: 50, y: 1 });
    for (let i = 1; i < cdf.length; i++) {
      expect(cdf[i]?.y).toBeGreaterThan(cdf[i - 1]?.y ?? 0);
    }
  });

  test('deduplicates repeated x values', () => {
    const cdf = buildMountTimeCdf([100, 100, 100, 50, 200, 100]);
    expect(cdf.map((p) => p.x)).toEqual([50, 100, 200]);
  });
});

describe('computeMountMethodology', () => {
  function makeBimodalCycles(): {
    perCycle: PerCycleRow[];
    perProfile: PerProfileSummary[];
  } {
    const profiles: LatencyProfileName[] = ['localhost', 'fast-wifi'];
    const perCycle: PerCycleRow[] = [];
    for (let p = 0; p < profiles.length; p++) {
      const profileName = profiles[p];
      if (!profileName) continue;
      for (let i = 0; i < 25; i++) {
        perCycle.push({
          mountId: `mid-${profileName}-${i}`,
          profile: profileName,
          cycleIndex: i,
          syncElapsedMs: 100,
          mountElapsedMs: 30 + i, // 30..54
          rejectedReason: null,
          serverSpanTimings: null,
          clientSpanTimings: null,
        });
        perCycle.push({
          mountId: `mid-${profileName}-${i + 100}`,
          profile: profileName,
          cycleIndex: i + 100,
          syncElapsedMs: 100,
          mountElapsedMs: 250 + i, // 250..274
          rejectedReason: null,
          serverSpanTimings: null,
          clientSpanTimings: null,
        });
      }
    }
    const perProfile: PerProfileSummary[] = profiles
      .filter((p): p is LatencyProfileName => p !== undefined)
      .map((p) => ({
        profile: p,
        latencyMs: getLatencyProfile(p).latencyMs,
        samples: 50,
        rejectedCount: 0,
        rejectRate: 0,
        syncElapsedMs: { p50: 100, p95: 100, p99: 100 },
        mountElapsedMs: { p50: 140, p95: 270, p99: 273 },
        syncP99BootstrapCi95: null,
        stopIfFlags: [],
      }));
    return { perCycle, perProfile };
  }

  test('produces a clamped recommendation on a bimodal CDF', () => {
    const { perCycle, perProfile } = makeBimodalCycles();
    const result = computeMountMethodology({ perProfile, perCycle });
    expect(result.methodology).toBe('kneedle-bounded-by-NN');
    expect(result.designLevers).toEqual(DEFAULT_MOUNT_METHODOLOGY_LEVERS);
    expect(result.recommendedCapMs).toBeGreaterThanOrEqual(
      DEFAULT_MOUNT_METHODOLOGY_LEVERS.nnFloorMs,
    );
    expect(result.recommendedCapMs).toBeLessThanOrEqual(
      DEFAULT_MOUNT_METHODOLOGY_LEVERS.nnCeilingMs,
    );
  });

  test('flags kneedle-degenerate on a uniform distribution + falls back to NN ceiling', () => {
    const perCycle: PerCycleRow[] = Array.from({ length: 100 }, (_, i) => ({
      mountId: `mid-uni-${i}`,
      profile: 'localhost' as LatencyProfileName,
      cycleIndex: i,
      syncElapsedMs: 100,
      mountElapsedMs: i + 1,
      rejectedReason: null,
      serverSpanTimings: null,
      clientSpanTimings: null,
    }));
    const perProfile: PerProfileSummary[] = [
      {
        profile: 'localhost',
        latencyMs: 0,
        samples: 100,
        rejectedCount: 0,
        rejectRate: 0,
        syncElapsedMs: { p50: 100, p95: 100, p99: 100 },
        mountElapsedMs: { p50: 50, p95: 95, p99: 99 },
        syncP99BootstrapCi95: null,
        stopIfFlags: [],
      },
    ];
    const result = computeMountMethodology({ perProfile, perCycle });
    expect(result.stopIfFlags).toContain('kneedle-degenerate');
    expect(result.recommendedCapMs).toBe(DEFAULT_MOUNT_METHODOLOGY_LEVERS.nnCeilingMs);
    expect(result.clamp).toBe('ceiling');
  });

  test('returns ceiling fallback + kneedle-degenerate on empty input', () => {
    const result = computeMountMethodology({ perProfile: [], perCycle: [] });
    expect(result.stopIfFlags).toContain('kneedle-degenerate');
    expect(result.recommendedCapMs).toBe(DEFAULT_MOUNT_METHODOLOGY_LEVERS.nnCeilingMs);
    expect(result.clamp).toBe('ceiling');
  });

  test('flags NN-floor-clamp-multiple-profiles when >1 profile sits entirely below the floor', () => {
    const profiles: LatencyProfileName[] = ['localhost', 'fast-wifi', 'cafe-lte'];
    const perCycle: PerCycleRow[] = [];
    for (let p = 0; p < profiles.length; p++) {
      const profileName = profiles[p];
      if (!profileName) continue;
      for (let i = 0; i < 10; i++) {
        perCycle.push({
          mountId: `mid-${profileName}-${i}`,
          profile: profileName,
          cycleIndex: i,
          syncElapsedMs: 100,
          mountElapsedMs: 50 + i, // all below 3000ms floor
          rejectedReason: null,
          serverSpanTimings: null,
          clientSpanTimings: null,
        });
      }
    }
    const perProfile: PerProfileSummary[] = profiles
      .filter((p): p is LatencyProfileName => p !== undefined)
      .map((p) => ({
        profile: p,
        latencyMs: getLatencyProfile(p).latencyMs,
        samples: 10,
        rejectedCount: 0,
        rejectRate: 0,
        syncElapsedMs: { p50: 100, p95: 100, p99: 100 },
        mountElapsedMs: { p50: 55, p95: 59, p99: 59 },
        syncP99BootstrapCi95: null,
        stopIfFlags: [],
      }));
    const result = computeMountMethodology({ perProfile, perCycle });
    expect(result.stopIfFlags).toContain('NN-floor-clamp-multiple-profiles');
    expect(result.nnFloorContributingProfileCount).toBe(3);
  });

  test('records inflectionMs pre-clamp + clamp result post-clamp', () => {
    const { perCycle, perProfile } = makeBimodalCycles();
    const result = computeMountMethodology({ perProfile, perCycle });
    if (!result.stopIfFlags.includes('kneedle-degenerate')) {
      expect(Number.isFinite(result.inflectionMs)).toBe(true);
    }
    expect(['floor', 'ceiling', 'none']).toContain(result.clamp);
  });

  test('respects custom NN bounds', () => {
    const result = computeMountMethodology({
      perProfile: [],
      perCycle: [],
      levers: { nnFloorMs: 1_000, nnCeilingMs: 5_000 },
    });
    expect(result.recommendedCapMs).toBe(5_000);
    expect(result.designLevers.nnFloorMs).toBe(1_000);
    expect(result.designLevers.nnCeilingMs).toBe(5_000);
  });

  test('throws when nnFloorMs >= nnCeilingMs', () => {
    expect(() =>
      computeMountMethodology({
        perProfile: [],
        perCycle: [],
        levers: { nnFloorMs: 5_000, nnCeilingMs: 5_000 },
      }),
    ).toThrow(/nnFloorMs.*nnCeilingMs/);
  });

  test('exposes per-profile reject rates for input-quality validation', () => {
    const perProfile: PerProfileSummary[] = [
      {
        profile: 'localhost',
        latencyMs: 0,
        samples: 90,
        rejectedCount: 10,
        rejectRate: 0.1,
        syncElapsedMs: { p50: 10, p95: 20, p99: 30 },
        mountElapsedMs: { p50: 30, p95: 40, p99: 50 },
        syncP99BootstrapCi95: null,
        stopIfFlags: [],
      },
    ];
    const result = computeMountMethodology({ perProfile, perCycle: [] });
    expect(result.perProfileRejectRates).toEqual([{ profile: 'localhost', rejectRate: 0.1 }]);
  });
});


import {
  computeDifferentials,
  DEPLOYMENT_TOPOLOGY_FAIL_THRESHOLD,
  detectHostFingerprint,
  MOUNT_VS_SYNC_TAIL_INDEPENDENCE_FAIL_THRESHOLD,
} from './sweep-convention-cap-graduation';

describe('computeDifferentials', () => {
  function makePerProfile(
    profile: LatencyProfileName,
    mountP99: number,
    syncP99: number,
  ): PerProfileSummary {
    return {
      profile,
      latencyMs: getLatencyProfile(profile).latencyMs,
      samples: 10,
      rejectedCount: 0,
      rejectRate: 0,
      syncElapsedMs: { p50: syncP99 / 2, p95: syncP99 * 0.95, p99: syncP99 },
      mountElapsedMs: { p50: mountP99 / 2, p95: mountP99 * 0.95, p99: mountP99 },
      syncP99BootstrapCi95: null,
      stopIfFlags: [],
    };
  }

  function makePerCycle(
    profile: LatencyProfileName,
    n: number,
    syncHandshakeMs: number | null = null,
    providerPoolOpenMs: number | null = null,
  ): PerCycleRow[] {
    return Array.from({ length: n }, (_, i) => ({
      mountId: `mid-${profile}-${i}`,
      profile,
      cycleIndex: i,
      syncElapsedMs: 100,
      mountElapsedMs: 30,
      rejectedReason: null,
      serverSpanTimings:
        syncHandshakeMs !== null ? { syncHandshakeMs, persistenceLoadMs: null } : null,
      clientSpanTimings:
        providerPoolOpenMs !== null
          ? { coldMountMs: null, providerPoolOpenMs, mountPromiseMs: null, syncPromiseMs: null }
          : null,
    }));
  }

  test('Differential E (syncDominatesMountTailRatio) is computed free from mark-histogram data', () => {
    const perProfile: PerProfileSummary[] = [makePerProfile('localhost', 30, 90)];
    const perCycle = makePerCycle('localhost', 5);
    const result = computeDifferentials({ perProfile, perCycle });
    const local = result.perProfile.find((d) => d.profile === 'localhost');
    expect(local?.syncDominatesMountTailRatio).toBe(3); // 90 / 30
    expect(local?.serverProcessingShareOfP99).toBeNull();
    expect(local?.providerSetupContaminationMs).toBeNull();
  });

  test('serverProcessingShareOfP99 derives from OTel handshake samples', () => {
    const perProfile: PerProfileSummary[] = [makePerProfile('fast-wifi', 30, 100)];
    const perCycle = makePerCycle('fast-wifi', 10, 50); // handshake p99 = 50, sync p99 = 100 → ratio 0.5
    const result = computeDifferentials({ perProfile, perCycle });
    const fastWifi = result.perProfile.find((d) => d.profile === 'fast-wifi');
    expect(fastWifi?.serverProcessingShareOfP99).toBeCloseTo(0.5, 2);
  });

  test('providerSetupContaminationMs is the median of ok.provider-pool.open samples', () => {
    const perProfile: PerProfileSummary[] = [makePerProfile('localhost', 30, 100)];
    const perCycle = makePerCycle('localhost', 5, null, 8);
    const result = computeDifferentials({ perProfile, perCycle });
    const local = result.perProfile.find((d) => d.profile === 'localhost');
    expect(local?.providerSetupContaminationMs).toBe(8);
  });

  test('deploymentTopologyRobustness FAILS when slow-3g serverProcessingShare > 50%', () => {
    const perProfile: PerProfileSummary[] = [
      makePerProfile('localhost', 30, 100),
      makePerProfile('slow-3g', 30, 2000),
    ];
    const perCycle = [...makePerCycle('localhost', 5), ...makePerCycle('slow-3g', 10, 1500)];
    const result = computeDifferentials({ perProfile, perCycle });
    expect(result.globalFalsifiabilityChecks.deploymentTopologyRobustness).toBe('FAIL');
  });

  test('deploymentTopologyRobustness PASSES when slow profiles are under 50% server share', () => {
    const perProfile: PerProfileSummary[] = [
      makePerProfile('localhost', 30, 100),
      makePerProfile('slow-3g', 30, 2000),
    ];
    const perCycle = [
      ...makePerCycle('localhost', 5),
      ...makePerCycle('slow-3g', 10, 500), // share = 500/2000 = 0.25 < 0.50
    ];
    const result = computeDifferentials({ perProfile, perCycle });
    expect(result.globalFalsifiabilityChecks.deploymentTopologyRobustness).toBe('PASS');
  });

  test('mountVsSyncTailIndependence FAILS when ANY profile has ratio > 0.85', () => {
    const perProfile: PerProfileSummary[] = [
      makePerProfile('localhost', 100, 90), // sync=90, mount=100 → ratio 0.9
    ];
    const perCycle = makePerCycle('localhost', 5);
    const result = computeDifferentials({ perProfile, perCycle });
    expect(result.globalFalsifiabilityChecks.mountVsSyncTailIndependence).toBe('FAIL');
  });

  test('thresholds match the documented constants', () => {
    expect(DEPLOYMENT_TOPOLOGY_FAIL_THRESHOLD).toBe(0.5);
    expect(MOUNT_VS_SYNC_TAIL_INDEPENDENCE_FAIL_THRESHOLD).toBe(0.85);
  });
});

describe('detectHostFingerprint', () => {
  test('uses defaults when no env vars provided', () => {
    const fp = detectHostFingerprint({});
    expect(fp.cpu).toBe('unknown');
    expect(fp.ramGb).toBe(16);
    expect(fp.concurrentDevServerLoad).toBe('unknown');
    expect(fp.devServerUptimeMinutes).toBeNull();
    expect(fp.fixtureDocSizeBytes).toBeNull();
  });

  test('reads OK_HOST_* env vars when present', () => {
    const fp = detectHostFingerprint({
      OK_HOST_CPU: 'Apple M3 Pro',
      OK_HOST_RAM_GB: '36',
      OK_HOST_DEV_SERVER_LOAD: 'idle',
      OK_HOST_DEV_SERVER_UPTIME_MINUTES: '45',
      OK_HOST_FIXTURE_DOC_SIZE_BYTES: '12345',
    });
    expect(fp.cpu).toBe('Apple M3 Pro');
    expect(fp.ramGb).toBe(36);
    expect(fp.concurrentDevServerLoad).toBe('idle');
    expect(fp.devServerUptimeMinutes).toBe(45);
    expect(fp.fixtureDocSizeBytes).toBe(12345);
  });
});

describe('buildFullCellResults — full end-to-end shape (US-011)', () => {
  test('emits all top-level blocks: stopIfFlags, perCycle, perProfile, syncMethodology, mountMethodology, differentials, hostFingerprint', async () => {
    const driver: CycleDriver = async ({ profile, cycleIndex }) => ({
      kind: 'success',
      mountId: `mid-${profile.name}-${cycleIndex}`,
      syncElapsedMs: profile.latencyMs + 10 + cycleIndex,
      mountElapsedMs: 30 + cycleIndex * 0.5,
    });
    const cycleResult = await runCycleLoop({
      driver,
      cyclesPerProfile: 5,
    });
    const full = buildFullCellResults(
      {
        kind: 'ok',
        medians: {
          cdpLocalhostMedianMs: 2,
          cdpSlow3gMedianMs: 2000,
          routeWebSocketLocalhostMedianMs: 2,
          routeWebSocketSlow3gMedianMs: 2010,
        },
      },
      cycleResult,
      {
        hostFingerprintEnv: {
          OK_HOST_CPU: 'Apple M3 Pro',
          OK_HOST_RAM_GB: '36',
        },
      },
    );
    expect(full.schemaVersion).toBe(1);
    expect(full.scenario).toBe(SCENARIO_NAME);
    expect(full.perCycle.length).toBe(LATENCY_PROFILES.length * 5);
    expect(full.perProfile.length).toBe(LATENCY_PROFILES.length);
    expect(full.syncMethodology).toBeDefined();
    expect(full.mountMethodology).toBeDefined();
    expect(full.differentials).toBeDefined();
    expect(full.hostFingerprint?.cpu).toBe('Apple M3 Pro');
    expect(full.hostFingerprint?.ramGb).toBe(36);
  });

  test('JSON round-trips cleanly with all blocks populated', async () => {
    const driver: CycleDriver = async ({ profile, cycleIndex }) => ({
      kind: 'success',
      mountId: `mid-${profile.name}-${cycleIndex}`,
      syncElapsedMs: profile.latencyMs + 10,
      mountElapsedMs: 30,
    });
    const cycleResult = await runCycleLoop({ driver, cyclesPerProfile: 2 });
    const full = buildFullCellResults(
      {
        kind: 'ok',
        medians: {
          cdpLocalhostMedianMs: 2,
          cdpSlow3gMedianMs: 2000,
          routeWebSocketLocalhostMedianMs: 2,
          routeWebSocketSlow3gMedianMs: 2010,
        },
      },
      cycleResult,
    );
    const parsed = JSON.parse(JSON.stringify(full));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.syncMethodology.methodology).toBe(
      'p99-percentile-with-multiplier-bounded-by-server-ceiling',
    );
    expect(parsed.mountMethodology.methodology).toBe('kneedle-bounded-by-NN');
    expect(parsed.differentials.globalFalsifiabilityChecks).toBeDefined();
  });
});


describe('computeSyncMethodology — two-tier reject-rate gates', () => {
  function makeProfilePair(opts: {
    profile: LatencyProfileName;
    latencyMs: number;
    successSamples: ReadonlyArray<number>;
    preSyncDisconnects: number;
  }): { perProfile: PerProfileSummary[]; perCycle: PerCycleRow[] } {
    const perCycle: PerCycleRow[] = [];
    for (let i = 0; i < opts.successSamples.length; i++) {
      const sample = opts.successSamples[i];
      if (sample === undefined) continue;
      perCycle.push({
        mountId: `${opts.profile}-success-${i}`,
        profile: opts.profile,
        cycleIndex: i,
        syncElapsedMs: sample,
        mountElapsedMs: 30,
        rejectedReason: null,
        retryAfterRejectionMs: null,
        serverSpanTimings: null,
        clientSpanTimings: null,
      });
    }
    for (let j = 0; j < opts.preSyncDisconnects; j++) {
      perCycle.push({
        mountId: `${opts.profile}-disc-${j}`,
        profile: opts.profile,
        cycleIndex: opts.successSamples.length + j,
        syncElapsedMs: 0,
        mountElapsedMs: 0,
        rejectedReason: 'pre-sync-disconnect',
        retryAfterRejectionMs: null,
        serverSpanTimings: null,
        clientSpanTimings: null,
      });
    }
    const successOnly = opts.successSamples.filter((v) => Number.isFinite(v));
    const totalCount = successOnly.length + opts.preSyncDisconnects;
    const perProfile: PerProfileSummary[] = [
      {
        profile: opts.profile,
        latencyMs: opts.latencyMs,
        samples: successOnly.length,
        rejectedCount: opts.preSyncDisconnects,
        rejectRate: totalCount > 0 ? opts.preSyncDisconnects / totalCount : 0,
        syncElapsedMs: {
          p50: percentile(successOnly, 0.5),
          p95: percentile(successOnly, 0.95),
          p99: percentile(successOnly, 0.99),
        },
        mountElapsedMs: { p50: 30, p95: 35, p99: 40 },
        syncP99BootstrapCi95: null,
        stopIfFlags: [],
      },
    ];
    return { perProfile, perCycle };
  }

  test('Tier 1 fires when preSyncDisconnectRate exceeds 1%', () => {
    const { perProfile, perCycle } = makeProfilePair({
      profile: 'slow-3g',
      latencyMs: 2000,
      successSamples: Array.from({ length: 99 }, () => 5000),
      preSyncDisconnects: 2,
    });
    const result = computeSyncMethodology({ perProfile, perCycle });
    const slow = result.perProfile.find((p) => p.profile === 'slow-3g');
    expect(slow?.tier1Exceeded).toBe(true);
    expect(slow?.stopIfFlags).toContain('sync-tier-1-pre-sync-disconnect-rate-exceeded');
    expect(result.stopIfFlags).toContain('sync-tier-1-pre-sync-disconnect-rate-exceeded');
    expect(slow?.preSyncDisconnectRate).toBeGreaterThan(SYNC_REJECT_RATE_TIER_1_THRESHOLD);
  });

  test('Tier 1 does NOT fire at exactly 1% — strict-greater semantics', () => {
    const { perProfile, perCycle } = makeProfilePair({
      profile: 'localhost',
      latencyMs: 0,
      successSamples: Array.from({ length: 99 }, () => 10),
      preSyncDisconnects: 1,
    });
    const result = computeSyncMethodology({ perProfile, perCycle });
    const local = result.perProfile.find((p) => p.profile === 'localhost');
    expect(local?.tier1Exceeded).toBe(false);
    expect(local?.stopIfFlags).not.toContain('sync-tier-1-pre-sync-disconnect-rate-exceeded');
    expect(result.stopIfFlags).not.toContain('sync-tier-1-pre-sync-disconnect-rate-exceeded');
  });

  test('Tier 2 fires when projectedRejectRateAtMultiplierCap exceeds 1%', () => {
    const successSamples = [
      ...Array.from({ length: 95 }, () => 5),
      ...Array.from({ length: 5 }, () => 50),
    ];
    const perCycle: PerCycleRow[] = successSamples.map((s, i) => ({
      mountId: `cafe-${i}`,
      profile: 'cafe-lte',
      cycleIndex: i,
      syncElapsedMs: s,
      mountElapsedMs: 30,
      rejectedReason: null,
      retryAfterRejectionMs: null,
      serverSpanTimings: null,
      clientSpanTimings: null,
    }));
    const perProfile: PerProfileSummary[] = [
      {
        profile: 'cafe-lte',
        latencyMs: 200,
        samples: 100,
        rejectedCount: 0,
        rejectRate: 0,
        syncElapsedMs: { p50: 5, p95: 5, p99: 10 },
        mountElapsedMs: { p50: 30, p95: 35, p99: 40 },
        syncP99BootstrapCi95: null,
        stopIfFlags: [],
      },
    ];
    const result = computeSyncMethodology({ perProfile, perCycle });
    const cafe = result.perProfile.find((p) => p.profile === 'cafe-lte');
    expect(cafe?.projectedRejectRateAtMultiplierCap).toBeGreaterThan(
      SYNC_REJECT_RATE_TIER_2_THRESHOLD,
    );
    expect(cafe?.tier2Exceeded).toBe(true);
    expect(cafe?.stopIfFlags).toContain('sync-tier-2-projected-reject-rate-exceeded');
    expect(result.stopIfFlags).toContain('sync-tier-2-projected-reject-rate-exceeded');
  });

  test('Tier 1 and Tier 2 are orthogonal — neither fires on a healthy distribution', () => {
    const { perProfile, perCycle } = makeProfilePair({
      profile: 'fast-wifi',
      latencyMs: 14,
      successSamples: Array.from({ length: 50 }, () => 50),
      preSyncDisconnects: 0,
    });
    const result = computeSyncMethodology({ perProfile, perCycle });
    const fast = result.perProfile.find((p) => p.profile === 'fast-wifi');
    expect(fast?.tier1Exceeded).toBe(false);
    expect(fast?.tier2Exceeded).toBe(false);
    expect(fast?.stopIfFlags).not.toContain('sync-tier-1-pre-sync-disconnect-rate-exceeded');
    expect(fast?.stopIfFlags).not.toContain('sync-tier-2-projected-reject-rate-exceeded');
  });
});


describe('computeSyncMethodology — slow-3g warm-path spot-check', () => {
  function healthyProfile(): PerProfileSummary {
    return {
      profile: 'localhost',
      latencyMs: 0,
      samples: 10,
      rejectedCount: 0,
      rejectRate: 0,
      syncElapsedMs: { p50: 10, p95: 12, p99: 15 },
      mountElapsedMs: { p50: 30, p95: 35, p99: 40 },
      syncP99BootstrapCi95: null,
      stopIfFlags: [],
    };
  }

  test('omits slow3gWarmPath block when samples are not provided', () => {
    const result = computeSyncMethodology({
      perProfile: [healthyProfile()],
      perCycle: [],
    });
    expect(result.slow3gWarmPath).toBeUndefined();
    expect(result.stopIfFlags).not.toContain('warm-path-tail-exceeds-cold-tail-on-slow-3g');
  });

  test('populates ratio + warmTailExceedsCold when warm p99 stays under threshold', () => {
    const result = computeSyncMethodology({
      perProfile: [healthyProfile()],
      perCycle: [],
      slow3gWarmPathSamples: {
        coldMs: Array.from({ length: 10 }, () => 10_000),
        warmMs: Array.from({ length: 10 }, () => 100),
      },
    });
    expect(result.slow3gWarmPath).toBeDefined();
    expect(result.slow3gWarmPath?.coldP99Ms).toBe(10_000);
    expect(result.slow3gWarmPath?.warmP99Ms).toBe(100);
    expect(result.slow3gWarmPath?.ratio).toBeCloseTo(0.01, 5);
    expect(result.slow3gWarmPath?.warmTailExceedsCold).toBe(false);
    expect(result.stopIfFlags).not.toContain('warm-path-tail-exceeds-cold-tail-on-slow-3g');
  });

  test('flags warm-path-tail-exceeds-cold-tail-on-slow-3g when ratio > 2x', () => {
    const result = computeSyncMethodology({
      perProfile: [healthyProfile()],
      perCycle: [],
      slow3gWarmPathSamples: {
        coldMs: Array.from({ length: 10 }, () => 100),
        warmMs: Array.from({ length: 10 }, () => 300),
      },
    });
    expect(result.slow3gWarmPath?.warmTailExceedsCold).toBe(true);
    expect(result.stopIfFlags).toContain('warm-path-tail-exceeds-cold-tail-on-slow-3g');
  });

  test('records all-null when both sample arrays are empty', () => {
    const result = computeSyncMethodology({
      perProfile: [healthyProfile()],
      perCycle: [],
      slow3gWarmPathSamples: { coldMs: [], warmMs: [] },
    });
    expect(result.slow3gWarmPath?.coldP99Ms).toBeNull();
    expect(result.slow3gWarmPath?.warmP99Ms).toBeNull();
    expect(result.slow3gWarmPath?.ratio).toBeNull();
    expect(result.slow3gWarmPath?.warmTailExceedsCold).toBe(false);
    expect(result.stopIfFlags).not.toContain('warm-path-tail-exceeds-cold-tail-on-slow-3g');
  });
});


describe('computeSyncMethodology — post-rejection retry aggregation', () => {
  test('retryAfterRejectionMsP99 is null when no cycles produced a retry sample', () => {
    const perCycle: PerCycleRow[] = Array.from({ length: 20 }, (_, i) => ({
      mountId: `mid-${i}`,
      profile: 'localhost',
      cycleIndex: i,
      syncElapsedMs: 10,
      mountElapsedMs: 30,
      rejectedReason: null,
      retryAfterRejectionMs: null,
      serverSpanTimings: null,
      clientSpanTimings: null,
    }));
    const perProfile: PerProfileSummary[] = [
      {
        profile: 'localhost',
        latencyMs: 0,
        samples: 20,
        rejectedCount: 0,
        rejectRate: 0,
        syncElapsedMs: { p50: 10, p95: 10, p99: 10 },
        mountElapsedMs: { p50: 30, p95: 35, p99: 40 },
        syncP99BootstrapCi95: null,
        stopIfFlags: [],
      },
    ];
    const result = computeSyncMethodology({ perProfile, perCycle });
    const local = result.perProfile.find((p) => p.profile === 'localhost');
    expect(local?.retryAfterRejectionMsP99).toBeNull();
    expect(local?.retryAfterRejectionSampleCount).toBe(0);
  });

  test('retryAfterRejectionMsP99 reflects the retry distribution per profile', () => {
    const perCycle: PerCycleRow[] = Array.from({ length: 10 }, (_, i) => ({
      mountId: `mid-${i}`,
      profile: 'slow-3g',
      cycleIndex: i,
      syncElapsedMs: 0,
      mountElapsedMs: 0,
      rejectedReason: 'sync-timeout',
      retryAfterRejectionMs: 1000 + i * 100,
      serverSpanTimings: null,
      clientSpanTimings: null,
    }));
    const perProfile: PerProfileSummary[] = [
      {
        profile: 'slow-3g',
        latencyMs: 2000,
        samples: 0,
        rejectedCount: 10,
        rejectRate: 1,
        syncElapsedMs: { p50: null, p95: null, p99: null },
        mountElapsedMs: { p50: null, p95: null, p99: null },
        syncP99BootstrapCi95: null,
        stopIfFlags: ['empty-profile'],
      },
    ];
    const result = computeSyncMethodology({ perProfile, perCycle });
    const slow = result.perProfile.find((p) => p.profile === 'slow-3g');
    expect(slow?.retryAfterRejectionSampleCount).toBe(10);
    expect(slow?.retryAfterRejectionMsP99).toBeCloseTo(1891, 0);
  });

  test('retry samples flow through the cycle-loop result into the methodology', async () => {
    const driver: CycleDriver = async ({ profile, cycleIndex }) => {
      if (cycleIndex % 2 === 0) {
        return {
          kind: 'rejected',
          mountId: `mid-${profile.name}-${cycleIndex}`,
          reason: 'sync-timeout',
          retryAfterRejectionMs: 1500,
        };
      }
      return {
        kind: 'success',
        mountId: `mid-${profile.name}-${cycleIndex}`,
        syncElapsedMs: 100,
        mountElapsedMs: 30,
      };
    };
    const cycleResult = await runCycleLoop({
      driver,
      cyclesPerProfile: 10,
      profiles: [getLatencyProfile('localhost')],
    });
    const retryRows = cycleResult.perCycle.filter((c) => c.retryAfterRejectionMs !== null);
    expect(retryRows.length).toBe(5);
    expect(retryRows.every((c) => c.retryAfterRejectionMs === 1500)).toBe(true);
    const methodology = computeSyncMethodology({
      perProfile: cycleResult.perProfile,
      perCycle: cycleResult.perCycle,
    });
    const local = methodology.perProfile.find((p) => p.profile === 'localhost');
    expect(local?.retryAfterRejectionSampleCount).toBe(5);
    expect(local?.retryAfterRejectionMsP99).toBe(1500);
  });
});
