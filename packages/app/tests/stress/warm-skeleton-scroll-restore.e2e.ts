/**
 * Browser-fidelity verification for the warm-skeleton rename restoration
 * (scroll position + cursor selection).
 *
 * The unit + DOM tests cover the snapshot store + consume contract under
 * jsdom, but jsdom does not implement real layout — scrollHeight is whatever
 * you assign, no clamping, no layout cycles in step with content paint. The
 * bug class this E2E exists to catch lives in real-browser composition:
 *
 *   1. captureRenameSnapshots reads scrollTop from the active scroll
 *      container's live DOM, and the cursor selection from the live editor,
 *      at rename-trigger time.
 *   2. The old ActivityEntry unmounts; the new one mounts with a fresh
 *      ScrollPreservingContainer (a fresh `[data-testid="editor-scroll-
 *      container"]` div) and a fresh TipTap editor.
 *   3. The warm fallback HTML paints inside the fresh container, growing
 *      scrollHeight from ~0 to the real value across browser layout cycles.
 *   4. ScrollPreservingContainer's Stage 1 synchronous write + Stage 2
 *      bounded rAF poll re-apply the captured scrollTop. The new editor's
 *      first `'create'` event re-applies the captured cursor selection.
 *
 * If scrollHeight is insufficient at write time, the browser clamps
 * scrollTop to 0. The Stage 2 rAF poll must keep re-applying as scrollHeight
 * grows — critically, it must survive the warm-fallback → real-editor
 * Suspense swap, which transiently collapses scrollHeight and re-clamps
 * scrollTop to 0. If the poll terminated on first success (the bug a prior
 * iteration had), the post-swap clamp would persist and the user would see
 * the document scrolled back to top.
 *
 * This test reproduces both the scroll and selection paths end-to-end
 * against a real Chromium.
 */
import { expect, test, waitForActiveProviderSynced } from './_helpers';

// Doc large enough that the editor scroll container is meaningfully
// scrollable in a 1280×720 Playwright viewport. ~120 sections of prose
// produce ~6000-8000px of content height; the scroll container is
// ~640px tall (viewport minus header). Plenty of room to scroll.
const FILLER_LINE = 'Filler paragraph to force scrollable content. '.repeat(8);
function makeScrollableDoc(headingPrefix: string): string {
  const sections = Array.from(
    { length: 120 },
    (_, i) => `## ${headingPrefix} Section ${i + 1}\n\n${FILLER_LINE}`,
  );
  return [`# ${headingPrefix} Heading`, '', ...sections].join('\n\n');
}

// Structural shape of the DEV-only `window.__activeEditor` registry entry —
// the same access pattern other stress e2e specs use (asset-embed,
// asset-click-dispatch, drop-pipeline-auto-open). Only the members this
// test touches are declared.
type ActiveEditorProbe = {
  state: { doc: { content: { size: number } }; selection: { anchor: number } };
  commands: { setTextSelection: (pos: number) => void };
};
function readActiveEditorAnchor(): number {
  const ed = (window as unknown as { __activeEditor?: ActiveEditorProbe }).__activeEditor;
  return ed?.state.selection.anchor ?? 0;
}

