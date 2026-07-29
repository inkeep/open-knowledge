/**
 * Behavior E2E for mode-switch position fidelity.
 *
 * Proves the three user-visible landing behaviors against the real running app,
 * with the caret-delta oracle as the primary assertion and geometry containment
 * as a secondary cross-check:
 *
 *   - the plain WYSIWYG->source toggle preserves the topmost block and leaves the
 *     target editor's selection untouched;
 *   - the plain source->WYSIWYG toggle does the same in reverse;
 *   - the explicit "view in source" jump from the selection bubble lands the
 *     block centered with the caret placed at its source start.
 *
 * Plus the terminal-safety contract: a landing that can never settle abandons
 * within its window and stamps the abandoned mark with a target and a delta.
 *
 * Every test seeds its own uniquely-named tall document so parallel workers
 * never share a CRDT doc name, and asserts through the landing oracle in
 * `_helpers/landing.ts`, which measures each editor the way it actually
 * virtualizes and fails loudly on an absent target.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  assertLanded,
  blockMarker,
  expect,
  generateTallDoc,
  landingMarkCount,
  readSourceCaretHead,
  readWysiwygCaretHead,
  scrollWysiwygBlockToTop,
  selectText,
  test,
  toggleMode,
  waitForActiveProviderSynced,
  waitForLandingSettled,
} from './_helpers';

const WYSIWYG = '.ProseMirror:not(.composer-prosemirror)';
const VIEW_IN_SOURCE_BUBBLE = 'view-in-source-bubble-button';
/**
 * The transient highlight a jump paints on the range it landed on, scoped to the
 * source editor. Restated here rather than imported from app src, like the other
 * selectors this suite uses; syntax highlighting splits the decorated range
 * across several spans, so assertions read all of them.
 */
const LANDING_FLASH = '.cm-editor .ok-landing-flash';
/** Deep enough in a 400-block doc that a wrong landing leaves it off-screen. */
const ANCHOR_INDEX = 150;

function docName(label: string): string {
  return `mode-switch-landing-${label}-${randomUUID().slice(0, 8)}`;
}

/** Seed a tall doc, open it, and wait until the WYSIWYG editor is synced + visible. */
async function openTallDoc(page: Page, api: ApiHelpers, name: string): Promise<void> {
  const { markdown } = generateTallDoc({ blockCount: 400 });
  await api.seedDocs([{ name, markdown }]);
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(WYSIWYG).first()).toBeVisible();
}

/**
 * Scroll the anchor block to the top of the WYSIWYG readable area, asserting the
 * setup converged so a later landing has a real position to preserve rather than
 * scrollTop 0. The helper already holds the viewport stable across refinement
 * frames; this only pins that it got there.
 */
async function anchorAtTop(page: Page, marker: string): Promise<void> {
  const residual = await scrollWysiwygBlockToTop(page, marker);
  expect(
    Math.abs(residual),
    'setup scroll did not converge the anchor to the top of the readable area',
  ).toBeLessThan(40);
}

/**
 * Resolve once the shared scroller's `scrollTop` has held still long enough that
 * the composer's 300ms bottom-pin window demonstrably elapsed without moving the
 * settled landing. Polls inside the page and requires consecutive unchanged
 * samples: the e2e STOP rule bans `page.waitForTimeout` as a fixed-delay
 * anti-flake smell, and stability is the property under test anyway — a fixed
 * sleep would only assume it.
 */
async function settleScrollPosition(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const el = document.querySelector<HTMLElement>('[data-testid="editor-scroll-container"]');
        if (!el) {
          reject(new Error('settleScrollPosition: no editor scroll container'));
          return;
        }
        const POLL_MS = 50;
        // 600ms of stillness comfortably outlives the 300ms pin window.
        const REQUIRED_STABLE_TICKS = 12;
        const MAX_TICKS = 120; // ~6s ceiling - fail fast rather than hit Playwright's
        let last = Number.NaN;
        let stableTicks = 0;
        let totalTicks = 0;
        const tick = () => {
          totalTicks += 1;
          if (totalTicks > MAX_TICKS) {
            reject(
              new Error(
                `settleScrollPosition: scrollTop never held still for ${
                  REQUIRED_STABLE_TICKS * POLL_MS
                }ms within ${MAX_TICKS * POLL_MS}ms`,
              ),
            );
            return;
          }
          const now = el.scrollTop;
          stableTicks = now === last ? stableTicks + 1 : 0;
          last = now;
          if (stableTicks >= REQUIRED_STABLE_TICKS) {
            resolve();
            return;
          }
          setTimeout(tick, POLL_MS);
        };
        setTimeout(tick, POLL_MS);
      }),
  );
}

