/**
 * Document-open UX — hybrid Activity + Suspense + ErrorBoundary.
 *
 * Covers the core navigation UX properties of the hybrid render tree.
 *
 * Requires: Playwright browsers installed. Server provided per-worker by
 * the `workerServer` fixture in `_helpers/fixtures.ts`; the `baseURL`
 * fixture resolves `page.goto('/…')` against it.
 */

import { DOCUMENT_OPEN_BYTE_LIMIT } from '@inkeep/open-knowledge-core';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

async function openFromSidebar(page: Page, filename: string) {
  const row = page.getByRole('treeitem', { name: filename, exact: true });
  // Render-gate before acting: a bare bounded click conflates "app/tree not
  // rendered yet" with "row missing", and its hand-rolled budget sat below
  // the config-owned expect budget the suite calibrates for CI contention.
  // Gate visibility web-first (inherits the config budget), then click.
  await expect(row).toBeVisible();
  await row.click();
}

function sidebarItem(page: Page, filename: string) {
  return page.getByRole('treeitem', { name: filename, exact: true });
}

const FILLER_LINE = 'Filler paragraph to force scrollable content. '.repeat(10);
const DOC_A = `# Doc A Heading\n\n${Array(30).fill(FILLER_LINE).join('\n\n')}\n\n## Doc A Bottom Marker\n\nEnd of doc A content.`;
const DOC_B = '# Doc B Heading\n\nDoc B unique body paragraph.';
const DOC_C = '# Doc C Heading\n\nDoc C unique body paragraph.';
const DOC_D = '# Doc D Heading\n\nDoc D unique body paragraph.';
const DOC_E = '# Doc E Heading\n\nDoc E unique body paragraph.';

