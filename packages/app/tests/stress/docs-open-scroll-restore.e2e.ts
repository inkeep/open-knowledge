/**
 * Deterministically reproduces the warm-nav scroll-restore race that
 * flakes ~5–20% in CI but not on fast local machines. Reproduces by
 * monkey-patching `Node.prototype.appendChild` (via `page.addInitScript`,
 * page-scoped only) to defer portal-target appends by 250 ms, synthesizing
 * the contention ordering where the reparent lands AFTER
 * `ScrollPreservingContainer`'s restore layout effect.
 *
 * The patch identifies portal-target elements by the `data-ok-editor-portal`
 * attribute, set in `EditorActivityPool.ActivityEntry`'s portal-target
 * `useState` initializer. The patch runs in the page context only and is
 * reverted automatically when the page closes. If production stops
 * labeling the portal target with that attribute (or stops using
 * `appendChild` to reparent it), the safety check below
 * (`patchFireCount > 0`) fails loudly so the test surfaces the silent-
 * fragility instead of passing on a still-broken bug.
 *
 * Without the fix:
 *   The deferred appendChild lands AFTER `ScrollPreservingContainer`'s
 *   restore layout effect. Stage 1's synchronous `el.scrollTop = target`
 *   clamps to 0 (content not in subtree yet, `scrollHeight ≤ clientHeight`).
 *   With a one-shot retry (single rAF or `ResizeObserver(el)` on the outer
 *   `h-full` container), the retry fires before content lands — the
 *   container's own content-box never changes on inner ProseMirror
 *   inflation — so the restore stays at 0 until the safety timer abandons
 *   it. The `expect.poll` times out → FAIL.
 *
 * With the fix:
 *   Stage 2's bounded per-frame `requestAnimationFrame` poll re-evaluates
 *   `scrollTop !== target && scrollHeight > target` every frame. When the
 *   deferred reparent + ProseMirror inflations land at ~250 ms, the next
 *   rAF tick re-applies `scrollTop = target` and emits
 *   `ok/scroll-restore/phase2-success`. The poll detects the restored
 *   position well before the 2 s safety timer → PASS.
 *
 * Test polling window (450 ms) is intentionally BELOW the 2000 ms
 * production safety timer that fires `ok/scroll-restore/abandoned` when
 * Stage 2 never landed. A regression that breaks the rAF-poll path but
 * is masked by some other late write would restore at >= 2 s with a
 * user-perceptible scroll bounce — that is a UX regression, not a
 * successful fallback. This test treats it as a failure to specifically
 * pin the rAF-poll mechanism that delivers the "no perceptible delay"
 * contract; F1 in `docs-open.e2e.ts` remains the looser fix-agnostic
 * gate at 3 s. 450 ms gives ~190 ms slack against an expected ~260 ms
 * restore (250 ms patch defer + next rAF tick).
 *
 * Invocation (bug-specific gate):
 *   cd public/open-knowledge/packages/app && \
 *     bunx playwright test tests/stress/docs-open-scroll-restore.e2e.ts \
 *       --workers=1 --retries=0
 */

import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

async function openFromSidebar(page: Page, filename: string) {
  const row = page.getByRole('treeitem', { name: filename, exact: true });
  // Render-gate before acting (mirrors docs-open.e2e.ts): a bare bounded
  // click conflates "app/tree not rendered yet" with "row missing", and a
  // hand-rolled budget sits below the config-owned expect budget.
  await expect(row).toBeVisible();
  await row.click();
}

// Same shape as docs-open.e2e.ts's DOC_A / DOC_B so this test exercises
// the same scroll budget (~1500 px midpoint, well within doc-A's
// scrollable extent post-warm-revisit).
const FILLER_LINE = 'Filler paragraph to force scrollable content. '.repeat(10);
const DOC_A = `# Doc A Heading\n\n${Array(30).fill(FILLER_LINE).join('\n\n')}\n\n## Doc A Bottom Marker\n\nEnd of doc A content.`;
const DOC_B = '# Doc B Heading\n\nDoc B unique body paragraph.';

