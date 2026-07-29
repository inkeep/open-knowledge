/**
 * Self-test for the landing e2e helpers.
 *
 * These helpers are the oracle every later landing test depends on, so they are
 * proven here against the real running app: a real WYSIWYG-to-source landing is
 * asserted with the source oracle; each anti-vacuity guard is shown to fail
 * loudly when its target is absent (a missing target must never read as a pass);
 * the WYSIWYG oracle is exercised with a real materialization check plus its
 * wrong-geometry cross-check; and the forced-estimate-error lever is confirmed
 * to apply at runtime. If any of these regress, the helpers stop being honest
 * and every test built on them silently weakens.
 */

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

  // Put a mid-document block at the top so the flip has a non-trivial anchor to
  // preserve — a landing at scrollTop 0 would prove nothing.
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

  // The oracle: the anchor's markdown is materialized and near the top of the
  // readable area in the source view.
  await assertLanded(page, { mode: 'source', targetText: anchorMarker, placement: 'top' });

  // Non-interference: a plain toggle is scroll-only, so the source caret stays
  // at the document default rather than being placed at the landed range.
  expect(await readSourceCaretHead(page)).toBe(0);

  // Anti-vacuity: a target that is not in the document must throw, not pass.
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

  // The target must be materialized and on-screen; the far first block is the
  // wrong-geometry decoy that must be off-screen. No placement claim here — this
  // exercises the visibility-only form of the oracle.
  await assertLanded(page, { mode: 'wysiwyg', targetMarker, decoyMarker });

  // Anti-vacuity: a block that does not exist must throw, not pass.
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
  // A chunk wrapper must exist so the override's inheritance to the real
  // consumer is what gets confirmed, not just the :root declaration.
  await expect(page.locator(CHUNK_WRAPPER).first()).toBeAttached();

  // Self-asserting: throws if --ok-cv-h does not apply on :root and inherit to
  // the chunk wrapper.
  await injectForcedEstimateError(page, 400);
});
