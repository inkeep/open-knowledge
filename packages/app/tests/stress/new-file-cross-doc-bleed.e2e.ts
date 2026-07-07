/**
 * Bug-pin tests for cross-doc DOM bleed via the new-file flow.
 *
 * What the bug is. After opening a doc with substantial content and creating
 * a new file (via the browser-safe Cmd+Alt+N shortcut), the editor pane for the
 * brand-new doc displays the previous doc's rendered content above the empty
 * placeholder. The new doc's Y.Doc is empty server- and client-side; the
 * issue is purely client-side DOM — `@tiptap/react`'s
 * `PureEditorContent.componentDidMount` (and the symmetric
 * `componentWillUnmount`) run a move-all-siblings primitive
 * (`element.append(...editor.view.dom.parentNode.childNodes)`) on a parent
 * that, at the moment componentDidMount fires, already contains BOTH editors'
 * `.tiptap.ProseMirror` divs as siblings. The primitive vacuums them both
 * into the new file's EditorContent ref div.
 *
 * Three flows pinned (independent test() blocks):
 *   1. open-then-new-file — canonical case (the user-reported repro).
 *   2. navigate-then-new-file — open A, navigate to B, then new file. Confirms
 *      the bleed reproduces from any open doc, not just the first one opened.
 *   3. delete-then-recreate-same-docname — open A, delete A via API, then new
 *      file with the just-deleted docName. Confirms the bleed surface
 *      includes the docName-reuse-after-delete path.
 *
 * The 4th surface (source ↔ WYSIWYG mode-flip on an empty doc that follows
 * a substantial-content doc into the Activity pool) is pinned by the
 * sibling test file `editor-mode-flip-cross-doc-bleed.e2e.ts`.
 *
 * Tier: Playwright e2e against the per-worker `bun run dev` fixture.
 *
 * STOP rules honored:
 *   - Unique docNames via randomUUID per test (CLAUDE.md: no hardcoded
 *     'test-doc' in Playwright tests; parallel workers corrupt CRDT state).
 *   - Assertions on user-visible DOM only (no editor.view.dom direct access,
 *     no React fiber probes). The contract a user observes is a DOM contract.
 */

import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

/**
 * Double-rAF yield inside the page context — a deterministic two-frame
 * settlement for "let React + TipTap finish their commit cycle" semantics
 * without coupling to internal globals. Matches the convention in
 * `_helpers/editor-state.ts` selectAllAndWaitForSelection. STOP-rule
 * compliant alternative to the banned wall-clock-wait pattern.
 *
 * Implemented via waitForFunction (rAF polling) rather than a
 * page.evaluate-wrapped rAF promise: this helper runs right after hash
 * navigations, exactly when an app- or dev-server-initiated reload can
 * land, and an in-flight evaluate then throws "Execution context was
 * destroyed". waitForFunction
 * re-arms in the new execution context instead. The predicate's first
 * evaluation is immediate (not frame-aligned), so the threshold of 3
 * evaluations guarantees at least two real rAF ticks.
 */
async function yieldFramesInPage(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as typeof window & { __okYieldFrameCount?: number };
      w.__okYieldFrameCount = (w.__okYieldFrameCount ?? 0) + 1;
      if (w.__okYieldFrameCount >= 3) {
        w.__okYieldFrameCount = 0;
        return true;
      }
      return false;
    },
    null,
    { polling: 'raf', timeout: 10_000 },
  );
}

const CM6_BODY = [
  '# CM6 Elements (Long Doc — cross-doc bleed RED test)',
  '',
  'This is a long document used to demonstrate cross-doc bleed.',
  'The CANARY token below is the empirical signal that CM6 content is',
  'leaking into the new file Activity.',
  '',
  'CANARY_CROSS_DOC_BLEED_TOKEN_XYZ_123456789ABCDEF',
  '',
  '## Section A',
  'Line 1 in section A. Line 2 in section A. Line 3 in section A.',
  '',
  '## Section B',
  'Line 1 in section B. Line 2 in section B.',
  '',
  '## Section C',
  'Line 1 in section C. Line 2 in section C.',
].join('\n');