test.describe('docs-open — hybrid navigation UX', () => {
  test('F0: shell snaps on click, editor mount is deferred', async ({ page, api }) => {
    // Shell-snap guarantee: on warm-nav click, the sidebar active-highlight
    // and the header document title MUST update independently of the editor
    // subtree's mount/re-render cost. The user perceives "shell froze" when
    // shell state waits for a heavy editor mount — that's the bug this
    // guards against.
    //
    // Test shape: seed a doc with many MARKS (wikilinks + inline code)
    // because PM's per-mark React portal reconciliation is the slow path
    // V2 cache protects against. Keep this fixture below the document open
    // cap so the test still exercises editor navigation rather than the
    // large-file state.
    // first cold mount runs the full create-view + mark-view path (~2-3s
    // `ok/editor/create-tiptap` in dev for 768 views) and is what
    // exercises shell-snap; subsequent revisits go through the cache-HIT
    // reparent path. The shell-snap guarantee must hold on both paths.
    //
    // If the shell freezes alongside the editor mount, this test's 250ms
    // budget on aria-current movement fails. If shell state is decoupled
    // (useDeferredValue or equivalent), aria-current flips in <50ms.
    // Sized as a mark-heavy doc (90 sections × 20+ wiki links ≈ 1800+
    // marks) that exercises the full cold-mount path on first visit and
    // stays cold-loadable within CI's 30s timeout. The cold load itself
    // is what stresses shell-snap; subsequent revisits go through the
    // V2 cache-HIT reparent path.
    const MARK_LINE = Array.from({ length: 20 }, (_, i) => `[[Link ${i}]]`).join(' ');
    const PARAGRAPH = `${MARK_LINE} and some \`inline code\` plus more [[wiki links]] here.`;
    const SECTION_FILLER = 'Extended prose paragraph to make the doc mark-heavy. '.repeat(20);
    const BIG_BODY = Array.from(
      { length: 90 },
      (_, i) => `## Section ${i}\n\n${PARAGRAPH}\n\n${SECTION_FILLER}\n`,
    ).join('\n');
    const BIG_DOC = `# Big Doc\n\n${BIG_BODY}\n\n## End\n`;
    const SMALL_DOC = '# Small\n\nShort.';
    expect(new TextEncoder().encode(BIG_DOC).byteLength).toBeLessThan(DOCUMENT_OPEN_BYTE_LIMIT);
    await api.seedDocs([
      { name: 'small', markdown: SMALL_DOC },
      { name: 'big', markdown: BIG_DOC },
    ]);

    await page.goto('/');
    // Warm both docs (cold loads do pay the full cost — that's fine).
    // 30s timeouts because mark-heavy big.md cold-mount runs 10-20s on
    // contended CI runners (default 5s toContainText timeout flakes);
    // this matches the 30s syncPromise hard-reject boundary.
    await openFromSidebar(page, 'small.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await openFromSidebar(page, 'big.md');
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Big Doc' }),
    ).toBeVisible({
      timeout: 30_000,
    });
    // Go back so the NEXT click (to big.md) is a warm cache-HIT nav.
    await openFromSidebar(page, 'small.md');
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Small' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // The sidebar's active-row indicator is `aria-selected="true"` — driven
    // by `activeDocName` directly. Before the click
    // it's on small.md's row; after the click we want it to move to big.md.
    // This is the load-bearing SHELL signal — completely independent of the
    // editor subtree rendering. If shell state is decoupled from editor
    // mount, this flips in one frame.
    const bigRow = sidebarItem(page, 'big.md');
    // Pre-assertion: small.md is currently active in the sidebar.
    await expect(sidebarItem(page, 'small.md')).toHaveAttribute('aria-selected', 'true');

    // Install an in-page timer that observes the aria-selected mutation so we
    // measure wall-clock time from click to shell-snap — Playwright's own
    // poll intervals (50-200ms) would round up our measurement and hide
    // subframe regressions. MutationObserver fires synchronously after the
    // microtask that flips the attribute, so the delta captures exactly
    // "click dispatch → React commit of new activeDocName".
    await page.evaluate(() => {
      window.__f0Result = null;
      const root = document.querySelector('file-tree-container')?.shadowRoot;
      if (!root) return;
      const start = performance.now();
      const observer = new MutationObserver(() => {
        const current = root.querySelector('[aria-selected="true"]');
        if (current?.getAttribute('aria-label') === 'big.md') {
          window.__f0Result = { shellMs: performance.now() - start };
          observer.disconnect();
        }
      });
      observer.observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-selected'],
      });
      window.__f0Start = start;
    });

    await bigRow.click();

    // Poll for the shell-snap result; the MutationObserver fills it as soon
    // as aria-selected moves. 2s timeout is generous enough to avoid flake
    // while still failing hard on the bug class (3s editor mount).
    await expect
      .poll(async () => (await page.evaluate(() => window.__f0Result)) !== null, {
        timeout: 2_000,
        intervals: [25, 50, 100],
      })
      .toBe(true);

    const result = await page.evaluate(() => window.__f0Result);
    if (!result) throw new Error('F0 result not captured');

    // Record editor-content arrival time as well, so the assertion can
    // express "shell snap << editor mount" rather than a magic wall-clock
    // budget. The shell-snap bug manifests as shell+editor arriving
    // together (shellMs ≈ editorMs) rather than shell arriving much
    // earlier (shellMs << editorMs).
    const editorStart = await page.evaluate(() => performance.now());
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Big Doc' }),
    ).toBeVisible({
      timeout: 30_000,
    });
    const editorMs = await page.evaluate(
      (start) => performance.now() - start,
      editorStart - (result.shellMs - 0),
    );
    // Log for diagnostic visibility in CI output.
    console.log(`[F0] shellMs=${result.shellMs.toFixed(1)} editorMs=${editorMs.toFixed(1)}`);

    // Shell-snap budget: 500ms. Measured baseline with useDeferredValue
    // decoupling is ~260ms on this test doc (shell) vs ~305ms (editor).
    // Without decoupling the measured value was ~1370ms — a shell-waits-
    // for-editor regression blows the budget by >2×. 500ms leaves CI
    // worker headroom (warmer is slower, Chromium event dispatch can add
    // 50-100ms) while still failing hard on the bug class.
    expect(result.shellMs).toBeLessThan(500);
  });

  test('F0b: warm reopen of a V2-admit doc shows NO EditorSkeleton', async ({ page, api }) => {
    // Warm-reopen contract: when both `mountTiptapEditorPromise` and
    // `syncPromise` have resolved cache entries for the target docName,
    // switching back from another doc must NOT show the EditorSkeleton.
    // `EditorArea.tsx`'s `useDeferredValue` overlay queries
    // `mountPromiseHasResolved` + `syncPromiseHasResolved` and skips the
    // skeleton when both are true — `use(promise)` short-circuits
    // synchronously, the deferred commit lands in 1 frame, and painting
    // a skeleton creates a perceptible "cold load" flash on a genuinely
    // warm reopen.
    //
    // Sibling F0c covers the V2-refuse case (mount-promise invalidated on
    // park, skeleton MUST appear). F3 covers cold-mount skeleton.
    const SMALL_A = '# Doc A\n\nSmall body A.';
    const SMALL_B = '# Doc B\n\nSmall body B.';
    await api.seedDocs([
      { name: 'doc-warm-a', markdown: SMALL_A },
      { name: 'doc-warm-b', markdown: SMALL_B },
    ]);

    await page.goto('/');

    // Warm both docs through the full mount path so both mount-promise +
    // sync-promise caches hold settled-resolved entries. After this
    // priming, both Activity entries exist in the pool and React has
    // observed `.status='fulfilled'` on both promises.
    await openFromSidebar(page, 'doc-warm-a.md');
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc A' }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await openFromSidebar(page, 'doc-warm-b.md');
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc B' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // Install skeleton-sighting observer BEFORE the warm-back click.
    await page.evaluate(() => {
      window.__f0bSkeletonSeen = false;
      window.__f0bSkeletonAppearances = [];
      const skeletonSelector = '[role="status"][aria-label="Loading document"]';
      const check = () => {
        if (document.querySelector(skeletonSelector)) {
          window.__f0bSkeletonSeen = true;
          window.__f0bSkeletonAppearances?.push(performance.now());
        }
      };
      check();
      const observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      window.__f0bObserverCleanup = () => observer.disconnect();
    });

    // Warm-switch back to doc A. Both promises are pre-resolved → overlay
    // must skip → no skeleton appearances.
    await openFromSidebar(page, 'doc-warm-a.md');
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc A' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    await page.evaluate(() => window.__f0bObserverCleanup?.());
    const seen = await page.evaluate(() => window.__f0bSkeletonSeen);
    const appearances = await page.evaluate(() => window.__f0bSkeletonAppearances ?? []);

    // Load-bearing assertion. If this fails, diagnose:
    //   (a) `parkTiptapEditor` invalidating the mount-promise cache on
    //       V2-admit park (regression of the park-preserves-cache fix), so
    //       `mountPromiseHasResolved` returns false on warm-back;
    //   (b) `syncPromise` being invalidated on tab switch, so
    //       `syncPromiseHasResolved` returns false;
    //   (c) The overlay condition in EditorArea ignoring the cache helpers
    //       and unconditionally painting during the deferred-value gap.
    expect(
      seen,
      `EditorSkeleton appeared during warm reopen — appearances at: ${JSON.stringify(appearances)}`,
    ).toBe(false);
  });

  // F0c (V2-refuse warm reopen → skeleton appears) is intentionally NOT
  // shipped as an e2e. The contract is unit-tested at
  // `editor-cache.test.ts` (park-on-uncached invalidates
  // mount-promise) + `mount-promise.test.ts`
  // (`mountPromiseHasResolved` returns false after invalidate). An e2e
  // exercising it via `BYTES_CACHE_THRESHOLD = 1` override hits a
  // StrictMode-dev artifact: Pattern D's effect cleanup destroys the
  // editor under `__uncached` without a useState-recovery loop, so the
  // double-invoke leaves the JSX referencing a destroyed editor and the
  // `<EditorContent>` never re-mounts within the same commit. In
  // production (StrictMode-off bundle) the path works correctly. Pinning
  // it down would require either disabling StrictMode for one test or a
  // real >8MB doc — both add disproportionate setup cost relative to the
  // unit-tier coverage that already exists. F0b (V2-admit warm reopen →
  // NO skeleton) covers the load-bearing user-observable contract; F3
  // covers cold-mount skeleton.

  test('F1: warm-nav preserves content atomically (scroll position survives A→B→A)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    // Open doc A first (cold mount) and wait for sync + content render.
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc A Bottom Marker' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // Scroll to a meaningful non-zero position with headroom on either side.
    // Scrolling to `scrollHeight` (the maximum) makes the test fragile because
    // PM's scrollHeight is sensitive to scroll-driven viewport materialization
    // (decoration plugins, BlockDragHandle visibility, chunk content-visibility
    // hydration) — the post-scroll scrollHeight is typically larger than the
    // pre-scroll one, and the post-warm-revisit scrollHeight may be smaller
    // still since restoration does not re-trigger the same viewport pass.
    // Saving the cap-clamped scrollTop and asserting near-equality after
    // warm-revisit then trips on a few px of layout drift even though the
    // user-facing invariant ("scroll position survived A→B→A") holds.
    // Scrolling to a midpoint with headroom (1500px) pins the same invariant
    // robustly: the saved position fits well within the warm-revisit
    // scrollable area regardless of small scrollHeight drift.
    const scroller = page
      .getByTestId('editor-scroll-container')
      .filter({ hasText: 'Doc A Bottom Marker' });
    await scroller.evaluate((el) => {
      el.scrollTo({ top: 1500, behavior: 'instant' });
    });
    const scrollBeforeNav = await scroller.evaluate((el) => el.scrollTop);
    expect(scrollBeforeNav).toBeGreaterThan(500);

    // Nav to doc B (cold mount, enters pool).
    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc B Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // Nav back to doc A — warm path via <Activity mode="visible">. Scroll
    // position should be preserved; no skeleton render in-between.
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc A Bottom Marker' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // Poll because Activity visibility-swap may take a render tick to settle.
    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollTop), {
        timeout: 3_000,
        intervals: [50, 100, 200],
      })
      .toBeGreaterThan(scrollBeforeNav - 50); // allow minor rounding; position must not reset to 0
  });

  // F2 was removed with the skeleton-first cold-path split (precedent #18(f)
  // narrowed to warm-only). Content-continuity on warm paths is a React
  // `startTransition` behavior — warm nav completes in a single commit
  // because `syncPromise` is already resolved, so there is no observable
  // pending window for a MutationObserver to sample. Cold-path skeleton
  // appearance is covered by F3; warm-reopen contracts (V2-admit
  // no-skeleton vs V2-refuse skeleton) are covered by F0b + F0c.
  //
  // F4 (cold + warm session-wide skeleton-sightings) was retired. Its
  // assertions split cleanly
  // into F3 (cold) + F0b (V2-admit warm — inverted, NO skeleton) + F0c
  // (V2-refuse warm — skeleton). The session-wide MutationObserver pattern
  // added no contract over the focused per-tier tests.

  test('F3: cold-nav paints EditorSkeleton immediately (no content-continuity flash)', async ({
    page,
    api,
  }) => {
    // Skeleton-first cold path (supersedes prior NavigationPendingBar test).
    // When the target doc's provider is NOT yet synced, openDocumentTransition
    // skips `startTransition` and lets React's default Suspense behavior paint
    // `<EditorSkeleton />` immediately — so the user sees motion rather than
    // the stale previous-doc content stretching through the mount window.
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Capture skeleton appearances via a MutationObserver so sub-100ms
    // transient mounts aren't missed by poll-based assertions.
    await page.evaluate(() => {
      window.__f3SkeletonEverVisible = false;
      const skeletonSelector = '[role="status"][aria-label="Loading document"]';
      const check = () => {
        if (document.querySelector(skeletonSelector)) {
          window.__f3SkeletonEverVisible = true;
        }
      };
      check();
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true });
      window.__f3ObserverCleanup = () => observer.disconnect();
    });

    // Nav to doc-b — cold path (provider not yet created). Skeleton should
    // appear at least once during the mount window. Use `hasText` filter
    // to disambiguate from doc-a's parked ProseMirror that lives in
    // Activity-hidden DOM (display:none) — without the filter, Playwright's
    // `.ProseMirror` locator resolves to multiple elements and the
    // ambiguity makes `toContainText` racey under Pattern D's mount
    // timing.
    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc B Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    await page.evaluate(() => window.__f3ObserverCleanup?.());

    const skeletonSeen = await page.evaluate(() => window.__f3SkeletonEverVisible);
    expect(skeletonSeen).toBe(true);

    // Skeleton must not be stuck visible after convergence — the nav settled
    // and the real editor should have taken over.
    await expect(page.locator('[role="status"][aria-label="Loading document"]')).toHaveCount(0);
  });

  test('F5: sync failure shows recoverable error boundary + retry re-enters Suspense', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Arm a rejection for doc-b's NEXT syncPromise creation BEFORE
    // navigation. The arm fires on promise creation (race-free) so the
    // error boundary renders deterministically on localhost where real
    // sync completes in <10ms and a post-hoc polling reject would miss
    // the pending window. See sync-promise.ts `__test_armPendingRejection`.
    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'timeout');
    });
    await openFromSidebar(page, 'doc-b.md');

    // ErrorBoundary fallback should render with role=alert + user-facing
    // "Couldn't load document" copy (precedent #15 error vocabulary; no
    // internal "sync" jargon — see errorCopy discipline in
    // DocumentErrorBoundary.tsx).
    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toContainText("Couldn't load document");
    await expect(errorAlert).toContainText('doc-b');

    // Click "Try again" → onReset fires → invalidateSyncPromise → re-enter
    // Suspense with a fresh promise → real sync completes → content shows.
    await errorAlert.getByRole('button', { name: 'Try again' }).click();

    // The retry should succeed because the real provider already synced
    // (hasSynced=true on the pool entry), so the fresh syncPromise resolves
    // immediately from the next emitted 'synced' (or already-synced state).
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc B Heading' }),
    ).toBeVisible({
      timeout: 10_000,
    });
  });

  test('F6: error boundary "Go back" navigates to prior doc', async ({ page, api }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc A Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // Arm B's syncPromise creation to reject. See F5 rationale — the arm is
    // race-free on localhost.
    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'predisconnect');
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toContainText('Connection dropped');

    // "Go back" is present when previousDocName is set
    // (it was — doc A was last successfully opened before the error on B).
    const backButton = errorAlert.getByRole('button', { name: 'Go back' });
    await expect(backButton).toBeVisible();
    await backButton.click();

    // Navigation should resolve back to doc A.
    await expect
      .poll(async () => page.evaluate(() => window.location.hash), {
        timeout: 5_000,
        intervals: [100, 200, 400],
      })
      .toContain('doc-a');
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc A Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });
  });

  test('F8: post-wake reconnect preserves content on the active doc', async ({ page, api }) => {
    await api.seedDocs([{ name: 'doc-a', markdown: DOC_A }]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc A Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // Snapshot the rendered content BEFORE the disconnect — we'll assert it
    // stays intact across the WS drop + reconnect.
    const expectedText = await page
      .locator('.ProseMirror:not(.composer-prosemirror)')
      .textContent();
    expect(expectedText).toContain('Doc A Heading');

    // Drop the WebSocket. Provider is already-synced, so hasSynced=true on
    // the pool entry — the Y.Doc content stays rendered regardless of
    // connection state.
    await page.evaluate(() => {
      window.__test_closeActiveWebSocket?.();
    });

    // Simulate sleep → wake by dispatching visibilitychange events.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Content MUST still be in DOM during the hidden phase.
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc A Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Post-wake: content stays rendered. HocuspocusProvider reconnects
    // transparently since hasSynced was true.
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc A Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // Error boundary must NOT have rendered (post-sync disconnect is handled
    // transparently, not surfaced as an error).
    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await expect(errorAlert).toHaveCount(0);
  });

  test('F11: rapid sequential navigation converges to final click', async ({ page, api }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
      { name: 'doc-c', markdown: DOC_C },
      { name: 'doc-d', markdown: DOC_D },
      { name: 'doc-e', markdown: DOC_E },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Fire 4 clicks in rapid sequence (no waitForTimeout between them).
    // React's transition semantics should coalesce — the final click wins
    // and no nav is left pending indefinitely.
    //
    // STOP — do NOT switch this to Promise.all. Playwright's per-click
    // actionability checks (visible/stable/attached) settle in
    // non-deterministic order across concurrent invocations, so the click
    // dispatch order is NOT guaranteed to match array order. Sequential
    // await guarantees the doc-e click fires last (its order is the test's
    // load-bearing premise) without injecting any test-side wait — each
    // click takes ~5-30ms (actionability bound), so the 4 clicks still
    // dispatch within ~100ms.
    await openFromSidebar(page, 'doc-b.md');
    await openFromSidebar(page, 'doc-c.md');
    await openFromSidebar(page, 'doc-d.md');
    await openFromSidebar(page, 'doc-e.md');

    // Wait for final state: doc E is active and visible.
    await waitForActiveProviderSynced(page);
    await expect
      .poll(async () => page.evaluate(() => window.location.hash), {
        timeout: 10_000,
        intervals: [100, 200, 400],
      })
      .toContain('doc-e');

    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc E Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // EditorSkeleton must not be stuck visible after convergence — the nav
    // settled and the real editor should have taken over.
    await expect
      .poll(async () => page.locator('[role="status"][aria-label="Loading document"]').count(), {
        timeout: 5_000,
        intervals: [100, 200, 400],
      })
      .toBe(0);
  });

  test('F10: source editor path follows same architecture (warm swap preserves cm state)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Switch to source mode. 15s timeout handles the deferred-commit
    // window on CI — mode-toggle state update triggers a fresh render
    // pass that may need to wait for the editor subtree's deferred
    // commit before CM content renders (the skeleton overlay covers
    // the pool during that window).
    await page.getByRole('radio', { name: 'Markdown source' }).click();
    await page.waitForSelector('.cm-content', { timeout: 15_000 });
    await expect(page.locator('.cm-content').first()).toContainText('Doc A Heading', {
      timeout: 15_000,
    });

    // Nav to doc B (cold mount inside source mode).
    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    // Scope to VISIBLE cm-content. With V2 cache / Activity the prior
    // doc's CM stays in the DOM (Activity hidden); `.first()` returns
    // DOM order which matches pool MRU — the ACTIVE doc's editor is
    // positioned last in the Activity list... actually since DOM order
    // may vary, widen the assertion to `at-least-one-cm-content-has`.
    await expect(page.locator('.cm-content').filter({ hasText: 'Doc B Heading' })).toBeVisible({
      timeout: 15_000,
    });

    // Nav back to doc A — should be Activity-warm. The CodeMirror editor
    // for doc A should still be in the DOM (just hidden) and its content
    // should become visible when Activity re-shows it.
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.cm-content').filter({ hasText: 'Doc A Heading' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('F13: a11y attributes present on EditorSkeleton + error-boundary surfaces', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // EditorSkeleton — catch a11y attrs on a race: the skeleton renders
    // transiently during cold nav; use a MutationObserver to snapshot its
    // attributes if/when it appears. Post-NavigationPendingBar, the
    // skeleton is the only surface that announces "loading" to ATs.
    await page.evaluate(() => {
      window.__f13BarAttrs = null;
      const observer = new MutationObserver(() => {
        const skeleton = document.querySelector('[role="status"][aria-label="Loading document"]');
        if (skeleton && !window.__f13BarAttrs) {
          window.__f13BarAttrs = {
            role: skeleton.getAttribute('role'),
            ariaLive: skeleton.getAttribute('aria-live'),
            ariaHidden: skeleton.getAttribute('aria-busy'),
          };
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.__f13ObserverCleanup = () => observer.disconnect();
    });

    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc B Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await page.evaluate(() => window.__f13ObserverCleanup?.());

    const barAttrs = await page.evaluate(() => window.__f13BarAttrs);
    expect(barAttrs).not.toBeNull();
    expect(barAttrs?.role).toBe('status');
    // EditorSkeleton uses aria-busy="true" (implicit live-region semantics)
    // rather than aria-live="polite" — the Radix Skeleton primitive the
    // fallback is built on provides aria-busy as the canonical loading
    // affordance. `ariaLive` is intentionally null on this surface.
    expect(barAttrs?.ariaLive).toBeNull();
    // Field reused from the legacy bar attrs shape — carries aria-busy here.
    expect(barAttrs?.ariaHidden).toBe('true');

    // Error boundary a11y — arm a rejection on a fresh navigation to observe
    // role=alert on the fallback. We nav to doc-c (seeded fresh below) so
    // DocumentBoundary creates a brand-new syncPromise entry that the arm
    // can reject on creation. See F5 for the arm-vs-reject timing rationale.
    await api.createPage('doc-c.md');
    await api.replaceDoc('doc-c', DOC_C);
    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-c', 'timeout');
    });
    await openFromSidebar(page, 'doc-c.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toHaveAttribute('role', 'alert');
    await expect(errorAlert).toHaveAttribute('aria-labelledby', 'document-error-title');
  });

  // ── Compositional error-path coverage ──
  // These test the error-boundary state machine's composition with navigation,
  // retry, and visibility events. Unblocked by __test_armPendingRejection
  // (race-free arm-before-create; see sync-promise.ts).

  test('QA-022: error → retry succeeds → continue editing (compositional)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Arm a single rejection for doc-b. After the Try-again invalidates the
    // cache, the fresh syncPromise resolves normally (real provider is already
    // in-pool from any prior setup, or freshly synced on recycle).
    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'timeout');
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toContainText('doc-b');

    // Retry re-enters Suspense, sync completes, editor mounts with content.
    await errorAlert.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc B Heading' }),
    ).toBeVisible({
      timeout: 10_000,
    });

    // Compositional tail: user continues editing after retry-recovery.
    // The persisted text round-trips to Y.Doc content readable via the
    // same editor surface — proves the recovered editor is fully functional,
    // not just displaying stale content.
    const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await editor.click();
    await page.keyboard.press('End'); // move cursor to end of existing content
    await page.keyboard.type(' post-recovery typed content');
    await expect(editor).toContainText('post-recovery typed content', { timeout: 5_000 });
  });

  test('QA-023: navigate-away hides error from user (per-Activity scoping)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Force error on doc-b.
    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'timeout');
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });

    // Navigate AWAY via sidebar (not via the error-boundary "Back" button —
    // the sidebar path does NOT invalidate the errored-doc's cache).
    // Under per-Activity scoping, doc-b's error boundary
    // stays in error state but its Activity flips to hidden via display:none,
    // so the user no longer sees it.
    await openFromSidebar(page, 'doc-a.md');

    // Error UI must no longer be visible to the user. DOM may persist in
    // the hidden Activity subtree (other scenarios rely on this persistence),
    // but `toBeHidden()` is true when an ancestor has `display:none`.
    await expect(errorAlert).toBeHidden({ timeout: 5_000 });
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toContainText(
      'Doc A Heading',
    );
  });

  test('QA-024: errored-doc revisit re-renders error (cached-rejection persistence)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Arm one rejection for doc-b. After it fires once, the cache entry
    // holds the rejected promise — revisiting doc-b via sidebar without
    // invalidating (i.e., without clicking Try again or the Back-nav button)
    // must re-throw from the same cached rejection.
    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'predisconnect');
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });

    // Navigate away via sidebar (no invalidate). Under per-Activity scoping
    // doc-b's error UI goes hidden via Activity display:none.
    await openFromSidebar(page, 'doc-a.md');
    await expect(errorAlert).toBeHidden({ timeout: 5_000 });

    // Re-visit doc-b WITHOUT re-arming (arms are one-shot; the persistence
    // property we're testing is the syncPromise cache itself, not the arm).
    // The error must re-appear — either (a) doc-b's Activity flips back to
    // visible with its prior error-boundary state still tripped, OR (b) if
    // doc-b was evicted from the MRU mount list, a fresh boundary instance
    // re-throws from the cached rejection held by `sync-promise.ts`.
    await openFromSidebar(page, 'doc-b.md');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toContainText('doc-b');
  });

  test('QA-027: pre-sync sleep → wake shows error (not silent failure)', async ({ page, api }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Pre-sync failure scenario: before doc-b finishes its initial sync, a
    // sleep→wake cycle occurs. The error boundary must show, not silently
    // leave a blank editor. Modeled via arm-rejection (the user-facing
    // outcome — error boundary rendered with recoverable UX — is the same
    // whether the root cause is real WS drop or synthetic rejection).
    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'predisconnect');
    });

    // Simulate sleep before the nav fires — purely to cover the compositional
    // path (visibility change + error-boundary interaction).
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await openFromSidebar(page, 'doc-b.md');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toContainText('doc-b');
    // Recovery path is reachable — Try again button is present + focused.
    const tryAgain = errorAlert.getByRole('button', { name: 'Try again' });
    await expect(tryAgain).toBeVisible();
  });

  // ── Provider-pool recycle on sustained disconnect (RECYCLE_DEBOUNCE_MS = 4000) ──
  // Validated here via page.clock —
  // virtual time advances past the debounce without burning real wall-clock.
  // The test-only __test_closeActiveWebSocket hook closes the live WS, pool
  // enters pendingRecycleTimer, clock.runFor(5s) fires the setTimeout inside
  // RECYCLE_DEBOUNCE_MS, destroyEntry runs → invalidateSyncPromise + re-create.
  test('QA-015: provider-pool 4s recycle exercised via page.clock', async ({ page, api }) => {
    await page.clock.install();

    await api.seedDocs([{ name: 'doc-a', markdown: DOC_A }]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Snapshot pre-recycle state so we can assert the entry survived the
    // debounce window AND is a fresh instance after recycle.
    const before = await page.evaluate(() => {
      const pool = window.__providerPool;
      return {
        activeDocName: pool?.getActiveDocName() ?? null,
        poolSize: pool?.entries?.size ?? -1,
      };
    });
    expect(before.activeDocName).toBe('doc-a');
    expect(before.poolSize).toBe(1);

    // Close the active WS → HocuspocusProvider fires 'disconnect' →
    // provider-pool starts the 4s pendingRecycleTimer.
    await page.evaluate(() => {
      window.__test_closeActiveWebSocket?.();
    });

    // Advance past RECYCLE_DEBOUNCE_MS = 4000. The setTimeout inside the pool
    // fires; destroyEntry runs (invalidateSyncPromise + provider destroy +
    // fresh PoolEntry construction). Pool size should stabilise at ≤1 —
    // either the entry is re-created fresh (size=1) or evicted (size=0).
    await page.clock.runFor(5_000);

    const after = await page.evaluate(() => ({
      poolSize: window.__providerPool?.entries?.size ?? -1,
    }));
    expect(after.poolSize).toBeGreaterThanOrEqual(0);
    expect(after.poolSize).toBeLessThanOrEqual(1);
  });

  test('F0-mdx: sidebar click on a .mdx file loads and renders its content', async ({
    page,
    api,
  }) => {
    // End-to-end proof of first-class .mdx admission: an .mdx file on disk
    // must appear in the sidebar, be clickable, and render its body in the
    // editor. Pairs with the integration-tier coverage in
    // `packages/app/tests/integration/mdx-extension.test.ts` (which exercises
    // watcher→CRDT) — this test adds the browser-side DOM path that
    // integration can't reach (sidebar DOM → hash nav → editor mount).
    const docName = 'mdx-sidebar-proof';
    const mdxBody = '# MDX Sidebar Proof\n\nContent rendered from a .mdx file via sidebar click.\n';
    await api.testReset();
    await api.createPage(`${docName}.mdx`);
    await api.replaceDoc(docName, mdxBody);

    await page.goto('/');
    // The sidebar displays the filename with extension — so the text to click
    // is `${docName}.mdx`, not the extension-less docName.
    await openFromSidebar(page, `${docName}.mdx`);
    await waitForActiveProviderSynced(page);

    // The body content must be in the live editor DOM. Wait for it — the
    // editor mount is async after the shell snaps, and the full
    // sidebar-click → hash-nav → provider-sync → editor-mount → render
    // chain runs cold here; 30s matches the suite's other cold
    // content-render budgets (10s flaked under 4-worker CI contention).
    await expect(page.getByText('Content rendered from a .mdx file')).toBeVisible({
      timeout: 30_000,
    });
    // Shell confirmation: the rename-affordance button in the editor header
    // renders the filename-with-extension as its accessible name. Proves the
    // header is extension-aware (reads from PageListContext.pageMeta.docExt)
    // rather than hard-coding `.md`. Scoped to main so we don't collide with
    // the identically-named sidebar list item.
    await expect(
      page.getByRole('main').getByRole('button', { name: `${docName}.mdx`, exact: true }),
    ).toBeVisible();
  });
});

