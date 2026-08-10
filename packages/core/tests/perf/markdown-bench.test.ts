/**
 * Markdown pipeline benchmark harness.
 *
 * Measures `parse`, `serialize`, and round-trip latency at the pinned block
 * counts from `fixtures/perf/`. Emits a structured JSON record
 * to `packages/core/tests/perf/results.<timestamp>.json` consumed by the
 * regression gate.
 *
 * GATING. This file is intentionally auto-skipped unless `RUN_BENCH=1`.
 * Rationale: `pnpm check` walks the monorepo via turbo and must stay in
 * the 20-30s warm window. A 20K-block parse alone
 * is seconds, and the warm-up discipline below runs that 11 times per
 * block count — benchmark time is minutes, not seconds. A tier-2 runner
 * invokes this file explicitly via `pnpm run test:perf:bench`, which sets
 * the env var through the matching turbo.json task.
 *
 * METHODOLOGY (pinned; changes require a baseline re-measurement):
 *   - 10 warm-up iterations per (op, blockCount)
 *   - `globalThis.gc?.()` between every measured run. Under Node this is a
 *     full GC ONLY when the runner is started with `--expose-gc`, and a
 *     silent no-op otherwise, so `methodology.gcBetweenRuns` in the output
 *     records what the run actually did rather than what it intended. A
 *     forced-GC baseline and a no-GC fresh run are not comparable — the
 *     regression gate warns when they are mixed.
 *   - performance.now() deltas, collected into a run array, reduced to
 *     {p50, p95, p99, min, max, mean}
 *   - Runner metadata (runtime versions, git sha, hostname, cpu, ram)
 *     embedded in the output so future runs are comparable across machines.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, hostname, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { sharedExtensions } from '../../src/extensions/shared.ts';
import {
  loadPerfFixture,
  PERF_BLOCK_COUNTS,
  type PerfBlockCount,
} from '../../src/markdown/fixtures/index.ts';
// Relative imports keep module resolution predictable inside nested
// worktrees.
import { MarkdownManager } from '../../src/markdown/index.ts';

// ───────────────────────── Gating ─────────────────────────────────────────

const BENCH_ENABLED = process.env.RUN_BENCH === '1' || process.env.RUN_BENCH === 'true';

const describeBench = BENCH_ENABLED ? describe : describe.skip;

// ───────────────────────── Methodology constants ──────────────────────────

const WARMUP_ITERS = 10;
const MEASURED_ITERS = 10;

// ───────────────────────── Stats helpers ──────────────────────────────────

interface Stats {
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  /**
   * Nominal 99th percentile. With `MEASURED_ITERS = 10`,
   * `Math.floor(0.99 * 10) = 9` → this degenerates to the max sample;
   * with `MEASURED_ITERS = 20` it would be the 19th of 20, i.e. still
   * the max. The regression-gate floor formula
   * (`max(2σ, 10% × baseline.p99)`) inherits that property — the 10%
   * floor is anchored to a worst-of-10 observation, not a steady-state
   * p99. We keep the field named `p99` for config-schema stability; the
   * σ arm of the formula (calibrated across multiple runs) provides the
   * noise-aware term. Raising `MEASURED_ITERS` to ≥100 would make this a
   * genuine p99 but invalidates `baseline.json` and lengthens the bench.
   */
  p99: number;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p: number) => {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  };
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    mean: sum / samples.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
  };
}

// ───────────────────────── Runner metadata ────────────────────────────────

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Ask git for the measured commit rather than reading refs by hand.
 *
 * The obvious hand-rolled version is wrong in the environment this repo is
 * usually developed in: a linked worktree's gitdir holds only `HEAD`, while
 * `refs/heads/*` and `packed-refs` live in the common directory reached via
 * `commondir`. Resolving `HEAD` there and then reading the branch ref beside it
 * misses, so every result captured from a worktree recorded `gitSha: "unknown"`
 * and was stranded from the commit it measured. `git rev-parse` already handles
 * commondir, packed refs, detached HEAD and symbolic refs. It runs once during
 * metadata collection, well outside the measured loop.
 */
function readGitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: HARNESS_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

/** Vitest is the measurement substrate; a major/minor bump invalidates the baseline. */
function readVitestVersion(): string {
  try {
    return createRequire(import.meta.url)('vitest/package.json').version ?? 'unknown';
  } catch (err) {
    // Not fatal, but `vitestVersion` is not covered by the gate's mismatch
    // warnings, so a silent "unknown" would quietly weaken the provenance a
    // re-baseline is attributed by.
    console.warn(`[bench] could not resolve the vitest version: ${String(err)}`);
    return 'unknown';
  }
}