// The init script: install the appendChild monkey-patch BEFORE any app
// code runs. Identifies portal-target elements by the
// `data-ok-editor-portal` attribute set in
// `EditorActivityPool.ActivityEntry`'s portalTarget useState initializer.
// When such an element is appended, the patch defers the actual append
// by 250 ms — long enough that the reparent reliably lands AFTER
// `ScrollPreservingContainer`'s restore layout effect, synthesizing the
// CI-contention ordering deterministically.
//
// `window.__okScrollRestoreTest_patchFireCount` is the safety counter
// the test asserts on; if production stops labeling the portal target
// with `data-ok-editor-portal` (or stops using `appendChild` to reparent
// it), the counter stays at 0 and the test fails with "monkey-patch
// never fired" — surfacing the test fragility rather than silently
// passing on a still-broken bug.
const PORTAL_APPEND_DELAY_PATCH = () => {
  const origAppendChild = Node.prototype.appendChild;
  let fireCount = 0;
  Node.prototype.appendChild = function <T extends Node>(this: Node, child: T): T {
    if (
      child instanceof HTMLElement &&
      typeof child.getAttribute === 'function' &&
      child.getAttribute('data-ok-editor-portal') !== null
    ) {
      fireCount += 1;
      (
        window as Window & { __okScrollRestoreTest_patchFireCount?: number }
      ).__okScrollRestoreTest_patchFireCount = fireCount;
      // Defer the reparent. Synthesizes the CI-contention ordering where
      // the portal-target reparent lands AFTER ScrollPreservingContainer's
      // restore layout effect. 250 ms is comfortably greater than the
      // layout-effect's synchronous window so the inversion is reliable.
      setTimeout(() => {
        origAppendChild.call(this, child);
      }, 250);
      // appendChild's spec says return the appended node. The actual
      // production caller (TiptapEditor's `portalSlotRef` useLayoutEffect)
      // does not consume the return value; returning the child
      // synchronously here matches the API shape so a future consumer
      // that DOES read it stays sound.
      return child;
    }
    return origAppendChild.call(this, child) as T;
  } as typeof Node.prototype.appendChild;
};

