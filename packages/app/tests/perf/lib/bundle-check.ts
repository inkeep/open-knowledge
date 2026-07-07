/**
 * Bundle-health assertions.
 *
 * Pins the load-bearing tree-shake outcomes that prove the substrate's
 * DEV-only DCE pattern works:
 *   1. The lazy `telemetry-impl-*.js` OTel chunk is in the documented
 *      ~22 KB ± 1 KB gzipped size band.
 *   2. The `__ok_perf` collector global is absent from every prod chunk.
 *   3. The hand-rolled Histogram class sentinel
 *      (`ok-hdr-histogram-v1`) is absent from prod chunks.
 *   4. The typing-burst-detector sentinel
 *      (`ok-typing-burst-detector-v1`) is absent from prod chunks.
 *   5. The main `index-*.js` gzipped size has not regressed by more
 *      than 2 KB vs the pre-spec baseline.
 *
 * Run after `bun run build` in `packages/app`. The test that drives
 * this skips with a warning if `dist/` is absent — local convenience;
 * CI builds before invoking.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Baseline for `index-*.js` gzipped size,
 * recorded in KB. The assertion below tolerates +2 KB gzipped delta;
 * larger regressions fail.
 */
export const BASELINE_INDEX_GZIPPED_KB = 340.84;

/** Tolerance band for the OTel lazy chunk in gzipped KB. */
export const TELEMETRY_CHUNK_GZIPPED_KB_MIN = 21;
export const TELEMETRY_CHUNK_GZIPPED_KB_MAX = 23;

/** Tolerance for index gzipped delta in KB. */
export const INDEX_GZIPPED_DELTA_KB_MAX = 2;

/** Forbidden literal — proves the DEV-only collector tree-shook. */
const FORBIDDEN_SENTINELS = [
  '__ok_perf',
  'ok-hdr-histogram-v1',
  'ok-typing-burst-detector-v1',
] as const;

export interface BundleHealthReport {
  ok: boolean;
  failures: string[];
  // Diagnostic info
  telemetryChunkGzippedKb?: number;
  indexGzippedKb?: number;
  forbiddenHits: Array<{ chunk: string; sentinel: string }>;
}

function readChunk(distAssetsDir: string, file: string): { raw: Buffer; gzipped: number } {
  const raw = readFileSync(join(distAssetsDir, file));
  const gz = gzipSync(raw);
  return { raw, gzipped: gz.byteLength };
}

function findFirstMatching(distAssetsDir: string, prefix: string): string | undefined {
  const files = readdirSync(distAssetsDir);
  return files.find((f) => f.startsWith(prefix) && f.endsWith('.js'));
}

export interface AssertBundleHealthOpts {
  /** Absolute path to `packages/app/dist/assets`. Defaults to repo-relative. */
  distAssetsDir?: string;
}

/**
 * Run all 5 assertions. Returns a structured report so callers can
 * decide between hard-fail and soft-warn (e.g. CI variant where dist/
 * isn't built fresh).
 */
export function assertBundleHealth(opts: AssertBundleHealthOpts = {}): BundleHealthReport {
  const distAssetsDir = opts.distAssetsDir ?? defaultDistAssetsDir();
  const failures: string[] = [];
  const forbiddenHits: BundleHealthReport['forbiddenHits'] = [];

  if (!existsSync(distAssetsDir)) {
    return {
      ok: false,
      failures: [`dist/assets not found at ${distAssetsDir}; run \`bun run build\` first`],
      forbiddenHits: [],
    };
  }

  // ── Assertion 1: telemetry chunk size band ──────────────────────
  const telemetryChunk = findFirstMatching(distAssetsDir, 'telemetry-impl-');
  let telemetryChunkGzippedKb: number | undefined;
  if (!telemetryChunk) {
    failures.push(
      `Expected dist/assets/telemetry-impl-*.js to exist (Vite emits the lazy chunk for every build).`,
    );
  } else {
    const { gzipped } = readChunk(distAssetsDir, telemetryChunk);
    telemetryChunkGzippedKb = Math.round((gzipped / 1024) * 100) / 100;
    if (
      telemetryChunkGzippedKb < TELEMETRY_CHUNK_GZIPPED_KB_MIN ||
      telemetryChunkGzippedKb > TELEMETRY_CHUNK_GZIPPED_KB_MAX
    ) {
      failures.push(
        `telemetry-impl chunk gzipped = ${telemetryChunkGzippedKb} KB; expected [${TELEMETRY_CHUNK_GZIPPED_KB_MIN}, ${TELEMETRY_CHUNK_GZIPPED_KB_MAX}] KB.`,
      );
    }
  }

  // ── Assertions 2-4: forbidden sentinels in main / non-telemetry chunks ──
  const allFiles = readdirSync(distAssetsDir).filter(
    (f) => f.endsWith('.js') && !f.startsWith('telemetry-impl-'),
  );
  for (const file of allFiles) {
    const text = readFileSync(join(distAssetsDir, file), 'utf8');
    for (const sentinel of FORBIDDEN_SENTINELS) {
      if (text.includes(sentinel)) {
        forbiddenHits.push({ chunk: file, sentinel });
        failures.push(
          `Forbidden sentinel '${sentinel}' found in prod chunk '${file}' — the DEV-only DCE regressed.`,
        );
      }
    }
  }

  // ── Assertion 5: index chunk gzipped size delta ─────────────────
  const indexChunk = findFirstMatching(distAssetsDir, 'index-');
  let indexGzippedKb: number | undefined;
  if (indexChunk) {
    const { gzipped } = readChunk(distAssetsDir, indexChunk);
    indexGzippedKb = Math.round((gzipped / 1024) * 100) / 100;
    const delta = indexGzippedKb - BASELINE_INDEX_GZIPPED_KB;
    if (delta > INDEX_GZIPPED_DELTA_KB_MAX) {
      failures.push(
        `index-*.js gzipped = ${indexGzippedKb} KB (baseline ${BASELINE_INDEX_GZIPPED_KB} KB); delta +${delta.toFixed(2)} KB exceeds the +${INDEX_GZIPPED_DELTA_KB_MAX} KB tolerance.`,
      );
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    telemetryChunkGzippedKb,
    indexGzippedKb,
    forbiddenHits,
  };
}

function defaultDistAssetsDir(): string {
  // From packages/app/tests/perf/lib/ → packages/app/dist/assets/.
  return join(import.meta.dir, '..', '..', '..', 'dist', 'assets');
}
