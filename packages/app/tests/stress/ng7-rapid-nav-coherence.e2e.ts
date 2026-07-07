/**
 * Pattern D — rapid-nav coherence E2E.
 *
 * The filename intentionally says "coherence" rather than "cancellation":
 * this test pins the user-visible END STATE under rapid nav, not the
 * AbortController-cancellation path specifically. The cancellation path
 * (case (b) below) is unit-tested at `editor-cache.test.ts`
 * (park-uncached invalidates mount-promise) and `mount-promise.test.ts`
 * (`MountAbortError` rejection on invalidate-during-yield-window). Adding
 * an e2e variant that forces case (b) deterministically would require
 * timing manipulation that's hard to keep stable across CI workers; we
 * deliberately accept the trade-off and have the file's name describe
 * what it actually pins.
 *
 * Composition boundary covered: EditorActivityPool → Suspense → TiptapEditor
 * → use(mountTiptapEditorPromise) → V2 cache → DocumentBoundary. The
 * unit-tier evict-during-yield-window test already pins the cancellation
 * contract at the editor-cache.ts ↔ mount-promise.ts boundary; this E2E
 * proves the Pattern D pipeline stays coherent end-to-end when a real user
 * rapid-navs through the sidebar before a mount-promise has settled.
 *
 * Two outcomes are valid for the same user gesture:
 *   (a) A's mount-promise resolves in the background before B's click
 *       processes — A lands in V2 cache as a phantom entry, B mounts
 *       afterwards. No cancellation fires.
 *   (b) B's click unmounts A's TiptapEditor subtree while A's use(...) is
 *       still pending — `parkTiptapEditor` invalidates A's mount-promise
 *       only when V2 refuses admission (size gate); under V2-admit the
 *       mount-promise stays cached and the in-flight body completes
 *       harmlessly into the V2 entry. B mounts cleanly either way.
 *
 * The test asserts the END STATE under either timing — B is the active
 * doc, no critical console errors, no detached-DOM leak — which is the
 * user-visible contract regardless of which branch fires.
 *
 * STOP rule reminder: per-test isolated docNames via randomUUID.
 * The pattern matches `crdt-stress.e2e.ts` so workers running in parallel
 * can't share docNames and corrupt each other's CRDT state.
 */

import { randomUUID } from 'node:crypto';
import { expect, filterCriticalErrors, type LogEntry, test } from './_helpers';

