import type { Page } from '@playwright/test';
import { type ApiHelpers, expect, test, waitForActiveProviderSynced } from './_helpers';

const TOOLBAR_INSET_PX = 56;

const PAINT_PROBE_COUNT = 10;

const PHANTOM_RUNWAY_TOLERANCE_PX = 64;

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

interface ScrollportGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  contentTop: number;
  contentBottom: number;
  viewportTop: number;
  paintedProbes: number;
  probeCount: number;
  blockControls: { top: number; bottom: number; visibility: string } | null;
}

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

async function scrollDeep(page: Page, { down = 30, up = 4 } = {}): Promise<void> {
  for (let i = 0; i < down; i++) {
    await page.mouse.wheel(0, 900);
    await awaitAnimationFrames(page, 4);
  }
  for (let i = 0; i < up; i++) {
    await page.mouse.wheel(0, -900);
    await awaitAnimationFrames(page, 4);
  }
  await waitForScrollSettled(page);
}

async function hoverDeepBlock(page: Page): Promise<void> {
  const box = await page.getByTestId('editor-scroll-container').first().boundingBox();
  if (!box) throw new Error('editor scroll container has no layout box');
  const x = box.x + box.width / 2;
  const y = box.y + TOOLBAR_INSET_PX + (box.height - TOOLBAR_INSET_PX) / 2;
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

  const cold = await readScrollportGeometry(page);
  console.log(describeGeometry('cold-open', cold));

  await page.getByTestId('editor-scroll-container').first().hover();
  await scrollDeep(page);
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
    const allowedScrollHeight =
      Math.max(afterReturn.clientHeight, afterReturn.contentBottom + baselineOverhang) +
      PHANTOM_RUNWAY_TOLERANCE_PX;
    expect(
      afterReturn.scrollHeight,
      `scrollable space extends past the document: ${describeGeometry('after-return', afterReturn)} (bottom padding baseline ${baselineOverhang}px). Editor chrome must not keep the scroller stretched past the content it sits over — the extra space is what lets a restored offset park the viewport on nothing.`,
    ).toBeLessThanOrEqual(allowedScrollHeight);
  });
});