/**
 * Continuously flip the WYSIWYG content-visibility height estimate so a pending
 * landing's target never stops moving. Every off-screen block above the target
 * re-lays-out its `--ok-cv-h` placeholder each tick, shifting the target's
 * content-space position faster than the settle quiet window closes — the "target
 * keeps moving, drift never falls under threshold" condition the abandon path is
 * defined by. Paired with `stopEstimateOscillation`.
 */
async function startEstimateOscillation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const STYLE_ID = 'ok-abandon-oscillation';
    const existing = document.getElementById(STYLE_ID);
    const style = existing instanceof HTMLStyleElement ? existing : document.createElement('style');
    style.id = STYLE_ID;
    if (!existing) document.head.appendChild(style);
    let tall = false;
    const tick = (): void => {
      tall = !tall;
      style.textContent = `:root{--ok-cv-h:${tall ? 1400 : 100}px;}`;
    };
    tick();
    const win = window as unknown as { __okAbandonOsc?: number };
    win.__okAbandonOsc = window.setInterval(tick, 30);
  });
}

/**
 * Assert the landed block is highlighted right now. Reads every decorated span
 * because the source editor's syntax highlighting splits the flashed range, and
 * joins them so the assertion is about the covered text, not one fragment. The
 * computed style is read too: a decorated span the stylesheet no longer paints
 * would still be "visible" while showing the user nothing.
 */
async function expectLandingFlashOn(
  page: Page,
  marker: string,
  opts: { reducedMotion?: boolean } = {},
): Promise<void> {
  const flash = page.locator(LANDING_FLASH);
  await expect(flash.first(), 'the landed range was never highlighted').toBeVisible();
  const covered = (await flash.allTextContents()).join('');
  expect(covered, 'the landing flash covered a different block').toContain(marker);

  const style = await flash.first().evaluate((el) => {
    const computed = getComputedStyle(el);
    return { animationName: computed.animationName, boxShadow: computed.boxShadow };
  });
  if (opts.reducedMotion) {
    expect(style.animationName, 'reduced motion should not animate the flash').toBe('none');
    expect(style.boxShadow, 'reduced motion should paint the static accent bar').not.toBe('none');
  } else {
    expect(style.animationName, 'the landing flash class is not styled').not.toBe('none');
  }
}

async function stopEstimateOscillation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as unknown as { __okAbandonOsc?: number };
    if (win.__okAbandonOsc !== undefined) {
      window.clearInterval(win.__okAbandonOsc);
      win.__okAbandonOsc = undefined;
    }
    document.getElementById('ok-abandon-oscillation')?.remove();
  });
}

test('plain toggle from WYSIWYG to source keeps the anchor block in view without touching the selection', async ({
  page,
  api,
}) => {
  const name = docName('w2s');
  await openTallDoc(page, api, name);

  const anchor = blockMarker(ANCHOR_INDEX);
  await anchorAtTop(page, anchor);

  const before = await landingMarkCount(page);
  await toggleMode(page, 'source');
  const mark = await waitForLandingSettled(page, { since: before });
  expect(mark.kind, `W->S toggle did not land (grade ${mark.grade})`).toBe('land');

  // Primary oracle: the plain toggle is scroll-only, so the source editor keeps
  // its own selection. Source is shown for the first time here, so its pre-flip
  // selection is the document default (head 0); a zero delta proves the landing
  // placed no caret.
  expect(await readSourceCaretHead(page), 'plain toggle moved the source selection').toBe(0);

  // Secondary: the anchor's markdown is materialized and near the top of the
  // readable area.
  await assertLanded(page, { mode: 'source', targetText: anchor, placement: 'top' });
});

