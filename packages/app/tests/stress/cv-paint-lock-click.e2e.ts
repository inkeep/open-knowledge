/**
 * Renderer-survival pin: a click into the editor must survive an ancestor
 * gaining a `content-visibility` paint lock within the same input dispatch.
 *
 * Blink hard-CHECKs (`third_party/blink/renderer/core/layout/hit_test_result.cc`,
 * `LockedAncestorPreventingPaint`) when a mouse press's hit-tested node has —
 * or synchronously gains — a paint-blocked ancestor (`content-visibility:
 * hidden`, or an off-viewport `content-visibility: auto`) between input
 * dispatch and the click's default selection resolution. The whole renderer
 * process dies; the desktop shell auto-reloads the window, which users
 * experience as an app reboot. `pointer-events: none` on the locked subtree
 * does NOT prevent it — the hit test is captured before the lock lands.
 *
 * OK stamps such locks onto hit-testable editor subtrees: `.ok-mode-hidden`
 * (`content-visibility: hidden`, globals.css) on the inactive dual-editor
 * pane via `EditorActivityPool.tsx`'s per-render className swap, and
 * `.ok-chunk-wrapper` (`content-visibility: auto`, globals.css) on every
 * top-level PM block via `chunk-wrapper-decoration.ts`. A React
 * discrete-event render (mode flip, plugin/config cascade — e.g. toggling the
 * markdownlint plugin, which clears block decorations across the whole doc)
 * lands the class inside the click's dispatch, after the hit test but before
 * selection resolution. This test reproduces that timing deterministically
 * with a capture-phase mousedown listener stamping the app's own class on the
 * app's own DOM, then asserts the renderer survived.
 *
 * Only the `.ok-mode-hidden` site is pinned here. The `.ok-chunk-wrapper`
 * (cv:auto) site shares the same invariant and the same fix surface, but its
 * crashing precondition — a paint-locked (off-viewport) wrapper as ancestor
 * of a hit-tested node — is not deterministically constructible from script:
 * cv:auto lock state flips only at rendering-update time, never inside an
 * input dispatch (verified empirically: removing + re-applying the class with
 * forced layout inside the mousedown does not paint-lock an on-viewport
 * block, so no crash), and a click cannot land inside an off-viewport block.
 *
 * This seam only exists in a real Chromium layout/paint engine — jsdom has
 * no display-lock machinery, so the pin lives at Playwright fidelity.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import { expect, test } from './_helpers';

const DOC_MARKDOWN = [
  '# Survival doc',
  '',
  'First paragraph with enough text to give the click a stable target.',
  '',
  'Second paragraph so the doc has several top-level blocks.',
].join('\n');

/** Isolated per-test doc: create, seed, navigate, wait for editor mount. */
async function setupDoc(page: Page, api: ApiHelpers): Promise<string> {
  const docName = `test-cvlock-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, DOC_MARKDOWN);
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror) p');
  return docName;
}

type ClickOutcome = 'alive' | 'renderer-crashed';

/**
 * Press-and-release on the first editor paragraph, then classify whether the
 * renderer survived. Raced against the page `crash` event because a dead
 * renderer can leave the in-flight input protocol call hanging (it would
 * otherwise burn the whole test budget before the assertion runs); either
 * signal classifies as `renderer-crashed` so the test fails on the assertion,
 * not on infrastructure noise.
 */
async function clickFirstParagraphAndProbe(page: Page): Promise<ClickOutcome> {
  const crashed = new Promise<ClickOutcome>((resolve) => {
    page.once('crash', () => resolve('renderer-crashed'));
  });
  const target = page.locator('.ProseMirror:not(.composer-prosemirror) p').first();
  const box = await target.boundingBox();
  if (!box) throw new Error('editor paragraph has no bounding box');
  const x = box.x + Math.min(24, box.width / 2);
  const y = box.y + box.height / 2;
  const clickAndProbe = (async (): Promise<ClickOutcome> => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();
    // Liveness probe: a crashed page rejects (or never answers) evaluate.
    await page.evaluate(() => document.readyState);
    return 'alive';
  })().catch((): ClickOutcome => 'renderer-crashed');
  return await Promise.race([crashed, clickAndProbe]);
}

test('click into the editor survives the inactive-pane paint lock (.ok-mode-hidden) landing mid-dispatch', async ({
  page,
  api,
}) => {
  await setupDoc(page, api);

  // Arm: on the next mousedown (capture phase — before PM's own handlers and
  // before Blink's default selection handling), stamp the app's own
  // `.ok-mode-hidden` class on the visual editor pane — the same element
  // EditorActivityPool's className swap targets — and force style+layout so
  // the paint lock is committed inside this dispatch.
  await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
    const pane = pm
      ?.closest('div.relative.flex-1')
      ?.querySelector(':scope > div.h-full:not(.ok-mode-hidden)');
    if (!(pane instanceof HTMLElement)) throw new Error('visual editor pane not found');
    window.addEventListener(
      'mousedown',
      () => {
        pane.classList.add('ok-mode-hidden');
        void pane.offsetHeight;
      },
      { capture: true, once: true },
    );
  });

  const outcome = await clickFirstParagraphAndProbe(page);
  expect(
    outcome,
    'renderer must survive a click whose editor pane gains the .ok-mode-hidden paint lock during the same dispatch',
  ).toBe('alive');
});
