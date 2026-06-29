import { markerFor } from '../lib/doc-markers';
import { installLongtaskObserver } from '../lib/longtask-observer';
import { defineScenario } from '../lib/scenario';

const BIG_DOC = process.env.OK_PERF_BIG_DOC ?? 'PROJECT';
const WAIT_CONTENT_MS = 90_000;
const FALLBACK_PM_CHARS = 500;

export default defineScenario({
  name: 'mode-toggle',
  description:
    'S3 repro: toggle Source↔Visual on a large doc and measure wall-clock + layout/style.',

  async run(ctx) {
    const { page, opts } = ctx;

    await installLongtaskObserver(page);

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

    await page.waitForTimeout(500);

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

    await page.waitForTimeout(250);

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
