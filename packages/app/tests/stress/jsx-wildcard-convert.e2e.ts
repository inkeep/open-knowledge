/**
 * Playwright regression pin for the wildcard + render-error
 * auto-convert path in `JsxComponentView`.
 *
 * Bug class this guards against:
 *   `JsxComponentView` registers an effect that schedules a
 *   `requestAnimationFrame` to replace an unregistered `jsxComponent` with
 *   a `rawMdxFallback` (Precedent #30 — "all user content visible and
 *   editable; if a component render fails, the NodeView swaps to a nested
 *   CM"). The effect uses a `convertedRef` one-shot guard. Flipping that
 *   ref BEFORE the rAF fires is StrictMode-unsafe: the intentional
 *   unmount-remount cycle's cleanup cancels the rAF, the ref stays flipped
 *   across remount (refs persist by fiber identity), the remount's effect
 *   early-returns, and no dispatch ever lands. Symptom: unregistered
 *   components render stuck forever on the
 *   "Unknown: `<ComponentName>` — opening source editor..." placeholder.
 *   Production is unaffected (no StrictMode double-invoke); dev, CI, and
 *   any future component-testing tier all hit the bug.
 *
 * This scenario exercises the path end-to-end in a real browser:
 *   - Seed a doc containing an unregistered `<UnknownWidget>` MDX element.
 *   - Open the doc; wait for sync.
 *   - Poll until PM state has a `rawMdxFallback` whose reason names
 *     "UnknownWidget" AND there is no residual `jsxComponent` with
 *     componentName "UnknownWidget".
 *
 * Perturbation: reverting the post-dispatch `convertedRef.current = true`
 * flip — i.e., restoring the pre-dispatch flip — fails
 * this test deterministically. The poll times out because the remount's
 * effect early-returns and the conversion never lands.
 *
 * Intentionally NOT testing implementation details (convertedRef's value,
 * rAF scheduling, StrictMode-specific double-invoke behavior). The
 * assertion is on observable PM state — the node type the user sees and
 * any downstream code consumes.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import { expect, test } from './_helpers';

interface PmNodeSummary {
  type: string;
  componentName: string | null;
  reason: string | null;
}

async function setupDoc(page: Page, api: ApiHelpers, markdown: string): Promise<string> {
  const docName = `jsx-wildcard-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, markdown);
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  return docName;
}

// ── wildcard auto-convert on mount ───────────────────────────────

test('S20: unregistered <UnknownWidget> auto-converts to rawMdxFallback on mount', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    '<UnknownWidget foo="bar">\n\nchildren remain editable\n\n</UnknownWidget>\n',
  );

  // Wait for the auto-convert to land. Condition-based — no wall-clock sleep.
  // The rAF fires next frame after mount; StrictMode adds one extra
  // mount-cleanup-remount cycle, so up to a few event-loop turns.
  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      let foundFallback = false;
      let residualJsx = false;
      ed.state.doc.descendants((n: { type: { name: string }; attrs: Record<string, unknown> }) => {
        const cn = n.attrs?.componentName as string | undefined;
        const reason = n.attrs?.reason as string | undefined;
        if (n.type.name === 'rawMdxFallback' && reason?.includes('UnknownWidget')) {
          foundFallback = true;
        }
        if (n.type.name === 'jsxComponent' && cn === 'UnknownWidget') {
          residualJsx = true;
        }
      });
      return foundFallback && !residualJsx;
    },
    null,
    { timeout: 5_000 },
  );

  // Final assertion — identical shape to the waitForFunction predicate, so
  // a failure on this line means the post-condition wasn't stable at read
  // time (not that the wait itself timed out).
  const summary = await page.evaluate(() => {
    const ed = window.__activeEditor;
    if (!ed) return null;
    const nodes: PmNodeSummary[] = [];
    ed.state.doc.descendants((n: { type: { name: string }; attrs: Record<string, unknown> }) => {
      nodes.push({
        type: n.type.name,
        componentName: (n.attrs?.componentName as string | undefined) ?? null,
        reason: (n.attrs?.reason as string | undefined) ?? null,
      });
    });
    return nodes;
  });
  expect(summary).not.toBeNull();
  const fallbacks = summary?.filter(
    (n) => n.type === 'rawMdxFallback' && n.reason?.includes('UnknownWidget'),
  );
  const residualJsxForUnknown = summary?.filter(
    (n) => n.type === 'jsxComponent' && n.componentName === 'UnknownWidget',
  );
  expect(fallbacks).toHaveLength(1);
  expect(residualJsxForUnknown).toHaveLength(0);
});
