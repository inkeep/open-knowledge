/**
 * Cold-load a large markdown doc and measure TTI.
 *
 * Fresh browser context → goto `#/<BIG_DOC>` → wait for ProseMirror to have
 * meaningful text content visible. The driver captures long tasks, LCP, and
 * layout+style totals via CDP tracing; we additionally install a
 * `PerformanceObserver` for `longtask` so the scenario-side metrics carry
 * the browser's own long-task accounting for cross-check.
 *
 * The big doc is parameterized via OK_PERF_BIG_DOC so the scenario can be
 * re-targeted without editing code (e.g. `OK_PERF_BIG_DOC=CLAUDE bun run
 * perf:profile --scenario=cold-load-big-doc`).
 */

import { installLongtaskObserver, readLongtasks } from '../lib/longtask-observer';
import { defineScenario } from '../lib/scenario';

const BIG_DOC = process.env.OK_PERF_BIG_DOC ?? 'PROJECT';

// ProseMirror textContent threshold that counts as "doc visible". PROJECT.md
// is multi-MB — rendering even the first few blocks exceeds this. README.md
// (5 KB) also clears it trivially, so the threshold is not doc-specific.
const PM_READY_CHARS = 500;

// Upper bound on our wait. 90s gives slow hardware headroom on multi-MB
// docs without hanging the scenario indefinitely.
const PM_READY_TIMEOUT_MS = 90_000;

export default defineScenario({
  name: 'cold-load-big-doc',
  description: 'Cold-load a large doc (default PROJECT.md) and measure TTI + longest task.',

  async run(ctx) {
    const { page, opts } = ctx;

    await installLongtaskObserver(page);

    const url = `${opts.target}/#/${encodeURIComponent(BIG_DOC)}`;
    const startWall = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    let rendered = false;
    try {
      await page.waitForSelector('.ProseMirror', {
        state: 'attached',
        timeout: PM_READY_TIMEOUT_MS,
      });
      await page.waitForFunction(
        (chars: number) => {
          const el = document.querySelector('.ProseMirror');
          return Boolean(el && (el.textContent ?? '').length >= chars);
        },
        PM_READY_CHARS,
        { timeout: PM_READY_TIMEOUT_MS },
      );
      rendered = true;
    } catch {
      ctx.note(
        `ProseMirror did not render ≥${PM_READY_CHARS} chars within ${PM_READY_TIMEOUT_MS}ms — doc may be missing or navigation stalled`,
      );
    }

    const coldLoadMs = Date.now() - startWall;
    ctx.recordMetric('docName', BIG_DOC);
    ctx.recordMetric('coldLoadMs', rendered ? coldLoadMs : -1);
    ctx.recordMetric('rendered', rendered);

    const longTasks = await readLongtasks(page);
    const longestTaskMs = longTasks.reduce((m, t) => Math.max(m, t.duration), 0);
    ctx.recordMetric('observedLongTaskCount', longTasks.length);
    ctx.recordMetric('observedLongestTaskMs', Math.round(longestTaskMs));

    // Sample editor text length as a sanity check — if it is tiny the doc
    // wasn't PROJECT (or whatever was configured) and the coldLoad number
    // will be uninterpretable.
    if (rendered) {
      const pmLen = await page.evaluate(() => {
        const el = document.querySelector('.ProseMirror');
        return el ? (el.textContent ?? '').length : 0;
      });
      ctx.recordMetric('proseMirrorTextLen', pmLen);
    }

    // firstToggleMs measurement.
    //
    // After cold-load completes, dispatch a Visual → Source mode toggle and
    // wait for the `ok/cold/first-toggle` mark. On a large doc with
    // defer-mount active, this measures the cost of the previously-deferred
    // SourceEditor mounting for the first time. On a small doc, both editors
    // are pre-mounted, so the mark never fires — we record null + a note.
    if (rendered) {
      const clickAt = await page.evaluate(() => performance.now());
      ctx.recordMetric('firstToggleClickAtPerf', clickAt);

      // Try to click the Markdown-source toggle. If the button is missing
      // (no header rendered, layout changed, etc.), record skip.
      const sourceToggle = page.locator('[aria-label="Markdown source"]').first();
      let clicked = false;
      try {
        await sourceToggle.waitFor({ state: 'visible', timeout: 5_000 });
        await sourceToggle.click({ timeout: 5_000 });
        clicked = true;
      } catch {
        ctx.note('firstToggle skipped — Markdown-source toggle not found/clickable');
        ctx.recordMetric('firstToggleMs', -1);
        ctx.recordMetric('firstToggleSkipped', 'toggle-not-found');
      }

      if (clicked) {
        // Wait up to 10s for the first-toggle mark; if it doesn't fire, the
        // doc was small enough that defer-mount was inactive (gate.isLarge=false
        // → both editors pre-mounted). Record the skip with the canonical
        // `both-editors-pre-mounted` reason.
        const FIRST_TOGGLE_TIMEOUT_MS = 10_000;
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
          ctx.recordMetric('firstToggleMs', -1);
          ctx.recordMetric('firstToggleSkipped', 'both-editors-pre-mounted');
          ctx.note('firstToggle skipped — no ok/cold/first-toggle mark within 10s (small doc)');
        } else {
          const firstToggleMs = Math.max(0, Math.round(markStartTime - clickAt));
          ctx.recordMetric('firstToggleMs', firstToggleMs);
          ctx.note(`firstToggleMs=${firstToggleMs}`);
        }
      }
    }
  },
});
