/**
 * Pins the editor scroller's geometry contract: scrollable space must correspond
 * to real document content, so any offset the app restores or preserves lands the
 * viewport on content that exists in the *current* layout.
 *
 * Two production mechanisms make that contract easy to break, and both are
 * exercised here:
 *
 *   1. Every top-level block renders inside a `content-visibility: auto` wrapper
 *      whose skipped-state height is a flat estimate. A document whose blocks are
 *      much taller than that estimate collapses to a fraction of its materialized
 *      height whenever its content DOM is rebuilt — which is what returning to a
 *      document after closing a sibling tab does. An offset captured against the
 *      materialized geometry then points far past the real content.
 *
 *   2. The block drag handle (`.ok-block-controls`) is an absolutely positioned
 *      overlay inside the scroller. floating-ui parks it at the last hovered
 *      block, and it is "hidden" with `visibility: hidden` — which keeps it in
 *      layout. A handle parked against a deep block keeps stretching the
 *      scroller's `scrollHeight` after the content beneath it shrinks, so the
 *      browser never clamps `scrollTop` back onto content.
 *
 * Every assertion therefore derives "real content extent" from the `.ProseMirror`
 * element's box, never from `scrollHeight` — `scrollHeight` is exactly the
 * quantity overlay chrome pollutes, so an assertion built on it cannot see the
 * failure. Exact restored offsets are deliberately NOT asserted: estimate-driven
 * displacement is a separate, milder defect, and pinning pixel values here would
 * make this file fail for the wrong reason.
 *
 * Not covered here: the same contract is reachable by shrinking a live document
 * from the agent-write API, but a full-body `position: 'replace'` measurably
 * resets the scroller to 0 and repositions the drag handle onto the new content,
 * so that path does not strand the viewport and a test built on it would pass
 * against the broken build.
 *
 * Content presence is measured by hit-testing (`document.elementFromPoint`)
 * rather than by sweeping block rects: a `content-visibility: auto` subtree
 * reports an empty rect while skipped, and a rect sweep forces style/layout work
 * that can perturb the very geometry under test. Hits must land on a strict
 * descendant of `.ProseMirror` — a hit on `.ProseMirror` itself is inter-block
 * whitespace whose `textContent` is the whole document, which would report
 * painted content for an entirely blank band.
 *
 * Invocation (bug-specific gate):
 *   cd public/open-knowledge/packages/app && \
 *     pnpm exec playwright test tests/stress/tab-close-scroll-restore.e2e.ts \
 *       --workers=1 --retries=0
 */

import type { Page } from '@playwright/test';
import { type ApiHelpers, expect, test, waitForActiveProviderSynced } from './_helpers';

/**
 * Height of the absolute EditorToolbar overlapping the top of the scrollport
 * (`pt-14` on the scroll container). Content behind it is on screen but not
 * readable, so both the paint probes and the "viewport top" scroll coordinate
 * step in past it.
 */
const TOOLBAR_INSET_PX = 56;

/** Evenly spaced vertical hit tests across the readable band. */
const PAINT_PROBE_COUNT = 10;

/**
 * Slack allowed above the document's own bottom padding before extra scrollable
 * space counts as phantom. Legitimate late layout drift is tens of pixels; the
 * overlay-manufactured runway this file guards against is thousands, so the gap
 * is wide enough that no realistic padding change turns the assertion brittle.
 */
const PHANTOM_RUNWAY_TOLERANCE_PX = 64;

// --- fixture ---------------------------------------------------------------

const FILLER_WORDS = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'tempor',
  'incididunt',
  'labore',
  'magna',
  'aliqua',
  'veniam',
  'nostrud',
] as const;

/**
 * Words per block. ~220 renders each paragraph several hundred pixels tall at the
 * 1280x720 test viewport — several times the flat skipped-state estimate, which is
 * the precondition for the geometry collapse this file exercises. A fixture of
 * near-estimate-height blocks (tables, one-liners) does NOT reproduce it.
 */
const WORDS_PER_BLOCK = 220;
const SECTION_COUNT = 12;
const BLOCKS_PER_SECTION = 8;

function blockMarker(index: number): string {
  return `MK${String(index).padStart(4, '0')}`;
}

function fillerFor(index: number): string {
  const words: string[] = [];
  for (let i = 0; i < WORDS_PER_BLOCK; i++) {
    words.push(FILLER_WORDS[(index * 7 + i * 3) % FILLER_WORDS.length] ?? 'lorem');
  }
  return words.join(' ');
}

