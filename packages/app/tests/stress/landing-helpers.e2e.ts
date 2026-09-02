import { randomUUID } from 'node:crypto';
import {
  assertLanded,
  blockMarker,
  expect,
  generateTallDoc,
  injectForcedEstimateError,
  landingMarkCount,
  readSourceCaretHead,
  scrollWysiwygBlockToTop,
  test,
  toggleMode,
  waitForActiveProviderSynced,
  waitForLandingSettled,
} from './_helpers';

const WYSIWYG = '.ProseMirror:not(.composer-prosemirror)';
const CHUNK_WRAPPER = `${WYSIWYG} .ok-chunk-wrapper`;

function docName(label: string): string {
  return `landing-helpers-${label}-${randomUUID().slice(0, 8)}`;
}

test('source oracle asserts a real WYSIWYG-to-source landing, and its guard fires on an absent target', async ({
  page,
  api,
}) => {
  const name = docName('src');
  const { markdown } = generateTallDoc({ blockCount: 400 });
  await api.seedDocs([{ name, markdown }]);
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(WYSIWYG).first()).toBeVisible();

  const anchorMarker = blockMarker(150);
  const settleDelta = await scrollWysiwygBlockToTop(page, anchorMarker);
  expect(
    Math.abs(settleDelta),
    'setup scroll did not converge the anchor to the top of the readable area',
  ).toBeLessThan(40);

  const before = await landingMarkCount(page);
  await toggleMode(page, 'source');
  const mark = await waitForLandingSettled(page, { since: before });
  expect(mark.kind, `landing did not land (grade ${mark.grade})`).toBe('land');

  await assertLanded(page, { mode: 'source', targetText: anchorMarker, placement: 'top' });

  expect(await readSourceCaretHead(page)).toBe(0);

  await expect(
    assertLanded(page, { mode: 'source', targetText: 'OKBLK-absent-marker', placement: 'top' }),
    'source oracle silently accepted an absent target',
  ).rejects.toThrow(/not in the document/);
});

test('WYSIWYG oracle materializes the target and rejects a wrong-geometry landing, and its guard fires on an absent target', async ({
  page,
  api,
}) => {
  const name = docName('wys');
  const { markdown } = generateTallDoc({ blockCount: 400 });
  await api.seedDocs([{ name, markdown }]);
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(WYSIWYG).first()).toBeVisible();

  const targetMarker = blockMarker(150);
  const decoyMarker = blockMarker(0);
  const settleDelta = await scrollWysiwygBlockToTop(page, targetMarker);
  expect(Math.abs(settleDelta), 'setup scroll did not converge the target').toBeLessThan(40);

  await assertLanded(page, { mode: 'wysiwyg', targetMarker, decoyMarker });

  await expect(
    assertLanded(page, { mode: 'wysiwyg', targetMarker: blockMarker(9999) }),
    'WYSIWYG oracle silently accepted an absent target',
  ).rejects.toThrow(/not in the DOM/);
});

test('forced-estimate-error injection applies the chunk-height override at runtime', async ({
  page,
  api,
}) => {
  const name = docName('cvh');
  const { markdown } = generateTallDoc({ blockCount: 120 });
  await api.seedDocs([{ name, markdown }]);
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(WYSIWYG).first()).toBeVisible();
  await expect(page.locator(CHUNK_WRAPPER).first()).toBeAttached();

  await injectForcedEstimateError(page, 400);
});
