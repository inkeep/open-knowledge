
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const BASELINE_INDEX_GZIPPED_KB = 340.84;

export const TELEMETRY_CHUNK_GZIPPED_KB_MIN = 21;
export const TELEMETRY_CHUNK_GZIPPED_KB_MAX = 23;

export const INDEX_GZIPPED_DELTA_KB_MAX = 2;

const FORBIDDEN_SENTINELS = [
  '__ok_perf',
  'ok-hdr-histogram-v1',
  'ok-typing-burst-detector-v1',
] as const;

export interface BundleHealthReport {
  ok: boolean;
  failures: string[];
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
  distAssetsDir?: string;
}

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
  return join(import.meta.dir, '..', '..', '..', 'dist', 'assets');
}