/**
 * Tall-block document. Every body paragraph carries a wiki link to `linkTo`, so a
 * deep scroll always leaves at least one chip inside the readable band — the
 * scenario asserts that as a precondition rather than falling back to a synthetic
 * navigation, which would skip the user's actual journey. `bottomMarker` is
 * per-document so a readiness gate can never match a different document that
 * happens to share this fixture's shape.
 */
function buildTallBlockDoc({
  linkTo,
  bottomMarker,
}: {
  linkTo: string;
  bottomMarker: string;
}): string {
  const lines: string[] = ['# Progress Log', ''];
  let index = 0;
  for (let section = 1; section <= SECTION_COUNT; section++) {
    lines.push(`## ${blockMarker(index++)} Section ${section}`, '');
    for (let block = 0; block < BLOCKS_PER_SECTION; block++) {
      const marker = blockMarker(index++);
      lines.push(`${marker} ${fillerFor(section * 5 + block)} see [[${linkTo}]] for detail.`, '');
    }
  }
  lines.push(`## ${blockMarker(index)} Bottom Marker Heading`, '', `${bottomMarker} end.`, '');
  return lines.join('\n');
}

// --- measurement -----------------------------------------------------------

interface ScrollportGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Top of the real document content, in the scroller's scroll coordinates. */
  contentTop: number;
  /** Bottom of the real document content, in the scroller's scroll coordinates. */
  contentBottom: number;
  /** Top edge of the readable band, in scroll coordinates. */
  viewportTop: number;
  /** Hit tests across the readable band that landed on painted document text. */
  paintedProbes: number;
  probeCount: number;
  /** The block drag-handle overlay, when one is mounted in this scroller. */
  blockControls: { top: number; bottom: number; visibility: string } | null;
}

/**
 * Read the painted editor scrollport's geometry. The painted container is chosen
 * by layout box rather than first match: a hidden `<Activity>` entry keeps its
 * scroll container in the DOM, so several can coexist and only the painted one is
 * the active scrollport.
 */
async function readScrollportGeometry(page: Page): Promise<ScrollportGeometry> {
  const geometry = await page.evaluate(
    ({ toolbarPx, probeCount }) => {
      const scroller = Array.from(
        document.querySelectorAll('[data-testid="editor-scroll-container"]'),
      ).find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.getClientRects().length > 0,
      );
      if (!scroller) return null;
      const prose = scroller.querySelector('.ProseMirror:not(.composer-prosemirror)');
      if (!(prose instanceof HTMLElement)) return null;

      const scrollTop = scroller.scrollTop;
      const scrollerRect = scroller.getBoundingClientRect();
      const proseRect = prose.getBoundingClientRect();
      const toScrollCoords = (viewportY: number) => viewportY - scrollerRect.top + scrollTop;

      const bandTop = scrollerRect.top + toolbarPx;
      const bandHeight = scrollerRect.bottom - bandTop;
      let paintedProbes = 0;
      for (let i = 0; i < probeCount; i++) {
        const y = bandTop + (bandHeight * (i + 0.5)) / probeCount;
        const hit = document.elementFromPoint(scrollerRect.left + scrollerRect.width / 2, y);
        if (
          hit instanceof Element &&
          hit !== prose &&
          prose.contains(hit) &&
          (hit.textContent ?? '').trim().length > 0
        ) {
          paintedProbes += 1;
        }
      }

      const controls = scroller.querySelector('.ok-block-controls');
      const controlsRect =
        controls instanceof HTMLElement ? controls.getBoundingClientRect() : null;
      const controlsVisibility =
        controls instanceof HTMLElement ? getComputedStyle(controls).visibility : null;

      return {
        scrollTop: Math.round(scrollTop),
        scrollHeight: Math.round(scroller.scrollHeight),
        clientHeight: Math.round(scroller.clientHeight),
        contentTop: Math.round(toScrollCoords(proseRect.top)),
        contentBottom: Math.round(toScrollCoords(proseRect.bottom)),
        viewportTop: Math.round(scrollTop + toolbarPx),
        paintedProbes,
        probeCount,
        blockControls:
          controlsRect && controlsVisibility
            ? {
                top: Math.round(toScrollCoords(controlsRect.top)),
                bottom: Math.round(toScrollCoords(controlsRect.bottom)),
                visibility: controlsVisibility,
              }
            : null,
      };
    },
    { toolbarPx: TOOLBAR_INSET_PX, probeCount: PAINT_PROBE_COUNT },
  );
  if (!geometry) {
    throw new Error(
      'no painted editor scroll container with a ProseMirror body — the editor never rendered',
    );
  }
  return geometry;
}

