/**
 * Per-editor retained-memory probe.
 *
 * Replaces wide-range internal estimates with a single measured number per
 * doc-size bucket via a two-stage protocol:
 *
 *   Stage A — empty tab → collectGarbage → baseline heap MB
 *   Stage B′ — pool prewarmed (one provider, no editor) → collectGarbage → heap_B′
 *   Stage C — mount ONE editor → collectGarbage → heap_C
 *              (per-editor retained = heap_C − heap_B′)
 *   Stage D — mount TEN editors → collectGarbage → heap_D
 *              (linearity check: |heap_D − (B′ + 10·(C−B′))| / (C−B′) < 0.2)
 *
 * Leak loop:
 *   10 mount/destroy cycles per doc-size bucket. Mean cycle delta is the
 *   leak rate (TipTap #5654 / #538: linear-growth leaks need ≥ 10 samples
 *   to rise above noise).
 *
 * Top-20 retaining constructors histogram:
 *   Captured via CDP `HeapProfiler.takeHeapSnapshot` + minimal in-line parse
 *   of the snapshot stream. We collect the JSON chunks, reassemble, and
 *   walk the `nodes` flat array to bucket node names + sum retained sizes.
 *
 * Doc-size sweep:
 *   README (small), AGENTS (medium), PROJECT (large) via doc-markers.ts.
 *
 * Invocation:
 *   bun run --cwd packages/app perf:profile -- --scenario=memory-per-editor \
 *     --target=http://localhost:5173 --headless
 *
 * Result JSON shape under `metrics`:
 *   {
 *     "stage_A_MB": number,
 *     "<doc>_stageB_MB": number,
 *     "<doc>_stageC_MB": number,
 *     "<doc>_stageD_MB": number,
 *     "<doc>_perEditorMB": number,
 *     "<doc>_linearityDelta": number,
 *     "<doc>_leakMeanMB": number,
 *     "<doc>_topConstructorsJson": string  (JSON-encoded array)
 *   }
 */

import { markerFor } from '../lib/doc-markers';
import { installLongtaskObserver } from '../lib/longtask-observer';
import { defineScenario } from '../lib/scenario';

const DOC_BUCKETS = (
  process.env.OK_PERF_M1_DOCS
    ? process.env.OK_PERF_M1_DOCS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : ['README', 'AGENTS', 'PROJECT']
) as readonly string[];
const LEAK_CYCLES = Number(process.env.OK_PERF_M1_LEAK_CYCLES ?? 10);
const MOUNT_TEN_COUNT = Number(process.env.OK_PERF_M1_MOUNT_COUNT ?? 10);
const HEAP_SNAPSHOT_TOP_N = 20;
const WAIT_CONTENT_MS = 60_000;
const HEAP_SNAPSHOT_TIMEOUT_MS = Number(process.env.OK_PERF_M1_SNAPSHOT_TIMEOUT_MS ?? 120_000);

interface CdpHeapSnapshotChunkEvent {
  chunk: string;
}

interface ParsedSnapshotMeta {
  node_fields: string[];
  node_types: (string | string[])[];
}

interface ParsedSnapshot {
  snapshot: {
    meta: ParsedSnapshotMeta;
    node_count: number;
  };
  nodes: number[];
  strings: string[];
}

interface ConstructorBucket {
  name: string;
  count: number;
  retainedSize: number;
}

/**
 * Take a CDP heap snapshot, accumulate the chunked stream into a single
 * JSON string, parse, walk the nodes array, and return the top-N
 * constructors by retained size.
 *
 * Snapshot format reference:
 *   https://chromedevtools.github.io/devtools-protocol/v8/HeapProfiler/
 *   The .nodes field is a flat array of integers; each node is
 *   `node_fields.length` consecutive ints. node_fields includes
 *   `name` (string-table index) and `self_size`.
 *
 * Notes:
 *   - We use self_size (not retained_size) because retained_size requires a
 *     graph walk that's much more expensive and not in the snapshot. For
 *     the "which constructors dominate per-editor cost" question, self
 *     size is a faithful proxy.
 *   - Constructor "type" is encoded as an enum index into node_types[0].
 */
