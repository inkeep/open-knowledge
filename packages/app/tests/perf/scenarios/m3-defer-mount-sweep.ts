
import { markerFor } from '../lib/doc-markers';
import { installLongtaskObserver } from '../lib/longtask-observer';
import { defineScenario } from '../lib/scenario';

const DEFAULT_THRESHOLDS = [
  Number.MAX_SAFE_INTEGER, // ≈ no-defer-mount (gate.isLarge always false)
  1_500_000,
  500_000, // current shipped value
  200_000,
  100_000,
  0, // ≈ defer-mount-everything (gate.isLarge always true)
];
const DEFAULT_DOCS = ['README', 'AGENTS', 'STORIES'];

const THRESHOLDS = (
  process.env.OK_PERF_M3_THRESHOLDS
    ? process.env.OK_PERF_M3_THRESHOLDS.split(',').map((s) => Number(s.trim()))
    : DEFAULT_THRESHOLDS
).filter((n) => Number.isFinite(n));

const DOCS = (process.env.OK_PERF_M3_DOCS ?? DEFAULT_DOCS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PM_READY_CHARS = 200;
const PM_READY_TIMEOUT_MS = 90_000;
const FIRST_TOGGLE_TIMEOUT_MS = 30_000;
const SETTLE_BETWEEN_CELLS_MS = 500;

interface SweepCell {
  doc: string;
  threshold: number;
  coldLoadMs: number;
  firstToggleMs: number;
  firstToggleSkipped: string | null;
  rendered: boolean;
}

async function waitForVisibleProseMirrorByMarker(
  page: import('@playwright/test').Page,
  docName: string,
  timeoutMs: number,
): Promise<boolean> {
  const marker = markerFor(docName);
  try {
    await page.waitForSelector('.ProseMirror, [aria-label="Loading document"]', {
      state: 'attached',
      timeout: timeoutMs,
    });
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
      { needle: marker, fallbackChars: PM_READY_CHARS },
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

async function runCell(
  page: import('@playwright/test').Page,
  target: string,
  doc: string,
  threshold: number,
  notes: string[],
): Promise<SweepCell> {
  await page.addInitScript((t: number) => {
    (
      globalThis as unknown as {
        __okPerfOverrides?: Record<string, number>;
      }
    ).__okPerfOverrides = { LARGE_DOC_CHAR_THRESHOLD: t };
  }, threshold);

  await page.goto(`${target}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(SETTLE_BETWEEN_CELLS_MS);

  const startWall = Date.now();
  await page.goto(`${target}/#/${encodeURIComponent(doc)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  const rendered = await waitForVisibleProseMirrorByMarker(page, doc, PM_READY_TIMEOUT_MS);
  const coldLoadMs = rendered ? Date.now() - startWall : -1;

  if (!rendered) {
    notes.push(
      `cell doc=${doc} threshold=${threshold}: not rendered within ${PM_READY_TIMEOUT_MS}ms`,
    );
    return {
      doc,
      threshold,
      coldLoadMs,
      firstToggleMs: -1,
      firstToggleSkipped: 'cold-load-failed',
      rendered: false,
    };
  }

  const clickAt = await page.evaluate(() => performance.now());
  let firstToggleMs = -1;
  let firstToggleSkipped: string | null = null;

  const sourceToggle = page.locator('[aria-label="Markdown source"]').first();
  let clicked = false;
  try {
    await sourceToggle.waitFor({ state: 'visible', timeout: 5_000 });
    await sourceToggle.click({ timeout: 5_000 });
    clicked = true;
  } catch {
    firstToggleSkipped = 'toggle-not-found';
    notes.push(`cell doc=${doc} threshold=${threshold}: source toggle not found/clickable`);
  }

  if (clicked) {
    let markStartTime: number | null = null;
    try {
      markStartTime = await page.evaluate(
        ({ minStartTime, timeoutMs }) => {
          return new Promise<number | null>((resolve) => {
            const deadline = performance.now() + timeoutMs;
            const checkExisting = (): number | null => {
              const entries = performance.getEntriesByName('ok/cold/first-toggle');
              for (const e of entries) {
                if (e.startTime >= minStartTime) return e.startTime;
              }
              return null;
            };
            const existing = checkExisting();
            if (existing !== null) {
              resolve(existing);
              return;
            }
            const interval = setInterval(() => {
              const found = checkExisting();
              if (found !== null) {
                clearInterval(interval);
                resolve(found);
                return;
              }
              if (performance.now() > deadline) {
                clearInterval(interval);
                resolve(null);
              }
            }, 50);
          });
        },
        { minStartTime: clickAt, timeoutMs: FIRST_TOGGLE_TIMEOUT_MS },
      );
    } catch {
      markStartTime = null;
    }

    if (markStartTime === null) {
      firstToggleSkipped = 'both-editors-pre-mounted';
    } else {
      firstToggleMs = Math.max(0, Math.round(markStartTime - clickAt));
    }
  }

  return {
    doc,
    threshold,
    coldLoadMs,
    firstToggleMs,
    firstToggleSkipped,
    rendered: true,
  };
}

export default defineScenario({
  name: 'm3-defer-mount-sweep',
  description: 'Sweep LARGE_DOC_CHAR_THRESHOLD × doc, capture coldLoadMs + firstToggleMs per cell.',

  async run(ctx) {
    const { page, opts } = ctx;

    await installLongtaskObserver(page);

    const target = opts.target;
    const notes: string[] = [];

    const sweeps: SweepCell[] = [];
    let cellIndex = 0;
    const totalCells = THRESHOLDS.length * DOCS.length;

    for (const threshold of THRESHOLDS) {
      for (const doc of DOCS) {
        cellIndex += 1;
        ctx.note(`Cell ${cellIndex}/${totalCells}: doc=${doc} threshold=${threshold}`);
        try {
          const cell = await runCell(page, target, doc, threshold, notes);
          sweeps.push(cell);
          ctx.note(
            `  → coldLoadMs=${cell.coldLoadMs} firstToggleMs=${cell.firstToggleMs}` +
              (cell.firstToggleSkipped ? ` skipped=${cell.firstToggleSkipped}` : ''),
          );
        } catch (err) {
          notes.push(
            `cell ${cellIndex}/${totalCells} (doc=${doc} threshold=${threshold}) threw: ${err instanceof Error ? err.message : String(err)}`,
          );
          sweeps.push({
            doc,
            threshold,
            coldLoadMs: -1,
            firstToggleMs: -1,
            firstToggleSkipped: 'cell-error',
            rendered: false,
          });
        }

        await page.waitForTimeout(SETTLE_BETWEEN_CELLS_MS);
      }
    }

    ctx.recordMetric('sweepCount', sweeps.length);
    ctx.recordMetric('sweepsJson', JSON.stringify(sweeps));
    for (const note of notes) ctx.note(note);
  },
});
