/**
 * Reproduction — mode toggle on a large doc.
 *
 * Workflow:
 *   1. Cold-load BIG_DOC (default PROJECT.md) in Visual mode.
 *   2. Click "Markdown source" — wait until the CodeMirror view is visible.
 *   3. Click "Visual editor" — measure wall-clock until the ProseMirror view
 *      is visible again with the big doc's content. The Source→Visual leg
 *      is the one that reproduces the 1.4s style+layout hitch (browser's
 *      deferred recalc on `display:none → visible` for 25K-node DOM).
 *
 * Pre-fix baseline: modeToggleLayoutMs ≥ 300. This metric is derived
 * from the scenario-wide `trace.layoutMs + trace.styleMs` aggregate by the
 * baseline-capture step — the scenario's own `metrics.modeToggleMs`
 * records wall-clock of the Source→Visual click-to-ready pipeline (the
 * user-facing symptom). A minimal pre-ready breather keeps initial-load
 * layout out of the trace proper, making `trace.layoutMs + trace.styleMs`
 * a reasonable approximation of toggle-only layout cost.
 *
 * Post-fix target: either modeToggleLayoutMs < 300 OR documented as
 * architecturally-bounded.
 */

import { markerFor } from '../lib/doc-markers';
import { installLongtaskObserver } from '../lib/longtask-observer';
import { defineScenario } from '../lib/scenario';

const BIG_DOC = process.env.OK_PERF_BIG_DOC ?? 'PROJECT';
const WAIT_CONTENT_MS = 90_000;
// Fallback content threshold when BIG_DOC has no registered marker in
// `lib/doc-markers.ts` — the toggle scenarios require a non-trivial doc,
// so 500 chars is the minimum "meaningful" bar.
const FALLBACK_PM_CHARS = 500;

export default defineScenario({
  name: 'mode-toggle',
  description:
    'S3 repro: toggle Source↔Visual on a large doc and measure wall-clock + layout/style.',

  async run(ctx) {
    const { page, opts } = ctx;

    await installLongtaskObserver(page);

    // ─── Step 1: cold-load the big doc in Visual mode. ──────────────────
    await page.goto(`${opts.target}/#/${encodeURIComponent(BIG_DOC)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await page.waitForSelector('.ProseMirror', {
        state: 'attached',
        timeout: WAIT_CONTENT_MS,
      });
      const marker = markerFor(BIG_DOC);
      if (marker) {
        await page.waitForFunction(
          (needle: string) => {
            const el = document.querySelector('.ProseMirror');
            return Boolean(el && (el.textContent ?? '').includes(needle));
          },
          marker,
          { timeout: WAIT_CONTENT_MS },
        );
      } else {
        await page.waitForFunction(
          (chars: number) => {
            const el = document.querySelector('.ProseMirror');
            return Boolean(el && (el.textContent ?? '').length >= chars);
          },
          FALLBACK_PM_CHARS,
          { timeout: WAIT_CONTENT_MS },
        );
      }
    } catch {
      ctx.note(`Initial load failed: could not confirm ${BIG_DOC} content`);
      ctx.recordMetric('modeToggleMs', -1);
      return;
    }

    // Breathe — let any initial-load layout drain before the toggle leg.
    // 500ms is generous relative to the observer-B baseline-settle bound;
    // the subsequent toggle's layout cost dominates the trace aggregate.
    await page.waitForTimeout(500);

    // ─── Step 2: Visual → Source. ───────────────────────────────────────
    const sourceToggle = page.getByRole('radio', { name: 'Markdown source' });
    const visualToggle = page.getByRole('radio', { name: 'Visual editor' });

    await sourceToggle.waitFor({ state: 'visible', timeout: 10_000 });
    const toSourceAt = Date.now();
    await sourceToggle.click({ timeout: 10_000 });
    try {
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.cm-content');
          if (!el) return false;
          const rect = (el as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (el.textContent ?? '').length > 50;
        },
        null,
        { timeout: WAIT_CONTENT_MS },
      );
    } catch {
      ctx.note('Source toggle failed: CodeMirror did not become visible');
      ctx.recordMetric('modeToggleMs', -1);
      return;
    }
    const toSourceMs = Date.now() - toSourceAt;

    // Breathe again — isolate the Source→Visual leg.
    await page.waitForTimeout(250);

    // ─── Step 3: Source → Visual (the AC-targeted leg). ─────────────────
    await visualToggle.waitFor({ state: 'visible', timeout: 10_000 });
    const toVisualAt = Date.now();
    await visualToggle.click({ timeout: 10_000 });
    try {
      const marker = markerFor(BIG_DOC);
      if (marker) {
        await page.waitForFunction(
          (needle: string) => {
            const el = document.querySelector('.ProseMirror');
            if (!el) return false;
            const rect = (el as HTMLElement).getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && (el.textContent ?? '').includes(needle);
          },
          marker,
          { timeout: WAIT_CONTENT_MS },
        );
      } else {
        await page.waitForFunction(
          (chars: number) => {
            const el = document.querySelector('.ProseMirror');
            if (!el) return false;
            const rect = (el as HTMLElement).getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && (el.textContent ?? '').length >= chars;
          },
          FALLBACK_PM_CHARS,
          { timeout: WAIT_CONTENT_MS },
        );
      }
    } catch {
      ctx.note('Visual toggle failed: ProseMirror did not become visible');
      ctx.recordMetric('modeToggleMs', -1);
      return;
    }
    const toVisualMs = Date.now() - toVisualAt;

    ctx.recordMetric('docName', BIG_DOC);
    ctx.recordMetric('toSourceMs', toSourceMs);
    ctx.recordMetric('modeToggleMs', toVisualMs);
    ctx.note(
      'modeToggleLayoutMs is computed at baseline-capture time (US-005) as trace.layoutMs + trace.styleMs from the scenario-wide aggregate — the pre-ready breather makes this a reasonable approximation of toggle-only layout cost.',
    );
  },
});