test.describe('NG7 Pattern D — rapid-nav coherence', () => {
  test('rapid A→B nav does not leak DOM, error, or stall', async ({ page, api }) => {
    // Per-test isolated docNames (STOP rule on Playwright tests).
    // Two docs of equal size — a body large enough to make the cold-mount
    // work observable but small enough to fit comfortably in the V2 cache
    // bytes-gate. Keeping them equal-sized prevents either doc from being
    // differentially admitted/refused by the size gate.
    const docA = `ng7-rapidnav-a-${randomUUID().slice(0, 8)}`;
    const docB = `ng7-rapidnav-b-${randomUUID().slice(0, 8)}`;
    const filler = 'Filler paragraph for cold-mount observability. '.repeat(20);
    const bodyA = `# ${docA}\n\nUnique-A-marker-${docA}\n\n${filler}`;
    const bodyB = `# ${docB}\n\nUnique-B-marker-${docB}\n\n${filler}`;
    await api.seedDocs([
      { name: docA, markdown: bodyA },
      { name: docB, markdown: bodyB },
    ]);

    // Capture page + console errors across the full flow. Pattern matches
    //    crdt-stress.e2e.ts so the trailing filterCriticalErrors call strips
    //    benign dev-server noise (HMR, /collab WebSocket reconnect race) and
    //    surfaces only genuine failures — including unhandled-rejection
    //    warnings from a leaked mount-promise rejection.
    const logs: LogEntry[] = [];
    page.on('console', (m) => {
      const loc = m.location();
      logs.push({ type: m.type(), text: m.text(), url: loc.url, line: loc.lineNumber });
    });
    page.on('pageerror', (e) => logs.push({ type: 'uncaught', text: e.message }));

    await page.goto('/');

    // Rapid nav: click A then click B with NO awaits between. Playwright
    //    dispatches both clicks via raw input events; the construction-mount
    //    yield in mount-promise is `await scheduler.yield()` — native
    //    task-level boundary on Chromium / Electron and polyfilled on
    //    Safari / Firefox via MessageChannel → requestIdleCallback →
    //    setTimeout. Either way the second click can land before A's
    //    mount-promise resolves. Both timing branches converge on the same
    //    end state — that's exactly what we're asserting.
    const aRow = page.getByRole('treeitem', { name: `${docA}.md`, exact: true });
    const bRow = page.getByRole('treeitem', { name: `${docB}.md`, exact: true });
    // Both rows must be rendered BEFORE the rapid click pair starts — the
    // visibility wait belongs here, not between the clicks (the
    // back-to-back A→B gesture is the behavior under test). The sidebar's
    // first render can exceed the clicks' 10s actionability budgets under
    // 4-worker CI contention.
    await expect(aRow).toBeVisible({ timeout: 30_000 });
    await expect(bRow).toBeVisible({ timeout: 30_000 });
    // Capture a navigation-start timestamp BEFORE either click lands so the
    // settle-mark assertion below can filter to marks emitted during this
    // gesture only. `performance.getEntriesByType('measure')` returns ALL
    // measures across the page session — without this filter, a stale
    // `ok/cache/hit` mark for docA from earlier in the session could satisfy
    // the "A's mount-promise settled" assertion even when the current
    // gesture's mount-promise body silently never settled (the no-catch
    // bug class the test exists to catch).
    const navStartTime = await page.evaluate(() => performance.now());
    await aRow.click({ timeout: 10_000 });
    await bRow.click({ timeout: 10_000 });

    // End state: B is the active provider, B's content is visible.
    //    waitForActiveProviderSynced only checks `isSynced` on whatever is
    //    currently active — if A latched first and B's nav lost the race,
    //    that helper would return on A. Use waitForFunction to pin the
    //    docName explicitly so we surface the real end state.
    await page.waitForFunction(
      (target: string) =>
        Boolean(window.__activeProvider?.isSynced) &&
        window.__activeProvider?.configuration?.name === target,
      docB,
      { timeout: 30_000 },
    );
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', {
        hasText: `Unique-B-marker-${docB}`,
      }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // DOM-leak ceiling check. EditorActivityPool mounts up to
    //    ACTIVITY_MOUNT_LIMIT (= 3) editors concurrently — under React 19's
    //    `<Activity mode="hidden">` the parked subtree stays in the DOM (the
    //    primitive's whole point) but pauses effects. Playwright's `:visible`
    //    matches both active + parked ProseMirror DOM. The leak signal is
    //    when the total ProseMirror count EXCEEDS the activity-mount limit:
    //    a phantom mount-promise resolution that double-mounted the same
    //    doc, or a stranded TiptapEditor subtree from cleanup that didn't
    //    unmount under rapid-nav, would push count to 4+ here.
    const totalPmCount = await page.locator('.ProseMirror:not(.composer-prosemirror)').count();
    expect(totalPmCount).toBeLessThanOrEqual(3);
    expect(totalPmCount).toBeGreaterThanOrEqual(1);

    // Mount-promise lifecycle outcome — pin one of the three valid
    //     timing branches actually fired. `mark()` calls `performance.measure`,
    //     so every settle path emits a measure entry: `ok/mount/resolve`
    //     (case (a) — A's body completed before park ran), `ok/mount/reject`
    //     with `reason='aborted'` (case (b) — park-during-yield aborted A),
    //     or the V2-HIT short-circuit (case (c) — A was already a V2 hit;
    //     detected via the cache-layer `ok/cache/hit` mark from
    //     `editor-cache.ts`, since the mount-substrate no longer emits a
    //     redundant cache-hit mark — see mount-promise.ts V2-HIT branch +
    //     cross-namespace mountId correlation).
    //     Without this assertion, a regression that broke the mount-promise
    //     body entirely (e.g., the `void runMountBody(...)` no-catch bug —
    //     the body throws, consumer hangs, but Suspense fallback masks the
    //     hang until the test timeout) could pass: the editor for B might
    //     still mount via a cache-hit on its own row, leaving A's lifecycle
    //     never emitting any settle mark. Asserting at least one A-lifecycle
    //     mark fired pins the wiring end-to-end.
    // A's settle mark can land hundreds of ms AFTER B's end state under
    // load (timing case (a): A's mount body completes after park ran). A
    // bare one-shot read here raced that late settle and a mid-read
    // navigation destroyed the evaluate context — waitForFunction
    // re-evaluates across both.
    await page.waitForFunction(
      ({ targetDoc, since }) => {
        const isMountSettle = (entry: PerformanceEntry) =>
          entry.name === 'ok/mount/resolve' ||
          entry.name === 'ok/mount/reject' ||
          entry.name === 'ok/cache/hit';
        return performance
          .getEntriesByType('measure')
          .filter(isMountSettle)
          .filter((m) => m.startTime >= since)
          .some((m) => {
            const detail = (m as unknown as { detail?: { devtools?: { properties?: unknown } } })
              .detail;
            const props = (detail?.devtools?.properties ?? []) as Array<[string, string]>;
            return props.find(([k]) => k === 'docName')?.[1] === targetDoc;
          });
      },
      { targetDoc: docA, since: navStartTime },
      { timeout: 30_000 },
    );
    const aSettleMarks = await page.evaluate(
      ({ targetDoc, since }) => {
        const isMountSettle = (entry: PerformanceEntry) =>
          entry.name === 'ok/mount/resolve' ||
          entry.name === 'ok/mount/reject' ||
          entry.name === 'ok/cache/hit';
        return (
          performance
            .getEntriesByType('measure')
            .filter(isMountSettle)
            // Restrict to marks emitted during the current rapid-nav gesture
            // (after navStartTime). Stale marks from prior navigation cycles
            // — still resident in the performance buffer — must not satisfy
            // this assertion.
            .filter((m) => m.startTime >= since)
            .map((m) => {
              // detail.devtools.properties is `Array<[string, string]>`.
              const detail = (m as unknown as { detail?: { devtools?: { properties?: unknown } } })
                .detail;
              const props = (detail?.devtools?.properties ?? []) as Array<[string, string]>;
              const docName = props.find(([k]) => k === 'docName')?.[1];
              const reason = props.find(([k]) => k === 'reason')?.[1];
              return { name: m.name, docName, reason };
            })
            .filter((m) => m.docName === targetDoc)
        );
      },
      { targetDoc: docA, since: navStartTime },
    );
    // A's mount-promise must have emitted at least one settle mark — the
    // exact one depends on which timing branch fired. Empty means the
    // body silently never settled (the no-catch bug class) or the doc
    // was never opened via the Pattern D path.
    expect(aSettleMarks.length).toBeGreaterThanOrEqual(1);
    // Each settle mark must be one of the three documented outcomes —
    // surface unexpected `reason` values (e.g. 'unhandled-body-throw',
    // 'mount-failed', 'construct-failed') as test failures so a regression
    // in any mount-promise lifecycle path can't slip through under the
    // permissive end-state assertion.
    const validReasons = new Set([undefined, 'aborted']);
    for (const m of aSettleMarks) {
      const isValid =
        m.name === 'ok/mount/resolve' ||
        m.name === 'ok/cache/hit' ||
        (m.name === 'ok/mount/reject' && validReasons.has(m.reason));
      expect(isValid, `unexpected mount-promise settle for ${docA}: ${JSON.stringify(m)}`).toBe(
        true,
      );
    }

    // No critical errors. filterCriticalErrors strips benign HMR / Vite /
    //    /collab WebSocket reconnect race noise. Anything left would be a
    //    real Pattern D failure — uncaught error from the mount-promise
    //    body, unhandled rejection from a leaked AbortError, or a React
    //    Suspense fallback throw escaping the boundary.
    const errors = logs.filter((l) => l.type === 'error' || l.type === 'uncaught');
    const criticalErrors = filterCriticalErrors(errors);
    if (criticalErrors.length > 0) {
      console.error('[NG7 rapid-nav] critical errors:', JSON.stringify(criticalErrors, null, 2));
    }
    expect(criticalErrors).toEqual([]);
  });
});