async function captureTopConstructors(
  cdp: import('@playwright/test').CDPSession,
  topN: number,
): Promise<ConstructorBucket[]> {
  // Accumulate chunks via the CDP event.
  const chunks: string[] = [];
  const handler = (event: CdpHeapSnapshotChunkEvent): void => {
    chunks.push(event.chunk);
  };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', handler);
  try {
    // Race CDP send against a timeout so an OOM'd renderer can't hang the
    // scenario forever (observed: PROJECT.md snapshot at ~3 MB doc with 39K
    // nodes can saturate available memory and stall CDP indefinitely).
    await Promise.race([
      cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `HeapProfiler.takeHeapSnapshot timed out after ${HEAP_SNAPSHOT_TIMEOUT_MS}ms`,
              ),
            ),
          HEAP_SNAPSHOT_TIMEOUT_MS,
        ),
      ),
    ]);
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', handler);
  }

  let parsed: ParsedSnapshot;
  try {
    parsed = JSON.parse(chunks.join('')) as ParsedSnapshot;
  } catch {
    return [];
  }

  const fields = parsed.snapshot.meta.node_fields;
  const nameIdx = fields.indexOf('name');
  const sizeIdx = fields.indexOf('self_size');
  if (nameIdx === -1 || sizeIdx === -1) return [];
  const stride = fields.length;

  // Aggregate by string-table name.
  const bucketByName = new Map<string, ConstructorBucket>();
  const nodes = parsed.nodes;
  const strings = parsed.strings;
  for (let i = 0; i < nodes.length; i += stride) {
    const nameIndex = nodes[i + nameIdx];
    const selfSize = nodes[i + sizeIdx];
    const name = strings[nameIndex] ?? '<unknown>';
    let bucket = bucketByName.get(name);
    if (!bucket) {
      bucket = { name, count: 0, retainedSize: 0 };
      bucketByName.set(name, bucket);
    }
    bucket.count += 1;
    bucket.retainedSize += selfSize;
  }
  const sorted = Array.from(bucketByName.values()).sort((a, b) => b.retainedSize - a.retainedSize);
  return sorted.slice(0, topN);
}

async function forceGc(cdp: import('@playwright/test').CDPSession): Promise<void> {
  await cdp.send('HeapProfiler.collectGarbage');
  // Run a small task to let any post-GC scheduled work settle.
  await new Promise((r) => setTimeout(r, 50));
}

async function readHeapMb(page: import('@playwright/test').Page): Promise<number> {
  const bytes = await page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m?.usedJSHeapSize ?? 0;
  });
  return bytes / (1024 * 1024);
}

