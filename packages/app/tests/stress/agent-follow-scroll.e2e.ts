import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  blockMarker,
  expect,
  generateTallDoc,
  scrollWysiwygBlockToTop,
  TOOLBAR_OVERLAP_PX,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

const WYSIWYG = '.ProseMirror:not(.composer-prosemirror)';
const FLASH = '.ok-agent-insert-flash';
const EDGE_EPSILON_PX = 3;
const BLOCK_COUNT = 400;
const READING_AT = 150;
const OFFSCREEN_EDIT_AT = 320;
const LANDING_TOLERANCE_BLOCKS = 120;
const SEED_STUB = 'seed';

type FlashWindow = {
  __okFlashSeen?: boolean;
  __okRearmFlashWatch?: () => void;
  __okReadableFlash?: () => boolean;
};

function docName(label: string): string {
  return `agent-follow-scroll-${label}-${randomUUID().slice(0, 8)}`;
}

function bumpBlock(markdown: string, marker: string): string {
  const needle = `**${marker}** `;
  const at = markdown.indexOf(needle);
  if (at === -1) throw new Error(`bumpBlock: ${marker} not found`);
  const charAt = at + needle.length;
  const swapped = markdown[charAt] === markdown[charAt].toUpperCase() ? 'x' : 'X';
  return `${markdown.slice(0, charAt)}${swapped}${markdown.slice(charAt + 1)}`;
}

async function watchFlash(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as FlashWindow;
    w.__okFlashSeen = false;
    const readableFlash = (): boolean => {
      const clip = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="editor-scroll-container"]'),
      ).find((el) => el.getClientRects().length > 0);
      return clip?.querySelector('.ok-agent-insert-flash') != null;
    };
    w.__okReadableFlash = readableFlash;
    const options = {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    };
    const observer = new MutationObserver(() => {
      if (!readableFlash()) return;
      w.__okFlashSeen = true;
      observer.disconnect();
    });
    w.__okRearmFlashWatch = () => observer.observe(document, options);
    observer.observe(document, options);
  });
}

async function openTallDoc(
  page: Page,
  api: ApiHelpers,
  name: string,
): Promise<{ markdown: string }> {
  const { markdown } = generateTallDoc({ blockCount: BLOCK_COUNT });
  const warmName = `${name}-warm`;
  await api.seedDocs([
    { name, markdown: SEED_STUB },
    { name: warmName, markdown: SEED_STUB },
  ]);
  await api.testReset(warmName);
  await watchFlash(page);

  await page.goto(`/#/${warmName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(WYSIWYG).first()).toBeVisible();

  await armFlashWatch(page);
  await api.writeAsAgent(warmName, `${SEED_STUB} warm`, {
    agentId: 'warm-agent',
    agentName: 'WarmAgent',
  });
  await drainFlash(page, 'the warm document');

  await armFlashWatch(page);
  await api.writeAsAgent(name, markdown, { agentId: 'seed-agent', agentName: 'SeedAgent' });
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(WYSIWYG).first()).toBeVisible();
  return { markdown };
}

async function topReadableMarker(page: Page): Promise<string | null> {
  return page.evaluate(
    ([insetPx, epsilonPx]) => {
      const clip = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="editor-scroll-container"]'),
      ).find((el) => el.getClientRects().length > 0);
      if (clip === undefined) return null;
      const clipRect = clip.getBoundingClientRect();
      const readableTop = clipRect.top + insetPx;
      for (const w of Array.from(clip.querySelectorAll<HTMLElement>('.ok-chunk-wrapper'))) {
        if (w.getClientRects().length === 0) continue;
        const r = w.getBoundingClientRect();
        if (r.bottom > readableTop + epsilonPx && r.top < clipRect.bottom) {
          return (w.textContent ?? '').match(/OKBLK\d+/)?.[0] ?? null;
        }
      }
      return null;
    },
    [TOOLBAR_OVERLAP_PX, EDGE_EPSILON_PX] as const,
  );
}

function markerIndex(marker: string | null): number {
  return marker === null ? Number.NaN : Number(marker.replace('OKBLK', ''));
}

async function armFlashWatch(page: Page): Promise<void> {
  await expect(
    page.locator(FLASH),
    'a prior agent-flash decoration was still attached when the watch re-armed',
  ).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as FlashWindow;
    const rearm = w.__okRearmFlashWatch;
    if (rearm === undefined)
      throw new Error('armFlashWatch: the flash watcher was never installed');
    w.__okFlashSeen = false;
    rearm();
  });
}

async function drainFlash(page: Page, subject: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const w = window as unknown as FlashWindow;
          const readable = w.__okReadableFlash;
          if (readable === undefined)
            throw new Error('drainFlash: the flash watcher was never installed');
          return w.__okFlashSeen === true && !readable();
        }),
      { message: `the agent-flash replay for ${subject} never both fired and cleared` },
    )
    .toBe(true);
}

test('opening a document an agent just wrote leaves the reader at the top', async ({
  page,
  api,
}) => {
  const name = docName('open-after-write');
  await openTallDoc(page, api, name);

  await drainFlash(page, 'the document under test');

  expect(
    await topReadableMarker(page),
    'opening a freshly agent-written document scrolled the reader into its middle',
  ).toBe(blockMarker(0));
});

test('a document-spanning agent write leaves a reader where they already were', async ({
  page,
  api,
}) => {
  const name = docName('spanning');
  const { markdown } = await openTallDoc(page, api, name);
  await drainFlash(page, 'the document under test');

  await scrollWysiwygBlockToTop(page, blockMarker(READING_AT));
  const before = await topReadableMarker(page);
  expect(before, 'setup did not park the reader on the anchor block').toBe(blockMarker(READING_AT));

  await armFlashWatch(page);
  const spanning = bumpBlock(bumpBlock(markdown, blockMarker(0)), blockMarker(BLOCK_COUNT - 1));
  await api.writeAsAgent(name, spanning, { agentId: 'follow-probe', agentName: 'FollowProbe' });

  await drainFlash(page, 'the document under test');

  const after = await topReadableMarker(page);
  expect(after, `a whole-document agent write scrolled the reader from ${before} to ${after}`).toBe(
    before,
  );
});

test('an agent write below the fold is still followed toward', async ({ page, api }) => {
  const name = docName('offscreen');
  const { markdown } = await openTallDoc(page, api, name);
  await drainFlash(page, 'the document under test');

  await scrollWysiwygBlockToTop(page, blockMarker(0));
  expect(await topReadableMarker(page), 'setup did not park the reader at the top').toBe(
    blockMarker(0),
  );

  const edited = bumpBlock(markdown, blockMarker(OFFSCREEN_EDIT_AT));
  await api.writeAsAgent(name, edited, { agentId: 'follow-probe', agentName: 'FollowProbe' });

  await expect
    .poll(async () => Math.abs(markerIndex(await topReadableMarker(page)) - OFFSCREEN_EDIT_AT), {
      message:
        'the follow-scroll did not bring the reader near the off-screen agent write; the received value is how many blocks it missed by',
    })
    .toBeLessThanOrEqual(LANDING_TOLERANCE_BLOCKS);
});