function describeGeometry(label: string, geometry: ScrollportGeometry): string {
  return `${label}: scrollTop=${geometry.scrollTop} scrollHeight=${geometry.scrollHeight} clientHeight=${geometry.clientHeight} content=[${geometry.contentTop}, ${geometry.contentBottom}] viewportTop=${geometry.viewportTop} painted=${geometry.paintedProbes}/${geometry.probeCount} blockControls=${JSON.stringify(geometry.blockControls)}`;
}

/**
 * Wait until the painted editor's text contains `needle`. Reads `textContent`
 * rather than asserting visibility because a `content-visibility: auto` subtree
 * scrolled out of view reports an empty box — a visibility gate would time out on
 * exactly the stranded state under test and mask the real assertion.
 */
async function waitForPaintedDocText(page: Page, needle: string, timeout = 30_000): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((text) => {
          const scroller = Array.from(
            document.querySelectorAll('[data-testid="editor-scroll-container"]'),
          ).find(
            (element): element is HTMLElement =>
              element instanceof HTMLElement && element.getClientRects().length > 0,
          );
          const prose = scroller?.querySelector('.ProseMirror:not(.composer-prosemirror)');
          return (prose?.textContent ?? '').includes(text);
        }, needle),
      { timeout, message: `painted editor never showed "${needle}"` },
    )
    .toBe(true);
}

/**
 * Let the renderer advance `frames` animation frames. The restore loop under
 * test schedules its writes on requestAnimationFrame, so frames — not
 * wall-clock sleeps, which the E2E STOP rules ban — are the honest unit for
 * "give the app time to process what just happened": counting frames
 * guarantees the loop actually had turns, where a sleep only guarantees time
 * passed.
 */