test('plain toggle from source back to WYSIWYG keeps the anchor block in view without touching the selection', async ({
  page,
  api,
}) => {
  const name = docName('s2w');
  await openTallDoc(page, api, name);

  const anchor = blockMarker(ANCHOR_INDEX);
  await anchorAtTop(page, anchor);

  // Land the anchor at the source top so the direction under test (source->
  // WYSIWYG) starts from a real scrolled position rather than the document top.
  const beforeSetup = await landingMarkCount(page);
  await toggleMode(page, 'source');
  expect(
    (await waitForLandingSettled(page, { since: beforeSetup })).kind,
    'setup W->S did not land',
  ).toBe('land');
  await assertLanded(page, { mode: 'source', targetText: anchor, placement: 'top' });

  // The WYSIWYG editor stays mounted under source mode; capture its untouched
  // selection before the flip so the oracle is a real delta, not a constant.
  const caretBefore = await readWysiwygCaretHead(page);

  const before = await landingMarkCount(page);
  await toggleMode(page, 'wysiwyg');
  const mark = await waitForLandingSettled(page, { since: before });
  expect(mark.kind, `S->W toggle did not land (grade ${mark.grade})`).toBe('land');

  // Primary oracle: the WYSIWYG selection is identical across the flip (scroll-only).
  expect(await readWysiwygCaretHead(page), 'plain toggle moved the WYSIWYG selection').toBe(
    caretBefore,
  );

  // Secondary: the anchor block landed near the WYSIWYG top and the far first
  // block (the wrong-geometry decoy) is off-screen.
  await assertLanded(page, {
    mode: 'wysiwyg',
    targetMarker: anchor,
    decoyMarker: blockMarker(0),
    placement: 'top',
  });
});

test('a second entry into source mode still holds the landing against the composer bottom-pin', async ({
  page,
  api,
}) => {
  // The first entry into source mode always landed; the SECOND one did not. A
  // deep flip momentarily clamps the shared scroller to the bottom (the outgoing
  // WYSIWYG scrollTop overshoots source's shorter content), which the composer's
  // bottom-anchored scroll pin reads as "the user is at the end" and re-pins
  // every frame for 300ms — outliving the landing and leaving the user at the
  // end of the document while the land mark still claimed a zero delta. The pin
  // now stands down for the landing's suppression window, so the assertion that
  // matters is the one AFTER the pin's window has fully elapsed.
  const name = docName('second-entry');
  await openTallDoc(page, api, name);

  const first = blockMarker(ANCHOR_INDEX);
  await anchorAtTop(page, first);
  let since = await landingMarkCount(page);
  await toggleMode(page, 'source');
  expect((await waitForLandingSettled(page, { since })).kind, 'first W->S did not land').toBe(
    'land',
  );

  since = await landingMarkCount(page);
  await toggleMode(page, 'wysiwyg');
  await waitForLandingSettled(page, { since });

  // A different, deeper anchor so a stomped landing is unmistakable.
  const second = blockMarker(260);
  await anchorAtTop(page, second);
  since = await landingMarkCount(page);
  await toggleMode(page, 'source');
  expect((await waitForLandingSettled(page, { since })).kind, 'second W->S did not land').toBe(
    'land',
  );

  // Outlive the 300ms pin window before asserting — the pre-fix failure only
  // materialised after the landing had already settled.
  await settleScrollPosition(page);
  await assertLanded(page, { mode: 'source', targetText: second, placement: 'top' });
});