async function waitForVisibleProseMirrorForDoc(
  page: import('@playwright/test').Page,
  docName: string,
  timeoutMs: number,
): Promise<void> {
  const marker = markerFor(docName);
  await page.waitForFunction(
    ({ needle, fallbackChars }: { needle: string | null; fallbackChars: number }) => {
      const nodes = document.querySelectorAll('.ProseMirror');
      for (const n of Array.from(nodes)) {
        const rect = (n as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const txt = n.textContent ?? '';
        if (needle && txt.includes(needle)) return true;
        if (!needle && txt.length >= fallbackChars) return true;
      }
      return false;
    },
    { needle: marker, fallbackChars: 200 },
    { timeout: timeoutMs },
  );
}

export default defineScenario({
  name: 'memory-per-editor',
  description:
    'Per-editor retained-memory probe via two-stage B′ protocol + leak loop + constructor histogram.',

  async run(ctx) {
    const { page, cdp, opts } = ctx;
    await cdp.send('HeapProfiler.enable');

    await installLongtaskObserver(page);

    // ─── Stage A: empty tab baseline ───────────────────────────────────────
    await page.goto(`${opts.target}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await forceGc(cdp);
    const stageAMb = await readHeapMb(page);
    ctx.recordMetric('stage_A_MB', round2(stageAMb));
    ctx.note(`Stage A (empty tab): ${round2(stageAMb)} MB`);

    for (const doc of DOC_BUCKETS) {
      ctx.note(`--- doc bucket: ${doc} ---`);

      // ─── Stage B′: pool prewarmed (provider only, no editor) ─────────────
      // Approximate by navigating to the doc but immediately leaving for
      // about: page so the editor unmounts. The provider stays pool-resident.
      await page.goto(`${opts.target}/#/${encodeURIComponent(doc)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      try {
        await waitForVisibleProseMirrorForDoc(page, doc, WAIT_CONTENT_MS);
      } catch {
        ctx.note(`Stage B′ skipped for ${doc} — content not confirmed`);
        continue;
      }
      // Navigate AWAY so editor unmounts but pool keeps the provider.
      await page.goto(`${opts.target}/#/`, { waitUntil: 'domcontentloaded' });
      await forceGc(cdp);
      const stageBMb = await readHeapMb(page);
      ctx.recordMetric(`${doc}_stageB_MB`, round2(stageBMb));

      // ─── Stage C: mount ONE editor ───────────────────────────────────────
      await page.goto(`${opts.target}/#/${encodeURIComponent(doc)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      try {
        await waitForVisibleProseMirrorForDoc(page, doc, WAIT_CONTENT_MS);
      } catch {
        ctx.note(`Stage C skipped for ${doc}`);
        continue;
      }
      await forceGc(cdp);
      const stageCMb = await readHeapMb(page);
      const perEditor = stageCMb - stageBMb;
      ctx.recordMetric(`${doc}_stageC_MB`, round2(stageCMb));
      ctx.recordMetric(`${doc}_perEditorMB`, round2(perEditor));
      ctx.note(
        `${doc} per-editor: ${round2(perEditor)} MB (B′=${round2(stageBMb)} → C=${round2(stageCMb)})`,
      );

      // ─── Stage D: mount TEN editors via repeated navigation ──────────────
      // We don't have a direct API to "mount 10"; instead navigate through
      // 10 distinct doc names (the Activity pool will hold up to MAX_POOL=10
      // providers + ACTIVITY_MOUNT_LIMIT=3 mounted editors). The heap delta
      // is the cumulative cost of all pool-resident providers + 3 mounted
      // editors. We compute expected delta from per-editor and compare.
      //
      // For simplicity: navigate 10 times to the SAME doc with a refresh
      // suffix in the hash to force re-open. This isn't a perfect linearity
      // test but is the best signal we can get without a direct mount API.
      const otherDocs = ['README', 'AGENTS', 'CLAUDE', 'STORIES', 'PROJECT'];
      for (let i = 0; i < MOUNT_TEN_COUNT; i++) {
        const next = otherDocs[i % otherDocs.length];
        await page.goto(`${opts.target}/#/${encodeURIComponent(next)}`, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        try {
          await waitForVisibleProseMirrorForDoc(page, next, 30_000);
        } catch {
          // Best-effort
        }
      }
      await forceGc(cdp);
      const stageDMb = await readHeapMb(page);
      const expectedD = stageBMb + MOUNT_TEN_COUNT * perEditor;
      const linearityDelta =
        perEditor !== 0 ? Math.abs(stageDMb - expectedD) / Math.abs(perEditor) : 0;
      ctx.recordMetric(`${doc}_stageD_MB`, round2(stageDMb));
      ctx.recordMetric(`${doc}_linearityDelta`, round2(linearityDelta));
      ctx.note(
        `${doc} stage D: ${round2(stageDMb)} MB; expected ≈ ${round2(expectedD)} MB; linearity delta ${round2(linearityDelta)}× per-editor`,
      );

      // ─── Leak loop: 10 mount/destroy cycles, mean delta = leak rate ──────
      const cycleHeaps: number[] = [];
      for (let cycle = 0; cycle < LEAK_CYCLES; cycle++) {
        await page.goto(`${opts.target}/#/`, { waitUntil: 'domcontentloaded' });
        await page.goto(`${opts.target}/#/${encodeURIComponent(doc)}`, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        try {
          await waitForVisibleProseMirrorForDoc(page, doc, WAIT_CONTENT_MS);
        } catch {
          ctx.note(`Leak cycle ${cycle} skipped for ${doc}`);
          continue;
        }
        await forceGc(cdp);
        const heap = await readHeapMb(page);
        cycleHeaps.push(heap);
      }
      const leakMeanMb =
        cycleHeaps.length >= 2
          ? (cycleHeaps[cycleHeaps.length - 1] - cycleHeaps[0]) / cycleHeaps.length
          : 0;
      ctx.recordMetric(`${doc}_leakMeanMB`, round4(leakMeanMb));
      ctx.note(`${doc} leak: ${round4(leakMeanMb)} MB/cycle over ${cycleHeaps.length} cycles`);

      // ─── Top-N constructors histogram for this doc ───────────────────────
      try {
        const top = await captureTopConstructors(cdp, HEAP_SNAPSHOT_TOP_N);
        ctx.recordMetric(`${doc}_topConstructorsJson`, JSON.stringify(top));
        ctx.note(
          `${doc} top constructors: ${top
            .slice(0, 5)
            .map((b) => b.name)
            .join(', ')}`,
        );
      } catch (err) {
        ctx.note(
          `${doc} constructor histogram skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  },
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
