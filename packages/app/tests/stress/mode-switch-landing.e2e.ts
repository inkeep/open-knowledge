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
const LANDING_FLASH = '.cm-editor .ok-landing-flash';
const ANCHOR_INDEX = 150;

function docName(label: string): string {
  return `mode-switch-landing-${label}-${randomUUID().slice(0, 8)}`;
}

async function openTallDoc(page: Page, api: ApiHelpers, name: string): Promise<void> {
  const { markdown } = generateTallDoc({ blockCount: 400 });
  await api.seedDocs([{ name, markdown }]);
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(WYSIWYG).first()).toBeVisible();
}

async function anchorAtTop(page: Page, marker: string): Promise<void> {
  const residual = await scrollWysiwygBlockToTop(page, marker);
  expect(
    Math.abs(residual),
    'setup scroll did not converge the anchor to the top of the readable area',
  ).toBeLessThan(40);
}

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
        const REQUIRED_STABLE_TICKS = 12;
        const MAX_TICKS = 120;
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

  expect(await readSourceCaretHead(page), 'plain toggle moved the source selection').toBe(0);

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

  const beforeSetup = await landingMarkCount(page);
  await toggleMode(page, 'source');
  expect(
    (await waitForLandingSettled(page, { since: beforeSetup })).kind,
    'setup W->S did not land',
  ).toBe('land');
  await assertLanded(page, { mode: 'source', targetText: anchor, placement: 'top' });

  const caretBefore = await readWysiwygCaretHead(page);

  const before = await landingMarkCount(page);
  await toggleMode(page, 'wysiwyg');
  const mark = await waitForLandingSettled(page, { since: before });
  expect(mark.kind, `S->W toggle did not land (grade ${mark.grade})`).toBe('land');

  expect(await readWysiwygCaretHead(page), 'plain toggle moved the WYSIWYG selection').toBe(
    caretBefore,
  );

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

  const second = blockMarker(260);
  await anchorAtTop(page, second);
  since = await landingMarkCount(page);
  await toggleMode(page, 'source');
  expect((await waitForLandingSettled(page, { since })).kind, 'second W->S did not land').toBe(
    'land',
  );

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
  await anchorAtTop(page, target);
  await selectText(page, target);

  const bubble = page.getByTestId(VIEW_IN_SOURCE_BUBBLE);
  await expect(bubble, 'the View in source bubble entry did not appear on selection').toBeVisible();

  const before = await landingMarkCount(page);
  await bubble.click();
  const mark = await waitForLandingSettled(page, { since: before });
  expect(mark.kind, `jump did not land (grade ${mark.grade})`).toBe('land');

  await assertLanded(page, { mode: 'source', targetText: target, placement: 'center' });

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

  await expectLandingFlashOn(page, target);
  await expect(page.locator(LANDING_FLASH), 'the landing flash never cleared').toHaveCount(0, {
    timeout: 10_000,
  });
});

test('view in source still lands and flashes under reduced motion', async ({ page, api }) => {
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

  const beforeSetup = await landingMarkCount(page);
  await toggleMode(page, 'source');
  expect(
    (await waitForLandingSettled(page, { since: beforeSetup })).kind,
    'setup W->S did not land',
  ).toBe('land');

  await startEstimateOscillation(page);
  const before = await landingMarkCount(page);
  await toggleMode(page, 'wysiwyg');
  const mark = await waitForLandingSettled(page, { since: before, timeout: 6_000 });
  await stopEstimateOscillation(page);

  expect(mark.kind, 'a never-settling landing should abandon, not land').toBe('abandoned');
  expect(Number.isFinite(mark.target), 'abandoned mark is missing a numeric target').toBe(true);
  expect(Number.isFinite(mark.delta), 'abandoned mark is missing a numeric delta').toBe(true);
});