test('view in source from the bubble menu lands the block centered with the caret at its source start', async ({
  page,
  api,
}) => {
  const name = docName('jump');
  await openTallDoc(page, api, name);

  const target = blockMarker(ANCHOR_INDEX);
  // Bring the block on-screen so its selection has a real rect for the bubble to
  // anchor to, then select its marker to raise the selection bubble.
  await anchorAtTop(page, target);
  await selectText(page, target);

  const bubble = page.getByTestId(VIEW_IN_SOURCE_BUBBLE);
  await expect(bubble, 'the View in source bubble entry did not appear on selection').toBeVisible();

  const before = await landingMarkCount(page);
  await bubble.click();
  const mark = await waitForLandingSettled(page, { since: before });
  expect(mark.kind, `jump did not land (grade ${mark.grade})`).toBe('land');

  // Secondary: the target range is centered in the readable area.
  await assertLanded(page, { mode: 'source', targetText: target, placement: 'center' });

  // Primary oracle: unlike the scroll-only toggle, the jump places the caret at
  // the landed range's start — the source block containing the marker. Caret head
  // and block bounds are read in the same full-Y.Text offset space.
  const caretHead = await readSourceCaretHead(page);
  const bounds = await page.evaluate((marker) => {
    const src = window.__activeProvider?.document?.getText('source')?.toString() ?? '';
    const markerIdx = src.indexOf(marker);
    const priorBreak = src.lastIndexOf('\n\n', markerIdx);
    return { markerIdx, blockStart: priorBreak === -1 ? 0 : priorBreak + 2 };
  }, target);

  expect(bounds.markerIdx, 'target marker not found in the source document').toBeGreaterThan(0);
  expect(caretHead, 'jump did not place a caret (still at document start)').toBeGreaterThan(0);
  expect(caretHead, 'caret landed before the target block').toBeGreaterThanOrEqual(
    bounds.blockStart,
  );
  expect(caretHead, 'caret landed past the target block start').toBeLessThanOrEqual(
    bounds.markerIdx,
  );

  // The highlight is the other half of the jump's headline behavior: the landed
  // range is flashed once it is on screen, then clears on its own.
  await expectLandingFlashOn(page, target);
  await expect(page.locator(LANDING_FLASH), 'the landing flash never cleared').toHaveCount(0, {
    timeout: 10_000,
  });
});

test('view in source still lands and flashes under reduced motion', async ({ page, api }) => {
  // Reduced motion swaps the flash animation for a static accent bar in CSS; the
  // landing itself (scroll, caret, decoration lifetime) is script-driven and must
  // be unaffected.
  await page.emulateMedia({ reducedMotion: 'reduce' });

  const name = docName('jump-reduced-motion');
  await openTallDoc(page, api, name);

  const target = blockMarker(ANCHOR_INDEX);
  await anchorAtTop(page, target);
  await selectText(page, target);

  const bubble = page.getByTestId(VIEW_IN_SOURCE_BUBBLE);
  await expect(bubble, 'the View in source bubble entry did not appear on selection').toBeVisible();

  const before = await landingMarkCount(page);
  await bubble.click();
  const mark = await waitForLandingSettled(page, { since: before });
  expect(mark.kind, `jump did not land under reduced motion (grade ${mark.grade})`).toBe('land');

  await assertLanded(page, { mode: 'source', targetText: target, placement: 'center' });
  expect(
    await readSourceCaretHead(page),
    'jump did not place a caret under reduced motion',
  ).toBeGreaterThan(0);
  await expectLandingFlashOn(page, target, { reducedMotion: true });
});

test('a source-to-WYSIWYG landing that can never settle abandons with a target and delta', async ({
  page,
  api,
}) => {
  const name = docName('abandon');
  await openTallDoc(page, api, name);

  const anchor = blockMarker(ANCHOR_INDEX);
  await anchorAtTop(page, anchor);

  // Establish a scrolled source viewport, then queue the reverse landing.
  const beforeSetup = await landingMarkCount(page);
  await toggleMode(page, 'source');
  expect(
    (await waitForLandingSettled(page, { since: beforeSetup })).kind,
    'setup W->S did not land',
  ).toBe('land');

  // Keep the WYSIWYG landing target moving for the whole window so it can never
  // settle; the controller must then abandon, not loop or land.
  await startEstimateOscillation(page);
  const before = await landingMarkCount(page);
  await toggleMode(page, 'wysiwyg');
  const mark = await waitForLandingSettled(page, { since: before, timeout: 6_000 });
  await stopEstimateOscillation(page);

  expect(mark.kind, 'a never-settling landing should abandon, not land').toBe('abandoned');
  expect(Number.isFinite(mark.target), 'abandoned mark is missing a numeric target').toBe(true);
  expect(Number.isFinite(mark.delta), 'abandoned mark is missing a numeric delta').toBe(true);
});