test.describe('docs-open-scroll-restore — F1 RED (deterministic via portal-append delay)', () => {
  test('F1-race: warm-nav scroll position survives A→B→A under content-late ordering', async ({
    page,
    api,
  }) => {
    // STEP 1 — install the portal-append delay BEFORE app boot.
    // `addInitScript` fires on every navigation in the page's lifetime,
    // covering both `page.goto('/')` and any subsequent SPA route change.
    await page.addInitScript(PORTAL_APPEND_DELAY_PATCH);

    // STEP 2 — seed docs (same shape as F1).
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');

    // STEP 3 — open doc A (cold mount). The delay applies here too but
    // cold mount has savedScrollTop=0 so Phase 1 returns early (no race).
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc A Bottom Marker' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // STEP 4 — scroll to a meaningful non-zero position. Midpoint (1500 px)
    // is chosen for the same reason F1 uses it: headroom on either side
    // makes the assertion robust against PM scrollHeight drift across the
    // viewport-driven re-materialization on warm-revisit.
    const scroller = page
      .getByTestId('editor-scroll-container')
      .filter({ hasText: 'Doc A Bottom Marker' });
    await scroller.evaluate((el) => {
      el.scrollTo({ top: 1500, behavior: 'instant' });
    });
    const scrollBeforeNav = await scroller.evaluate((el) => el.scrollTop);
    expect(scrollBeforeNav).toBeGreaterThan(500);

    // STEP 5 — nav to doc B (cold mount, enters pool). Doc A enters
    // Activity mode=hidden; ScrollPreservingContainer's saved scrollTop
    // ref persists across the hidden flip.
    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc B Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // STEP 5.5 — reset the patch-fire counter BEFORE the warm-nav so STEP 7's
    // safety check specifically confirms the warm-reopen path fired the patch
    // (not just the cold doc-A mount in STEP 3). A future TiptapEditor change
    // that swapped `slot.appendChild(portalTarget)` for `slot.replaceChildren`
    // only on warm-nav reinitialization would still pass `patchFireCount > 0`
    // via the cold-mount fire — silently disabling the race reproduction
    // while the behavioral assertion remained the only guard. Resetting here
    // makes the counter test specifically scoped to the warm-nav path.
    await page.evaluate(() => {
      (
        window as Window & { __okScrollRestoreTest_patchFireCount?: number }
      ).__okScrollRestoreTest_patchFireCount = 0;
    });

    // STEP 6 — nav back to doc A (warm path via <Activity mode="visible">).
    // The portal-append delay applied to doc-A's portal-target ensures the
    // reparent lands AFTER ScrollPreservingContainer's restore effect —
    // exactly the CI-contention scenario surfacing the bug.
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Doc A Bottom Marker' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // STEP 7 — safety check: the monkey-patch MUST have fired at least once
    // ON THE WARM-NAV path (the counter was reset in STEP 5.5 specifically
    // to scope this assertion to STEP 6's warm reopen). If
    // `data-ok-editor-portal` is no longer the identifier on the warm-nav
    // path (or that path no longer uses `Node.prototype.appendChild`), the
    // delay isn't applied, the race isn't reproduced, and a silently-
    // passing bug-present run would be the false-negative result. Fail
    // loudly with the diagnostic instead.
    const patchFireCount = await page.evaluate(
      () =>
        (window as Window & { __okScrollRestoreTest_patchFireCount?: number })
          .__okScrollRestoreTest_patchFireCount ?? 0,
    );
    expect(
      patchFireCount,
      'monkey-patch never fired on the warm-nav path — `data-ok-editor-portal` attribute / portal append path changed in production code; this test no longer reproduces the F1 race deterministically. Re-check `EditorActivityPool.ActivityEntry`s portalTarget useState initializer and `TiptapEditor.portalSlotRef` useLayoutEffect.',
    ).toBeGreaterThan(0);

    // STEP 8 — the user-facing contract: scroll position must be restored
    // after the warm-reopen, well before the 2000 ms safety timer that
    // production uses to abandon Stage 2 if rAF-poll never lands. Polling
    // window (450 ms) is deliberately far below 2 s — the rAF-poll must do
    // the work. Patch defers appendChild by 250 ms, so the next rAF tick
    // re-applies scrollTop at ~260 ms, giving ~190 ms slack within the
    // 450 ms window. (450 ms vs original 400 ms: the extra 50 ms absorbs
    // VM-jitter on the GH Actions runner without raising the perceptibility
    // ceiling enough to risk masking a real regression.)
    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollTop), {
        timeout: 450,
        intervals: [25, 50, 100],
      })
      .toBeGreaterThan(scrollBeforeNav - 50); // allow minor rounding; position must not reset to 0

    // STEP 9 — mechanistic pin: the `ok/scroll-restore/phase2-success`
    // performance mark MUST be emitted. STEP 8 is the behavioral contract
    // (scroll position lands within 450 ms) but is mechanism-agnostic — a
    // future refactor that restores scroll via some other path (e.g.,
    // Phase 1 sync write expanded with retries, browser auto-restore, a
    // different observer-driven rewrite) could pass STEP 8 while the
    // rAF-poll machinery this PR adds silently broke. Asserting the mark
    // closes the gap between intent ("pin the rAF-poll path") and
    // enforcement, and additionally exercises the telemetry marks added
    // to ScrollPreservingContainer in the same change. If the production
    // mechanism legitimately changes, update this assertion to reference
    // the new mark — do not delete it.
    const phase2SuccessMarkCount = await page.evaluate(
      () => performance.getEntriesByName('ok/scroll-restore/phase2-success').length,
    );
    expect(
      phase2SuccessMarkCount,
      'ok/scroll-restore/phase2-success mark not emitted — rAF-poll did not execute the restore. STEP 8 may have passed via Phase 1 sync write or some other mechanism; this test is specifically scoped to the rAF-poll path.',
    ).toBeGreaterThan(0);
  });
});
