
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

async function captureTopConstructors(
  cdp: import('@playwright/test').CDPSession,
  topN: number,
): Promise<ConstructorBucket[]> {
  const chunks: string[] = [];
  const handler = (event: CdpHeapSnapshotChunkEvent): void => {
    chunks.push(event.chunk);
  };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', handler);
  try {
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
      await page.goto(`${opts.target}/#/`, { waitUntil: 'domcontentloaded' });
      await forceGc(cdp);
      const stageBMb = await readHeapMb(page);
      ctx.recordMetric(`${doc}_stageB_MB`, round2(stageBMb));

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