test.describe('warm-skeleton rename restoration', () => {
  test('scroll position and cursor selection are preserved across rename of the open doc', async ({
    page,
    api,
    baseURL,
  }) => {
    // Seed one scrollable doc + an open-tab anchor doc (small) so the
    // sidebar always has at least one other treeitem to click after the
    // rename, isolating the assertion to the restore path rather than
    // route-resolution races.
    await api.seedDocs([
      { name: 'tall-doc', markdown: makeScrollableDoc('Tall') },
      { name: 'small-anchor', markdown: '# Small\n\nShort doc, no scroll.' },
    ]);

    await page.goto('/');
    const sidebar = page.locator('[data-slot="sidebar-container"]');

    // Open tall-doc and wait for the editor to mount + sync.
    await sidebar.getByRole('treeitem', { name: 'tall-doc.md', exact: true }).click({
      timeout: 10_000,
    });
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Tall Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // Place the caret at a known mid-document position. captureRenameSnapshots
    // → captureSelection reads editor.state.selection live at rename-trigger
    // time, so this caret is exactly what the snapshot stores. The returned
    // value is TipTap's *resolved* position (setTextSelection snaps to the
    // nearest valid text position).
    const capturedAnchor = await page.evaluate(() => {
      const ed = (window as unknown as { __activeEditor?: ActiveEditorProbe }).__activeEditor;
      if (!ed) return null;
      const pos = Math.min(800, ed.state.doc.content.size - 2);
      ed.commands.setTextSelection(pos);
      return ed.state.selection.anchor;
    });
    // Caret landed somewhere meaningful mid-document (not doc start).
    expect(capturedAnchor).not.toBeNull();
    expect(capturedAnchor as number).toBeGreaterThan(100);

    // Scroll the editor's scroll container down to a known offset. The
    // capture site reads from this exact element (data-testid pin).
    const scrollContainer = page.locator('[data-testid="editor-scroll-container"]');
    await expect(scrollContainer).toBeVisible({ timeout: 10_000 });

    // Pick a scroll target that's well below 0 and well below the maximum,
    // so the assertion has tolerance both ways. Capture the actual scrollTop
    // after the scroll to handle browser clamp/round.
    const TARGET_SCROLL = 1500;
    const scrolledTo = await scrollContainer.evaluate((el, t) => {
      el.scrollTop = t;
      return el.scrollTop;
    }, TARGET_SCROLL);

    // Sanity: the scroll actually landed somewhere meaningful.
    expect(scrolledTo).toBeGreaterThan(500);

    // Trigger rename via the same /api/rename-path the FileTree dispatches
    // to. This drives the same snapshot-capture path as the UI rename, and
    // the server-push onRenameRedirect handler fires in the client.
    const renameRes = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/rename-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'file', fromPath: 'tall-doc', toPath: 'tall-renamed' }),
      });
      return { status: r.status, body: await r.json() };
    }, baseURL);

    expect(renameRes.status).toBe(200);
    // The /api/rename-path response shape varies subtly across kinds; assert
    // on the load-bearing field (the renamed mapping) rather than the
    // top-level `ok` which is absent on some branches.
    expect(renameRes.body.renamed).toEqual([
      { fromDocName: 'tall-doc', toDocName: 'tall-renamed' },
    ]);

    // Sidebar updates: tall-renamed.md appears, tall-doc.md disappears.
    await expect(
      sidebar.getByRole('treeitem', { name: 'tall-renamed.md', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(sidebar.getByRole('treeitem', { name: 'tall-doc.md', exact: true })).toHaveCount(
      0,
      { timeout: 10_000 },
    );

    // The editor area should now be active on tall-renamed. Wait for
    // sync (the new provider opens against the new docName via the
    // onRenameRedirect handler in DocumentContext).
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Tall Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // Assertion 1 — scrollTop on the (new) scroll container is approximately
    // preserved. Tolerance accounts for:
    //   - The captured scrollTop may differ slightly from TARGET_SCROLL due
    //     to browser clamp/round at scroll time.
    //   - scrollHeight may be a few px different after rename due to React
    //     reconciliation / portal mounting timing.
    // We assert the user is *roughly where they were*, not pixel-equal.
    const newScrollContainer = page.locator('[data-testid="editor-scroll-container"]');
    await expect(newScrollContainer).toBeVisible({ timeout: 10_000 });

    // Wait for the warm-skeleton's scroll-restore to land. The mechanism is
    // a bounded per-frame poll inside ScrollPreservingContainer that re-
    // applies scrollTop across the warm-fallback → real-editor Suspense
    // swap. The full restoration window can run 200-500ms in dev (cold-mount
    // + CRDT hydration); the polling expect lets the value settle without
    // coupling the test to a specific frame.
    await expect
      .poll(async () => newScrollContainer.evaluate((el) => el.scrollTop), {
        timeout: 5_000,
        intervals: [50, 100, 200, 500],
      })
      .toBeGreaterThan(scrolledTo - 200);

    // After the poll settles, confirm strict > 0 — the failure mode this
    // test catches is "scrollTop clamped to 0".
    const restoredScrollTop = await newScrollContainer.evaluate((el) => el.scrollTop);
    expect(restoredScrollTop).toBeGreaterThan(0);

    // Assertion 2 — cursor selection is restored. The rename writes the same
    // bytes back, so the restored anchor should land on (or within a couple
    // of positions of) the captured value. The failure mode this catches is
    // "caret reset to document start" — restoredAnchor near 0 instead of
    // ~capturedAnchor. Poll because the consume effect fires on the new
    // editor's `'create'`, a beat after the provider syncs.
    const captured = capturedAnchor as number;
    await expect
      .poll(
        async () => {
          const anchor = await page.evaluate(readActiveEditorAnchor);
          return Math.abs(anchor - captured);
        },
        { timeout: 5_000, intervals: [50, 100, 200, 500] },
      )
      .toBeLessThan(10);
  });
});