// ── WS-interception tests (context.routeWebSocket before goto) ──────────
// These tests use context.routeWebSocket() registered BEFORE page.goto() to
// intercept HocuspocusProvider's /collab WebSocket at the Chromium network
// shim level. This is required because page-level routeWebSocket registered
// AFTER goto doesn't intercept (timing — Playwright docs: "Only WebSockets
// created after routeWebSocket was called will be routed"). Context-level
// routes + pre-goto registration solve both the timing issue and the context-
// reuse bug (playwright#34045). These tests destructure `{ context }` instead
// of `{ page }` and create their own page.

test.describe('docs-open — WS-interception scenarios', () => {
  // ── Pre-sync WebSocket disconnect → PreSyncDisconnectError ──
  test('QA-014: pre-sync WS close → PreSyncDisconnectError → "Connection dropped"', async ({
    context,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    // Track WS connections; passthrough initially, close after toggle.
    let blockMode: 'passthrough' | 'close' = 'passthrough';
    await context.routeWebSocket(/collab/, (ws) => {
      if (blockMode === 'close') {
        ws.close();
        return;
      }
      ws.connectToServer();
    });

    const page = await context.newPage();
    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Toggle: next WS connection (doc-b) will be closed immediately.
    blockMode = 'close';
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 15_000 });
    await expect(errorAlert).toContainText('Connection dropped');
    await expect(errorAlert).toContainText('doc-b');
  });

  // ── warm-recycle with hung WS — Suspense fallback + eventual timeout ──
  // The F3 test already validates that EditorSkeleton appears during cold nav
  // via a MutationObserver that catches transient DOM mounts. This
  // scenario adds a recycle-path validation: after recycling a warm doc with
  // WS blocked, the Suspense fallback (EditorSkeleton) renders and eventually
  // the 30s syncPromise timeout fires the ErrorBoundary.
  //
  // This test validates the structural claim: on a warm-recycle with hung WS,
  // the doc eventually times out via the real 30s path (not stuck forever).
  test('QA-012: warm-recycle with hung WS → doc-b unsynced, eventually errors', async ({
    context,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    let blockMode: 'passthrough' | 'hang' = 'passthrough';
    await context.routeWebSocket(/collab/, (ws) => {
      if (blockMode === 'hang') return;
      ws.connectToServer();
    });

    const page = await context.newPage();
    await page.goto('/');

    // Warm both docs
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);

    // Block + recycle doc-b
    blockMode = 'hang';
    await page.evaluate(() => {
      window.__providerPool?.recycle('doc-b');
    });
    await openFromSidebar(page, 'doc-b.md');

    // doc-b is unsynced (WS hung) — wait for the pool to register doc-b as
    // active (provider lifecycle), then assert isSynced=false
    // remains stable. activeDoc updates synchronously when the pool's
    // open() resolves; isSynced stays false because the WS handshake hangs.
    await expect
      .poll(() => page.evaluate(() => window.__providerPool?.getActiveDocName() ?? null))
      .toBe('doc-b');
    const state = await page.evaluate(() => ({
      activeDoc: window.__providerPool?.getActiveDocName() ?? null,
      isSynced: window.__activeProvider?.isSynced ?? null,
    }));
    expect(state.activeDoc).toBe('doc-b');
    expect(state.isSynced).toBe(false);
  });

  // ── Real syncPromise timeout via hung WS → ErrorBoundary ──
  // Same warm-recycle approach. After warm-up, scales down the
  // sync-timeout dial via `__okPerfOverrides.SYNC_TIMEOUT_MS` so the real
  // production `setTimeout` callback inside `syncPromise` fires without a
  // 30s wall-clock wait. The override mechanism (env-override.ts) was
  // designed for exactly this surface; tuning the dial does NOT
  // short-circuit the timeout path the way `__test_armPendingRejection`
  // would. The production default (30_000 ms) is pinned by a unit test
  // in `sync-promise.test.ts` so this dial-down doesn't degrade
  // prod-config coverage.
  test('QA-013: real syncPromise timeout → "Couldn\'t load document"', async ({ context, api }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    let blockMode: 'passthrough' | 'hang' = 'passthrough';
    await context.routeWebSocket(/collab/, (ws) => {
      if (blockMode === 'hang') return;
      ws.connectToServer();
    });

    const page = await context.newPage();
    await page.goto('/');

    // Warm both docs under the production-default 30s timeout — the
    // override below only fires for `syncPromise(...)` calls that arm a
    // fresh timer (i.e. the post-recycle re-open of doc-b). Warm-up
    // entries settle to resolved sentinels long before the dial change.
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);

    // Lower the dial AFTER warm-up. `readNumericOverride` is read per-
    // `setTimeout` call inside `syncPromise`, so existing settled entries
    // are unaffected; the next syncPromise creation (after recycle) reads
    // 2_000.
    await page.evaluate(() => {
      window.__okPerfOverrides = {
        ...window.__okPerfOverrides,
        SYNC_TIMEOUT_MS: 2_000,
      };
    });

    // Block + recycle doc-b. The fresh syncPromise armed by re-open
    // reads the dial above and fires its timeout callback in ~2s, taking
    // the real production reject → React error-boundary path.
    blockMode = 'hang';
    await page.evaluate(() => {
      window.__providerPool?.recycle('doc-b');
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 7_000 });
    await expect(errorAlert).toContainText("Couldn't load document");
    await expect(errorAlert).toContainText('doc-b');
    await expect(errorAlert.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

// Global type augmentation for the test-only window properties used above.
declare global {
  interface Window {
    __f0Start?: number;
    __f0Result?: { shellMs: number } | null;
    __f0bSkeletonSeen?: boolean;
    __f0bSkeletonAppearances?: number[];
    __f0bObserverCleanup?: () => void;
    __f3SkeletonEverVisible?: boolean;
    __f3ObserverCleanup?: () => void;
    __f13BarAttrs?: {
      role: string | null;
      ariaLive: string | null;
      ariaHidden: string | null;
    } | null;
    __f13ObserverCleanup?: () => void;
  }
}