interface RunnerInfo {
  nodeVersion: string;
  vitestVersion: string;
  gitSha: string;
  hostname: string;
  cpuModel: string;
  cpuCores: number;
  ramGB: number;
  platform: string;
  runnerClass: string;
}

function runnerInfo(): RunnerInfo {
  const cpuList = cpus();
  return {
    nodeVersion: process.versions.node,
    vitestVersion: readVitestVersion(),
    gitSha: readGitSha(),
    hostname: hostname(),
    cpuModel: cpuList[0]?.model ?? 'unknown',
    cpuCores: cpuList.length,
    ramGB: Math.round(totalmem() / 1024 ** 3),
    platform: `${process.platform}-${process.arch}`,
    runnerClass: process.env.BENCH_RUNNER_CLASS ?? 'local',
  };
}

// ───────────────────────── Measurement ────────────────────────────────────

/**
 * Whether a forced GC is actually available this run. `globalThis.gc` only
 * exists under `--expose-gc`; without it the GC call below is a no-op and the
 * run is not comparable to a forced-GC baseline.
 */
const GC_FORCED = typeof (globalThis as { gc?: () => void }).gc === 'function';

/**
 * Run `op` `n` times, calling `gc?.()` between runs — a forced collection only
 * under `--expose-gc`, a no-op otherwise. Returns per-run ms deltas.
 */
function measure(op: () => void, n: number): number[] {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    (globalThis as { gc?: () => void }).gc?.();
    const t0 = performance.now();
    op();
    samples.push(performance.now() - t0);
  }
  return samples;
}

interface BlockResult {
  blockCount: PerfBlockCount;
  docSizeChars: number;
  parseMs: Stats;
  serializeMs: Stats;
  roundTripMs: Stats;
}

function benchmarkBlockCount(mm: MarkdownManager, blockCount: PerfBlockCount): BlockResult {
  const md = loadPerfFixture(blockCount);

  // Warm up — 10 iters per op, discarded.
  for (let i = 0; i < WARMUP_ITERS; i++) mm.parse(md);
  const pmWarm = mm.parse(md);
  for (let i = 0; i < WARMUP_ITERS; i++) mm.serialize(pmWarm);

  // Measured runs — parse, serialize, round-trip are measured independently.
  const parseSamples = measure(() => {
    mm.parse(md);
  }, MEASURED_ITERS);
  const pm = mm.parse(md);
  const serializeSamples = measure(() => {
    mm.serialize(pm);
  }, MEASURED_ITERS);
  const roundTripSamples = measure(() => {
    mm.serialize(mm.parse(md));
  }, MEASURED_ITERS);

  return {
    blockCount,
    docSizeChars: md.length,
    parseMs: stats(parseSamples),
    serializeMs: stats(serializeSamples),
    roundTripMs: stats(roundTripSamples),
  };
}

// ───────────────────────── Test ───────────────────────────────────────────

describeBench('markdown pipeline benchmark harness (R1)', () => {
  test(
    'parse/serialize/round-trip at pinned block counts',
    () => {
      const mm = new MarkdownManager({ extensions: sharedExtensions });
      const startedAt = new Date().toISOString();
      const results: BlockResult[] = [];
      for (const count of PERF_BLOCK_COUNTS) {
        const result = benchmarkBlockCount(mm, count);
        results.push(result);
        // Stream each block-count row as we finish so a crash at 20K still
        // leaves us with smaller-count rows on stdout.
        console.log(
          `[bench] ${count} blocks (${result.docSizeChars.toLocaleString()} chars): ` +
            `parse p50=${result.parseMs.p50.toFixed(1)}ms p99=${result.parseMs.p99.toFixed(1)}ms | ` +
            `serialize p50=${result.serializeMs.p50.toFixed(1)}ms p99=${result.serializeMs.p99.toFixed(1)}ms`,
        );
        // Sanity: no block count should regress to 0ms — indicates a broken
        // measurement or a skipped op.
        expect(result.parseMs.p50).toBeGreaterThan(0);
        expect(result.serializeMs.p50).toBeGreaterThan(0);
      }

      const output = {
        schemaVersion: 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        methodology: {
          warmupIters: WARMUP_ITERS,
          measuredIters: MEASURED_ITERS,
          gcBetweenRuns: GC_FORCED,
        },
        runner: runnerInfo(),
        results,
      };

      const stamp = startedAt.replace(/[:.]/g, '-');
      const target = resolve(HARNESS_DIR, `results.${stamp}.json`);
      writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
      console.log(`[bench] wrote ${target}`);
    },
    // Long timeout: 20K-block parse × 10 measured runs + warmups can exceed
    // 2 minutes on slower runners. Individual ops are checked above; this
    // bound only prevents runaway.
    10 * 60_000,
  );
});