const CANARY = 'CANARY_CROSS_DOC_BLEED_TOKEN_XYZ_123456789ABCDEF';

/**
 * Trigger NewItemDialog via the browser-safe Cmd+Alt+N (or Ctrl+Alt+N) shortcut,
 * submit a brand-new docName, and wait for the new file's editor to mount.
 *
 * Settlement: wait for the new doc's HocuspocusProvider to finish initial
 * sync (`window.__activeProvider?.isSynced`), then yield two paint frames so
 * React's commit + TipTap's `EditorContent.componentDidMount` + the
 * move-all-siblings code path complete before the caller asserts. This is
 * the condition-based equivalent of the empirical-driver's 2500ms wall-clock
 * settle — STOP-rule compliant and still observing only user-visible
 * state (the provider's synced flag is the standard editor-ready signal per
 * `_helpers/provider.ts`).
 */
async function newFileViaShortcut(page: Page, newDocName: string): Promise<void> {
  // Defocus the editor so the global shortcut isn't suppressed by an INPUT /
  // TEXTAREA / contenteditable target (per isNewItemShortcut's guard in
  // components/NewItemDialog.tsx). Wait for focus to actually land on body —
  // browser focus dispatch is async on some platforms.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.waitForFunction(
    () => document.activeElement === null || document.activeElement === document.body,
    null,
    { timeout: 1_000 },
  );

  const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modKey}+Alt+KeyN`);

  await expect(page.getByRole('dialog', { name: /New file/i })).toBeVisible({
    timeout: 5_000,
  });

  await page.getByLabel(/^File name$/i).fill(newDocName);
  await page.getByRole('button', { name: /^Create$/ }).click();

  await expect(page.getByRole('dialog', { name: /New file/i })).toBeHidden({
    timeout: 5_000,
  });

  await page.waitForFunction((expected) => window.location.hash.includes(expected), newDocName, {
    timeout: 10_000,
  });

  // New doc's provider finished handshake + initial Y.Doc sync.
  await waitForActiveProviderSynced(page);
  // Two paint frames for React commit + TipTap mount + DOM-vacuum settlement.
  await yieldFramesInPage(page);
  await yieldFramesInPage(page);
}

/**
 * Direct API call to delete a file (mirrors file-tree-create.e2e.ts's
 * deletePathIfExists). Used by the delete-then-recreate variant.
 */
async function deleteFileViaApi(baseURL: string, path: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'file', path }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete-path failed for ${path}: ${res.status}`);
  }
}

/**
 * Resolve the new file's visible Activity scroll container. The activity pool
 * keeps multiple Activities mounted (one per recent doc); hidden Activities
 * carry `display: none` via React 19's <Activity mode="hidden">. Using the
 * `:visible` Playwright pseudo-class targets only the active Activity's
 * scroll container, which is where the bleed manifests.
 */
function visibleScrollContainer(page: Page): Locator {
  return page.locator('[data-testid="editor-scroll-container"]:visible');
}

/**
 * The contract this test pins. After the New File flow completes and React +
 * TipTap have settled, the visible Activity must contain exactly one
 * .tiptap.ProseMirror, and that PM's textContent must be empty (the empty
 * placeholder renders as `<p data-placeholder="..."><br/></p>` with empty
 * textContent).
 */
async function assertVisibleActivityHasOnlyEmptyEditor(page: Page): Promise<void> {
  const scroll = visibleScrollContainer(page);
  await expect(
    scroll,
    'exactly one editor scroll container should be visible after the New File flow',
  ).toHaveCount(1);

  const pms = scroll.locator('.tiptap.ProseMirror:not(.composer-prosemirror)');
  await expect(
    pms,
    "new file Activity must contain exactly one .tiptap.ProseMirror (cross-doc bleed signal: pmCount > 1 means another editor's view.dom has been vacuumed into this Activity's EditorContent ref div)",
  ).toHaveCount(1);

  await expect(
    pms.first(),
    "the new file's editor must render empty placeholder content (cross-doc bleed signal: non-empty textContent means the orphaned PM is from a different doc)",
  ).toHaveText('');
}

