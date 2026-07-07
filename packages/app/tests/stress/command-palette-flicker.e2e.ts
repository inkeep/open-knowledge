/**
 * RED test for the Cmd+K command-palette per-keystroke flicker.
 *
 * Foundational contract:
 *   "Across a single keystroke, the visible search-result list should
 *    change at most once — from the previous-query result population
 *    directly to the new-query result population, with no observable
 *    intermediate population from a different data source."
 *
 * Bug: in `CommandPalette.tsx`, the search effect synchronously sets
 * `setSearchResults([])` on every fetch start, and the
 * `visibleSearchResults` derivation falls through to `fallbackSearchResults`
 * (a different search algorithm: title/path corpus only) when
 * `searchResults` is empty and status !== 'success'. The
 * combination causes the visible list to pass through THREE populations on
 * every keystroke after the first:
 *   1. previous query's API results
 *   2. fallback (title/path) results for the new query — different algo
 *   3. new query's API results
 *
 * This test seeds docs whose CONTENT matches the query but whose
 * titles/paths do NOT — so the fallback population is empty (different
 * from both API populations) and the three-state cycle is observable as a
 * distinct mid-keystroke empty/`Searching…` state.
 *
 * Test surface: Playwright DOM-mutation observer on `[data-slot="command-list"]`.
 * Records each distinct nav-row population observed during the typing burst
 * and a 500ms settle window. Asserts the count of distinct populations
 * across one keystroke is ≤ 2 (prev → new). The current code produces 3.
 */

import { expect, test } from './_helpers';

const SEED_DOCS = [
  // Filenames are deliberately short and contain neither 'q' nor 'qu' so
  // that the omnibar fallback (title/name/path corpus only) returns 0
  // matches for queries 'q' / 'qu'. The API path (full_text intent +
  // 'content' scope) finds them via the seed-content terms below.
  { name: 'aa', markdown: '# aa\n\nThe queue manager handles items.\n' },
  { name: 'bb', markdown: '# bb\n\nThe quartz crystal vibrates.\n' },
  { name: 'cc', markdown: '# cc\n\nThe quill writes elegantly.\n' },
  // dd matches 'q' (in `qantas`) but NOT 'qu' (no `qu` substring) — this
  // is the doc that DROPS from the result list between the 'q' and 'qu'
  // populations, so the two API populations are observably different.
  { name: 'dd', markdown: '# dd\n\nThe qantas airline flies.\n' },
];

