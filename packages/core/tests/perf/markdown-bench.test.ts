import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, hostname, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedExtensions } from '../../src/extensions/shared.ts';
import {
  loadPerfFixture,
  PERF_BLOCK_COUNTS,
  type PerfBlockCount,
} from '../../src/markdown/fixtures/index.ts';
import { MarkdownManager } from '../../src/markdown/index.ts';

const BENCH_ENABLED = process.env.RUN_BENCH === '1' || process.env.RUN_BENCH === 'true';

const describeBench = BENCH_ENABLED ? describe : describe.skip;

const WARMUP_ITERS = 10;
const MEASURED_ITERS = 10;

interface Stats {
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
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

function readGitSha(): string {
  try {
    const head = readFileSync(resolve(process.cwd(), '.git/HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = head.slice(5);
      return readFileSync(resolve(process.cwd(), '.git', refPath), 'utf8').trim();
    }
    return head;
  } catch {
    return 'unknown';
  }
}

interface RunnerInfo {
  bunVersion: string;
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
    bunVersion: process.versions.bun ?? 'unknown',
    gitSha: readGitSha(),
    hostname: hostname(),
    cpuModel: cpuList[0]?.model ?? 'unknown',
    cpuCores: cpuList.length,
    ramGB: Math.round(totalmem() / 1024 ** 3),
    platform: `${process.platform}-${process.arch}`,
    runnerClass: process.env.BENCH_RUNNER_CLASS ?? 'local',
  };
}

function measure(op: () => void, n: number): number[] {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    if (typeof (Bun as { gc?: (force: boolean) => void }).gc === 'function') {
      (Bun as unknown as { gc: (force: boolean) => void }).gc(true);
    }
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

  for (let i = 0; i < WARMUP_ITERS; i++) mm.parse(md);
  const pmWarm = mm.parse(md);
  for (let i = 0; i < WARMUP_ITERS; i++) mm.serialize(pmWarm);

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

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));

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
        console.log(
          `[bench] ${count} blocks (${result.docSizeChars.toLocaleString()} chars): ` +
            `parse p50=${result.parseMs.p50.toFixed(1)}ms p99=${result.parseMs.p99.toFixed(1)}ms | ` +
            `serialize p50=${result.serializeMs.p50.toFixed(1)}ms p99=${result.serializeMs.p99.toFixed(1)}ms`,
        );
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
          gcBetweenRuns: true,
        },
        runner: runnerInfo(),
        results,
      };

      const stamp = startedAt.replace(/[:.]/g, '-');
      const target = resolve(HARNESS_DIR, `results.${stamp}.json`);
      writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
      console.log(`[bench] wrote ${target}`);
    },
    10 * 60_000,
  );
});
