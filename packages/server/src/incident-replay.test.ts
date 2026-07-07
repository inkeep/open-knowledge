/**
 * success-metric "Diagnosability" capstone.
 *
 * Two halves:
 *   1. Telemetry completeness — every instrument emits under bounded
 *      cardinality (attributes are enums/buckets, never raw counts/paths).
 *   2. Incident replay — the storyline (timeout-killed/bounded walks,
 *      ref width, loose-object count, poll-storm coalescing, gc.log latch) is
 *      reconstructable from emitted telemetry + the diagnose repo-fact readers
 *      ALONE — no forensic bundle.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import simpleGit from 'simple-git';
import { createMaintenanceCoordinator } from './maintenance-coordinator.ts';
import {
  __resetMaintenanceTelemetryForTesting,
  recordConsolidation,
  recordGcLatch,
  recordMaintenanceRun,
} from './shadow-maintenance-telemetry.ts';
import { commitWip, initShadowRepo, type ShadowHandle } from './shadow-repo.ts';
import { countShadowObjects, countWipRefs, hasGcLogLatch } from './shadow-repo-stats.ts';
import {
  __resetTimelineTelemetryForTesting,
  commitsBucket,
  recordTimelineCoalesced,
  recordTimelineQuery,
  widthBucket,
} from './timeline-telemetry.ts';

interface Harness {
  exporter: InMemoryMetricExporter;
  flush: () => Promise<void>;
  cleanup: () => Promise<void>;
}

function setupHarness(): Harness {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  __resetTimelineTelemetryForTesting();
  __resetMaintenanceTelemetryForTesting();
  return {
    exporter,
    flush: () => reader.forceFlush(),
    async cleanup() {
      await provider.shutdown();
      metrics.disable();
      __resetTimelineTelemetryForTesting();
      __resetMaintenanceTelemetryForTesting();
    },
  };
}

interface Point {
  attributes: Record<string, unknown>;
  count?: number;
  value?: number;
}

function points(h: Harness, name: string): Point[] {
  const out: Point[] = [];
  for (const rm of h.exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (metric.descriptor.name !== name) continue;
        for (const dp of metric.dataPoints) {
          const v = dp.value as unknown;
          if (v && typeof v === 'object' && 'count' in (v as Record<string, unknown>)) {
            out.push({ attributes: dp.attributes, count: (v as { count: number }).count });
          } else {
            out.push({ attributes: dp.attributes, value: v as number });
          }
        }
      }
    }
  }
  return out;
}

describe('bucketing is bounded-cardinality (cardinality STOP rule)', () => {
  test('widthBucket maps any width to one of a fixed enum', () => {
    const seen = new Set<string>();
    for (const n of [-5, 0, 1, 3, 12, 30, 57, 1000, 100_000]) seen.add(widthBucket(n));
    for (const b of seen) expect(['0', '1', '2-5', '6-20', '21-50', '50+']).toContain(b);
    expect(seen.size).toBeLessThanOrEqual(6);
  });

  test('commitsBucket maps any commit count to one of a fixed enum', () => {
    const seen = new Set<string>();
    for (const n of [-1, 0, 50, 51, 200, 500, 501, 1_000_000]) seen.add(commitsBucket(n));
    for (const b of seen) expect(['0', '1-50', '51-200', '201-500', '500+']).toContain(b);
    expect(seen.size).toBeLessThanOrEqual(5);
  });
});

describe('FR9 telemetry completeness — every instrument emits with bounded attributes', () => {
  let h: Harness;
  beforeEach(() => {
    h = setupHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  test('all FR9 instruments emit, and no data point carries an unbounded attribute', async () => {
    recordTimelineQuery({ durationMs: 31_000, width: 57, commits: 600, capped: true });
    recordTimelineCoalesced('doc');
    recordTimelineCoalesced('folder');
    recordMaintenanceRun('gc', 'ok', 1234);
    recordMaintenanceRun('consolidation', 'ok', 50);
    recordMaintenanceRun('reap', 'ok', 80);
    recordGcLatch();
    recordConsolidation('dead-chain');
    await h.flush();

    // Every instrument is present.
    expect(points(h, 'ok.timeline.query_duration_ms').length).toBeGreaterThan(0);
    expect(points(h, 'ok.timeline.coalesced_total').length).toBeGreaterThan(0);
    expect(points(h, 'ok.shadow.maintenance.run_duration_ms').length).toBeGreaterThan(0);
    expect(points(h, 'ok.shadow.maintenance.gc_latch_total').length).toBeGreaterThan(0);
    expect(points(h, 'ok.shadow.maintenance.consolidation_total').length).toBeGreaterThan(0);

    // Bounded cardinality: every attribute value is a small enum/bucket, never a
    // raw integer (which would be the 31000ms duration, the 57 width, 600 commits).
    const allowed: Record<string, Set<string>> = {
      width_bucket: new Set(['0', '1', '2-5', '6-20', '21-50', '50+']),
      commits_bucket: new Set(['0', '1-50', '51-200', '201-500', '500+']),
      capped: new Set(['true', 'false']),
      error: new Set(['true', 'false']),
      mode: new Set(['doc', 'folder']),
      op: new Set(['gc', 'consolidation', 'reap']),
      outcome: new Set(['ok', 'skipped', 'error']),
      trigger: new Set(['dead-chain', 'session-close', 'boot', 'ttl']),
    };
    for (const name of [
      'ok.timeline.query_duration_ms',
      'ok.timeline.coalesced_total',
      'ok.shadow.maintenance.run_duration_ms',
      'ok.shadow.maintenance.gc_latch_total',
      'ok.shadow.maintenance.consolidation_total',
    ]) {
      for (const p of points(h, name)) {
        for (const [k, v] of Object.entries(p.attributes)) {
          expect(allowed[k]).toBeDefined(); // only known, bounded keys
          expect(allowed[k]?.has(String(v))).toBe(true); // only known, bounded values
        }
      }
    }
  });
});

describe('PRD-6972 incident replay — storyline from telemetry + diagnose readers alone', () => {
  let h: Harness;
  let tmpDir: string;
  let shadow: ShadowHandle;

  beforeEach(async () => {
    h = setupHarness();
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-replay-'));
    const projectRoot = resolve(tmpDir, 'project');
    const contentDir = resolve(projectRoot, 'content/docs');
    mkdirSync(contentDir, { recursive: true });
    const git = simpleGit(projectRoot);
    await git.init();
    await git.raw('config', 'user.name', 'T');
    await git.raw('config', 'user.email', 't@t');
    writeFileSync(resolve(contentDir, 'intro.md'), '# h\n');
    await git.add('.');
    await git.commit('init');
    shadow = await initShadowRepo(projectRoot);
    // A wide journal: 8 agent WIP chains (the incident had 53).
    for (let i = 0; i < 8; i++) {
      writeFileSync(resolve(contentDir, 'intro.md'), `# v${i}\n`);
      await commitWip(
        shadow,
        { id: `agent-${randomUUID()}`, name: 'a', email: 'a@x' },
        'content/docs',
        `wip ${i}`,
      );
    }
    // A gc.log latch (auto-gc disabled).
    writeFileSync(resolve(shadow.gitDir, 'gc.log'), 'warning: prior gc failed\n');
  });

  afterEach(async () => {
    await h.cleanup();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('the incident is reconstructable without a bundle', async () => {
    // ── Diagnose half: the repo-fact readers (the diagnose substrate) surface
    //    ref width, loose count, and the gc.log latch directly from the repo.
    const width = await countWipRefs(shadow);
    const objects = await countShadowObjects(shadow);
    const latch = hasGcLogLatch(shadow);
    expect(width).toBeGreaterThanOrEqual(8); // version-journal width
    expect(objects.looseObjects).toBeGreaterThan(0); // unpacked accumulation
    expect(latch).toBe(true); // auto-gc disabled

    // ── Telemetry half: replay the incident signature.
    recordTimelineQuery({ durationMs: 30_000, width, commits: 600, capped: true }); // bounded/slow walk
    // The storm's defining signal: a query that THREW on the 30s git timeout.
    // It records error=true so it's distinguishable from a healthy empty doc,
    // which would otherwise share the same width/commits 0 bucket shape.
    recordTimelineQuery({ durationMs: 30_000, width: 0, commits: 0, capped: false, error: true });
    recordTimelineCoalesced('doc'); // a poll-storm request coalesced
    recordTimelineCoalesced('doc');
    recordMaintenanceRun('gc', 'ok', 100);
    recordGcLatch(); // the latch was observed during maintenance
    await h.flush();

    const query = points(h, 'ok.timeline.query_duration_ms');
    const coalesced = points(h, 'ok.timeline.coalesced_total');
    const gcLatch = points(h, 'ok.shadow.maintenance.gc_latch_total');

    // Reconstruct the storyline from the two sources alone.
    const reconstruction = {
      walkSaturated: query.some((p) => String(p.attributes.capped) === 'true'),
      wideJournalSignal: query.some((p) => p.attributes.width_bucket === widthBucket(width)),
      // A timeout-storm query is legible as error=true at width/commits 0 — the
      // shape a legitimately-empty doc never carries (it records error=false).
      timeoutStormSignal: query.some(
        (p) =>
          String(p.attributes.error) === 'true' &&
          p.attributes.width_bucket === '0' &&
          p.attributes.commits_bucket === '0',
      ),
      pollStormCoalesced: coalesced.reduce((n, p) => n + (p.value ?? 0), 0) >= 2,
      gcLatchObserved: gcLatch.reduce((n, p) => n + (p.value ?? 0), 0) >= 1,
      refWidth: width,
      looseObjects: objects.looseObjects,
      latchPresent: latch,
    };

    // Every piece of the story is present.
    expect(reconstruction.walkSaturated).toBe(true);
    expect(reconstruction.wideJournalSignal).toBe(true);
    expect(reconstruction.timeoutStormSignal).toBe(true);
    expect(reconstruction.pollStormCoalesced).toBe(true);
    expect(reconstruction.gcLatchObserved).toBe(true);
    expect(reconstruction.refWidth).toBeGreaterThanOrEqual(8);
    expect(reconstruction.latchPresent).toBe(true);
  });
});

describe('gc.log latch counter measures distinct episodes, not observations', () => {
  let h: Harness;
  let tmpDir: string;
  let shadow: ShadowHandle;
  const gcLogPath = (): string => resolve(shadow.gitDir, 'gc.log');
  const gcLatchTotal = (): number =>
    points(h, 'ok.shadow.maintenance.gc_latch_total').reduce((n, p) => n + (p.value ?? 0), 0);

  beforeEach(async () => {
    h = setupHarness();
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-latch-'));
    const projectRoot = resolve(tmpDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    const git = simpleGit(projectRoot);
    await git.init();
    await git.raw('config', 'user.name', 'T');
    await git.raw('config', 'user.email', 't@t');
    writeFileSync(resolve(projectRoot, 'r.md'), '# h\n');
    await git.add('.');
    await git.commit('init');
    shadow = await initShadowRepo(projectRoot);
  });

  afterEach(async () => {
    await h.cleanup();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('a persistent latch counts once across repeated observations', async () => {
    const coord = createMaintenanceCoordinator({ getShadow: () => shadow });

    // A recent gc.log makes `git gc --auto` reliably decline and leave the latch
    // in place, so three runs observe the SAME persistent latch. Pre-fix this
    // incremented once per run (3); the absent->present transition guard makes it
    // ONE episode — what `rate(gc_latch_total)` needs to not conflate a single
    // ~24h latch with a storm of short ones.
    writeFileSync(gcLogPath(), 'warning: prior gc failed\n');
    await coord.runGc('a');
    await coord.runGc('b');
    await coord.runGc('c');
    await h.flush();
    expect(hasGcLogLatch(shadow)).toBe(true); // the latch genuinely persisted
    expect(gcLatchTotal()).toBe(1);
  }, 30_000);
});