test.describe('command-palette — per-keystroke render stability', () => {
  test('typing a multi-character query updates the visible list at most once per keystroke', async ({
    page,
    api,
  }) => {
    await api.seedDocs(SEED_DOCS);

    await page.goto('/');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    // Open the palette. `ControlOrMeta+k` selects Meta on darwin and Control
    // elsewhere — matches the in-app handler's `isMacOS() ? metaKey : ctrlKey`.
    await page.keyboard.press('ControlOrMeta+k');
    const list = page.locator('[data-slot="command-list"]');
    await expect(list).toBeVisible({ timeout: 5_000 });

    const input = page.locator('[data-slot="command-input"]');
    await expect(input).toBeFocused();

    // Type the first character. After this settles, `searchResults` holds
    // the API population for 'q' and `searchStatus` is 'success'. This is
    // the "stable prior state" the next keystroke transitions away from.
    await page.keyboard.type('q');

    // Wait for the API result to land — assert at least one nav row for 'q'
    // is present. The four seeded docs all have 'q' in content; expect ≥3.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.querySelectorAll(
                '[data-slot="command-list"] [data-testid^="command-palette-nav-"]',
              ).length,
          ),
        { timeout: 10_000, intervals: [50, 100, 200] },
      )
      .toBeGreaterThanOrEqual(3);

    // Install a sniffer that records every distinct nav-row population
    // observed during the upcoming keystroke. The signature is the joined
    // sequence of `data-testid` values, so re-renders that don't change
    // the row set (e.g. highlight-text spans inside a row) are ignored —
    // only the SET of result rows drives the snapshot.
    await page.evaluate(() => {
      const root = document.querySelector('[data-slot="command-list"]');
      if (!root) throw new Error('command-list not present at sniffer install');
      const snapshots: string[] = [];
      const snapshot = () => {
        const items = Array.from(root.querySelectorAll('[data-testid^="command-palette-nav-"]'));
        const sig = items.map((el) => el.getAttribute('data-testid') ?? '').join('|');
        const last = snapshots[snapshots.length - 1];
        if (last !== sig) snapshots.push(sig);
      };
      snapshot();
      const observer = new MutationObserver(snapshot);
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      window.__paletteSnapshots = snapshots;
      window.__paletteSnapshotsCleanup = () => observer.disconnect();
    });

    // ONE keystroke. Bug: the visible list cycles through 3 populations.
    await page.keyboard.type('u');

    // Wait for the API result for 'qu' to land. dd (qantas) drops; aa/bb/cc
    // remain. The post-'qu' population is non-empty, so length ≥ 1.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.querySelectorAll(
                '[data-slot="command-list"] [data-testid^="command-palette-nav-"]',
              ).length,
          ),
        { timeout: 10_000, intervals: [50, 100, 200] },
      )
      .toBeGreaterThanOrEqual(1);

    // Quiescence wait: resolve once the snapshot array stops growing for a
    // full poll interval. Catches late mutations from useDeferredValue /
    // React Compiler reactivity / late MutationObserver notifications, but
    // does NOT use a fixed timeout (banned by the STOP rule for *.e2e.ts).
    // MAX_TICKS bounds the loop at ~5s so a degenerate case (CSS animation
    // or render loop firing the observer indefinitely) fails fast with
    // diagnostic output instead of running until Playwright's 120s timeout.
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          let last = window.__paletteSnapshots?.length ?? 0;
          let stableTicks = 0;
          let totalTicks = 0;
          const POLL_MS = 100;
          const REQUIRED_STABLE_TICKS = 5;
          const MAX_TICKS = 50;
          const tick = () => {
            totalTicks += 1;
            if (totalTicks > MAX_TICKS) {
              reject(
                new Error(
                  `quiescence wait exceeded MAX_TICKS=${MAX_TICKS} ` +
                    `(${MAX_TICKS * POLL_MS}ms): snapshots kept growing — ` +
                    `final snapshot count = ${window.__paletteSnapshots?.length ?? 0}`,
                ),
              );
              return;
            }
            const now = window.__paletteSnapshots?.length ?? 0;
            if (now === last) {
              stableTicks += 1;
              if (stableTicks >= REQUIRED_STABLE_TICKS) {
                resolve();
                return;
              }
            } else {
              stableTicks = 0;
              last = now;
            }
            setTimeout(tick, POLL_MS);
          };
          setTimeout(tick, POLL_MS);
        }),
    );

    await page.evaluate(() => window.__paletteSnapshotsCleanup?.());
    const snapshots = await page.evaluate(() => window.__paletteSnapshots ?? []);

    // Diagnostic visibility — show the distinct populations in CI logs so a
    // future investigator can see the prev → fallback → new sequence.
    console.log('[command-palette-flicker] populations seen during keystroke:', snapshots);

    // Foundational contract: across one keystroke, the visible result list
    // should change AT MOST once. The snapshot array starts pre-keystroke
    // and only appends when the population changes, so:
    //   length 1 → no change (degenerate, query produced same set)
    //   length 2 → exactly one transition (prev API → new API) — the FIX
    //   length 3 → bug (prev API → fallback for 'qu' → new API)
    expect(snapshots.length).toBeLessThanOrEqual(2);
  });
});

declare global {
  interface Window {
    __paletteSnapshots?: string[];
    __paletteSnapshotsCleanup?: () => void;
  }
}