test.describe('new-file cross-doc bleed', () => {
  test('open doc then New File: new file Activity must contain exactly one empty editor', async ({
    page,
    api,
  }) => {
    test.setTimeout(60_000);

    const seedDocName = `seed-${randomUUID()}`;
    await api.seedDocs([{ name: seedDocName, markdown: CM6_BODY }]);

    // Cold-open the seed doc via hash navigation (the preferred cold-nav path
    // per _helpers/sidebar.ts).
    await page.goto(`/#/${seedDocName}`);
    await page.waitForLoadState('domcontentloaded');

    // Wait for the seed editor to mount and render the canary.
    await expect(page.getByText(CANARY)).toBeVisible({ timeout: 30_000 });
    await waitForActiveProviderSynced(page);

    // Sanity: at this point exactly one visible PM (the seed doc's editor)
    // with the canary text. If this fails, the test environment is broken
    // before we even trigger the bleed.
    await expect(
      visibleScrollContainer(page).locator('.tiptap.ProseMirror:not(.composer-prosemirror)'),
    ).toHaveCount(1);

    // Trigger the New File flow.
    const newDocName = `newfile-${randomUUID()}`;
    await newFileViaShortcut(page, newDocName);

    // Bug assertion: exactly one empty PM in the visible Activity.
    await assertVisibleActivityHasOnlyEmptyEditor(page);
  });

  test('open A, navigate to B, then New File: new file Activity must contain exactly one empty editor', async ({
    page,
    api,
  }) => {
    test.setTimeout(60_000);

    const docA = `seed-a-${randomUUID()}`;
    const docB = `seed-b-${randomUUID()}`;
    await api.seedDocs([
      { name: docA, markdown: CM6_BODY },
      { name: docB, markdown: '# Doc B Heading\n\nDoc B body content.' },
    ]);

    // Open A first (warm both pool entries).
    await page.goto(`/#/${docA}`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(CANARY)).toBeVisible({ timeout: 30_000 });
    await waitForActiveProviderSynced(page);

    // Navigate to B (so the Activity pool now has both A and B mounted, with
    // B visible and A hidden).
    await page.goto(`/#/${docB}`);
    await expect(page.getByText('Doc B body content.')).toBeVisible({ timeout: 30_000 });
    await waitForActiveProviderSynced(page);

    // Trigger New File from B's view.
    const newDocName = `newfile-${randomUUID()}`;
    await newFileViaShortcut(page, newDocName);

    await assertVisibleActivityHasOnlyEmptyEditor(page);
  });

  test('open A, delete A, then New File with the just-deleted docName: still exactly one empty editor', async ({
    page,
    api,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    // Use a docName we can re-create after deletion. randomUUID guarantees
    // it's brand-new globally for this worker; the bleed must reproduce
    // regardless of docName reuse.
    const reusedDocName = `reused-${randomUUID()}`;
    await api.seedDocs([{ name: reusedDocName, markdown: CM6_BODY }]);

    // Cold-open the seed.
    await page.goto(`/#/${reusedDocName}`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(CANARY)).toBeVisible({ timeout: 30_000 });
    await waitForActiveProviderSynced(page);

    // Delete the seed via API. The pool entry stays warm in memory; only the
    // on-disk file goes away. The next create-page for the same docName
    // recycles the in-memory entry's path.
    if (!baseURL) throw new Error('baseURL fixture missing');
    await deleteFileViaApi(baseURL, `${reusedDocName}.md`);
    // Yield frames so the file-watcher + observers process the delete event
    // before the create-page request below triggers the bleed surface.
    await yieldFramesInPage(page);
    await yieldFramesInPage(page);

    // Trigger New File with the SAME docName the deleted file had — the
    // docName-reuse-after-delete path is the worst case for the in-memory
    // pool entry that may still reference the prior doc's editor instance.
    await newFileViaShortcut(page, reusedDocName);

    await assertVisibleActivityHasOnlyEmptyEditor(page);
  });
});