async function awaitAnimationFrames(page: Page, frames: number): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let remaining = n;
        const tick = () => {
          remaining -= 1;
          if (remaining <= 0) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

/**
 * Resolve once `scrollTop` holds still for `quietMs`, or `timeoutMs` elapses.
 * Assertions run against a settled scroller so a transient pre-restore frame
 * (which briefly shows content before the restore writes its target) can never
 * be mistaken for a healthy landing. `timeoutMs` stays well below the restore
 * loop's wall-clock backstop: the contract is that the restore lands on content,
 * not that abandoning it eventually does. The quiet-period detection runs
 * in-page on requestAnimationFrame — the same scheduler the restore loop writes
 * from — so "no movement for quietMs" is measured frame-accurately.
 */
async function waitForScrollSettled(
  page: Page,
  { quietMs = 700, timeoutMs = 4_000 }: { quietMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  await page.evaluate(
    (args) =>
      new Promise<void>((resolve) => {
        const readScrollTop = () => {
          const scroller = Array.from(
            document.querySelectorAll('[data-testid="editor-scroll-container"]'),
          ).find(
            (element): element is HTMLElement =>
              element instanceof HTMLElement && element.getClientRects().length > 0,
          );
          return scroller ? Math.round(scroller.scrollTop) : null;
        };
        const started = performance.now();
        let last = readScrollTop();
        let quietSince = performance.now();
        const tick = () => {
          const now = performance.now();
          const current = readScrollTop();
          if (current !== last) {
            last = current;
            quietSince = now;
          }
          if (now - quietSince >= args.quietMs || now - started >= args.timeoutMs) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { quietMs, timeoutMs },
  );
}

/** Wheel-scroll deep into the document, then back off the very bottom. */
async function scrollDeep(page: Page, { down = 30, up = 4 } = {}): Promise<void> {
  for (let i = 0; i < down; i++) {
    await page.mouse.wheel(0, 900);
    // A few frames per tick lets layout + the scroll listener process each
    // wheel event before the next lands (the save path records per event).
    await awaitAnimationFrames(page, 4);
  }
  // Backing off the last screens keeps "it merely stayed pinned at the maximum"
  // from being an alternative explanation for any end-of-document result.
  for (let i = 0; i < up; i++) {
    await page.mouse.wheel(0, -900);
    await awaitAnimationFrames(page, 4);
  }
  await waitForScrollSettled(page);
}

/**
 * Move the pointer over the block under the middle of the readable band so the
 * drag handle is positioned against deep content, and assert the affordance
 * actually mounted. Without that check a fixture or hover-path change would
 * silently disarm the overlay half of the scenario and leave the test passing on
 * a still-broken build.
 */
async function hoverDeepBlock(page: Page): Promise<void> {
  const box = await page.getByTestId('editor-scroll-container').first().boundingBox();
  if (!box) throw new Error('editor scroll container has no layout box');
  const x = box.x + box.width / 2;
  const y = box.y + TOOLBAR_INSET_PX + (box.height - TOOLBAR_INSET_PX) / 2;
  // Two moves: the drag-handle plugin positions off pointer movement, so a single
  // move landing on the same coordinate the wheel left the pointer at is a no-op.
  await page.mouse.move(x, y - 40);
  await page.mouse.move(x, y);

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const scroller = Array.from(
            document.querySelectorAll('[data-testid="editor-scroll-container"]'),
          ).find(
            (element): element is HTMLElement =>
              element instanceof HTMLElement && element.getClientRects().length > 0,
          );
          const element = scroller?.querySelector('.ok-block-controls');
          if (!(element instanceof HTMLElement)) return 'absent';
          return getComputedStyle(element).visibility;
        }),
      {
        timeout: 5_000,
        message:
          'the block drag handle never became visible while hovering a block — the overlay was never positioned against deep content, so this run does not exercise the stale-overlay path; re-check editor/extensions/drag-handle.ts',
      },
    )
    .toBe('visible');
}

async function openFromSidebar(page: Page, filename: string): Promise<void> {
  const row = page.getByRole('treeitem', { name: filename, exact: true });
  await expect(row).toBeVisible();
  await row.click();
}

/**
 * Index of the first wiki-link chip sitting wholly inside the readable band, or
 * -1. Chips inside a skipped `content-visibility: auto` chunk report an empty
 * rect, so a zero-area rect is treated as "not in the band" rather than as a
 * position. Measured against the scroller's own rect, not the window viewport:
 * the scrollport sits below the tab strip, so window coordinates would clip the
 * wrong band.
 */
async function findWikiLinkInBand(page: Page): Promise<{ total: number; index: number }> {
  return page.evaluate((toolbarPx) => {
    const scroller = Array.from(
      document.querySelectorAll('[data-testid="editor-scroll-container"]'),
    ).find(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.getClientRects().length > 0,
    );
    const chips = Array.from(document.querySelectorAll('[data-wiki-link]'));
    if (!scroller) return { total: chips.length, index: -1 };
    const scrollerRect = scroller.getBoundingClientRect();
    const bandTop = scrollerRect.top + toolbarPx + 8;
    const bandBottom = scrollerRect.bottom - 8;
    for (let i = 0; i < chips.length; i++) {
      const rect = chips[i]?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.top >= bandTop && rect.bottom <= bandBottom)
        return { total: chips.length, index: i };
    }
    return { total: chips.length, index: -1 };
  }, TOOLBAR_INSET_PX);
}

/**
 * Nudge the scroller until a wiki link the user could actually see is in the
 * readable band, and return its index. Nudging is bounded and small (well under
 * one block height) so the document stays deep-scrolled; navigating some other
 * way would move the source document's scroll position and stop reproducing the
 * journey under test.
 */
async function scrollUntilWikiLinkInBand(page: Page): Promise<number> {
  let found = await findWikiLinkInBand(page);
  for (let nudge = 0; nudge < 10 && found.index < 0; nudge++) {
    await page.mouse.wheel(0, 160);
    await awaitAnimationFrames(page, 12);
    found = await findWikiLinkInBand(page);
  }
  expect(
    found.index,
    `no wiki-link chip inside the readable band after the deep scroll (${found.total} chips in the document) — the fixture no longer places a link in reach of the viewport`,
  ).toBeGreaterThanOrEqual(0);
  return found.index;
}

/**
 * Assert the readable viewport intersects real document content: text is painted
 * in the band, and the band's top edge sits at or above the content's bottom in
 * scroll coordinates. Both are read from the `.ProseMirror` box, never from
 * `scrollHeight`.
 */
function expectViewportOnContent(geometry: ScrollportGeometry, label: string): void {
  expect(
    geometry.viewportTop,
    `${label} — the viewport is parked past the end of the document: ${describeGeometry(label, geometry)}`,
  ).toBeLessThanOrEqual(geometry.contentBottom);
  expect(
    geometry.paintedProbes,
    `${label} — the viewport shows no document text: ${describeGeometry(label, geometry)}`,
  ).toBeGreaterThan(0);
}

/**
 * Drive the reported journey once and hand back the three geometries the
 * contracts are read from: the freshly opened document, the deep-scrolled
 * position the user navigates away from, and the position they return to.
 */
async function runTabCloseReturnScenario(
  page: Page,
  api: ApiHelpers,
  { docName, siblingName }: { docName: string; siblingName: string },
): Promise<{
  cold: ScrollportGeometry;
  beforeNav: ScrollportGeometry;
  afterReturn: ScrollportGeometry;
}> {
  const bottomMarker = `ZZBOTTOM-${docName}-ZZ`;
  const siblingMarker = `ZZSIBLING-${siblingName}-ZZ`;
  await api.seedDocs([
    { name: docName, markdown: buildTallBlockDoc({ linkTo: siblingName, bottomMarker }) },
    { name: siblingName, markdown: `# Sibling Target\n\nShort sibling body. ${siblingMarker}` },
  ]);

  await page.goto('/');
  await openFromSidebar(page, `${docName}.md`);
  await waitForActiveProviderSynced(page);
  await waitForPaintedDocText(page, bottomMarker);
  await waitForScrollSettled(page);

  // Read the freshly opened geometry before anything parks the drag handle:
  // whatever scrollable space sits past the content bottom here is the
  // document's own bottom padding, which makes the phantom-runway bound
  // self-calibrating against padding changes.
  const cold = await readScrollportGeometry(page);
  console.log(describeGeometry('cold-open', cold));

  await page.getByTestId('editor-scroll-container').first().hover();
  await scrollDeep(page);
  // Settle on a position where a link is reachable BEFORE parking the drag
  // handle, so the recorded pre-navigation geometry is the position the user
  // actually navigates away from.
  const chipIndex = await scrollUntilWikiLinkInBand(page);
  await hoverDeepBlock(page);

  const beforeNav = await readScrollportGeometry(page);
  console.log(describeGeometry('before-nav', beforeNav));
  expect(
    beforeNav.scrollTop,
    'the wheel scroll did not reach deep content — the fixture is no longer tall enough to exercise the geometry collapse',
  ).toBeGreaterThan(5_000);
  expectViewportOnContent(beforeNav, 'before-nav');

  await page.locator('[data-wiki-link]').nth(chipIndex).click();
  await waitForPaintedDocText(page, siblingMarker);

  const tab = page.locator(`[data-editor-tab-id*="${siblingName}"]`).first();
  await tab.hover();
  await tab.getByTestId('editor-tab-close-button').first().click();
  await waitForPaintedDocText(page, bottomMarker);
  await waitForScrollSettled(page);

  const afterReturn = await readScrollportGeometry(page);
  console.log(describeGeometry('after-return', afterReturn));
  return { cold, beforeNav, afterReturn };
}

test.describe('editor scroll geometry tracks real document content', () => {
  test('PRD-8046: returning to a tall document after closing a sibling tab shows content', async ({
    page,
    api,
  }) => {
    test.setTimeout(150_000);
    const { afterReturn } = await runTabCloseReturnScenario(page, api, {
      docName: 'tall-progress-log',
      siblingName: 'tall-progress-sibling',
    });

    expectViewportOnContent(afterReturn, 'after-return');

    // The restore loop re-applies its target for several seconds; a landing that
    // is only briefly correct is still the bug, so re-check once the loop has had
    // time to move the viewport again. 90 animation frames (~1.5s at 60fps) is
    // the frame-accurate form: the loop's re-apply writes are rAF-scheduled, so
    // counting frames guarantees it had that many turns.
    await awaitAnimationFrames(page, 90);
    const settled = await readScrollportGeometry(page);
    console.log(describeGeometry('after-return+1.5s', settled));
    expectViewportOnContent(settled, 'after-return+1.5s (stability re-check)');
  });

  test('PRD-6953: editor chrome adds no scrollable space past the end of the document', async ({
    page,
    api,
  }) => {
    test.setTimeout(150_000);
    const { cold, afterReturn } = await runTabCloseReturnScenario(page, api, {
      docName: 'runway-progress-log',
      siblingName: 'runway-progress-sibling',
    });

    const baselineOverhang = Math.max(0, cold.scrollHeight - cold.contentBottom);
    // Scrollable space may legitimately reach the scrollport's own height even
    // for a document shorter than one screen; past that, only the document's own
    // bottom padding is allowed.
    const allowedScrollHeight =
      Math.max(afterReturn.clientHeight, afterReturn.contentBottom + baselineOverhang) +
      PHANTOM_RUNWAY_TOLERANCE_PX;
    expect(
      afterReturn.scrollHeight,
      `scrollable space extends past the document: ${describeGeometry('after-return', afterReturn)} (bottom padding baseline ${baselineOverhang}px). Editor chrome must not keep the scroller stretched past the content it sits over — the extra space is what lets a restored offset park the viewport on nothing.`,
    ).toBeLessThanOrEqual(allowedScrollHeight);
  });
});
