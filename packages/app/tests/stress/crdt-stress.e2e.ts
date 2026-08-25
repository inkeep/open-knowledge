/**
 * Layer C: Playwright E2E at large-realistic scale.
 *
 * One test: S6 multi-turn — 3 turns of agent-write → user-typing coexistence.
 * Uses stock @playwright/test APIs with page.waitForFunction for deterministic
 * condition-based waits. No helper dependencies.
 *
 * Requires: Playwright browsers installed. Dev server started by playwright.config.ts
 * webServer on VITE_PORT (or default 5173).
 */

import { randomUUID } from 'node:crypto';
import { loadLargeRealistic } from '../../../core/src/markdown/fixtures/index.ts';
import { expect, filterCriticalErrors, test } from './_helpers';

const FIXTURE = loadLargeRealistic();

test('S6: multi-turn stress — large content + user edits', async ({ page, api, baseURL }) => {
  // 1. Capture console errors during the full flow
  //    capture message.location() URL + lineNumber so generic
  //    "Failed to load resource: 404" errors can be triaged by URL pattern,
  //    not just the opaque text body.
  const logs: Array<{ type: string; text: string; url?: string; line?: number }> = [];
  page.on('console', (m) => {
    const loc = m.location();
    logs.push({ type: m.type(), text: m.text(), url: loc.url, line: loc.lineNumber });
  });
  page.on('pageerror', (e) => logs.push({ type: 'uncaught', text: e.message }));

  // 2. Create a per-test doc + reset its server state (avoids racing with
  //    parallel tests that would otherwise share the global `test-doc` name).
  const docName = `test-crdtstress-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);

  // 3. Navigate directly to the per-test doc via hash routing.
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

  // 4. Three turns: agent-write → user-typing coexistence
  const markers = ['USER-E2E-MARK-1', 'USER-E2E-MARK-2', 'USER-E2E-MARK-3'];

  for (const marker of markers) {
    // Y.Text length BEFORE this turn's write. The propagation wait below is
    // RELATIVE to it because the writes append: each turn adds roughly another
    // fixture's worth of content, so an absolute `>= FIXTURE.length - 200`
    // threshold is already satisfied by the PREVIOUS turn's content and
    // returned without waiting at all on turns 2 and 3. Those turns never
    // verified their own append, and the test went on to type its marker into a
    // document with a full fixture still in flight. Waiting per-turn removes
    // that overlap. It does NOT on its own make the marker wait below reliable
    // — that still times out under load and is tracked separately — so read
    // this as closing a guard that was doing nothing, not as the flake's cure.
    // `grewFrom` in the turn log below records the baseline, so a run shows
    // directly whether each turn's guard had anything to wait for.
    // No `?? 0` fallback here: defaulting a missing provider to 0 would put the
    // threshold back at exactly the absolute `FIXTURE.length - 200` this guard
    // exists to replace, silently restoring the vacuous behaviour on a degraded
    // path. Fail loudly instead — the provider is already awaited above.
    const lengthBeforeWrite = await page.evaluate(() => {
      const len = window.__activeProvider?.document?.getText('source')?.toString()?.length;
      if (typeof len !== 'number') {
        throw new Error('no live provider Y.Text before the agent write');
      }
      return len;
    });

    // Inject large content via agent API. Default `position: append` (omitted)
    // so each turn stacks onto the previous — testing coexistence of agent
    // writes + accumulated user typing across turns.
    const writeRes = await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: FIXTURE }),
    });
    expect(writeRes.ok).toBe(true);

    // Wait for THIS turn's append to propagate to Y.Text.
    await page.waitForFunction(
      (expected: number) =>
        (window.__activeProvider?.document?.getText('source')?.toString()?.length ?? 0) >= expected,
      lengthBeforeWrite + FIXTURE.length - 200, // tolerance for whitespace normalization
      { timeout: 30_000 },
    );

    // Simulate user typing (real keyboard events)
    await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
    await page.keyboard.type(marker, { delay: 5 });

    // Wait for Observer A to sync the user-typed marker into Y.Text('source').
    // Same Observer-A-mediated Y.Text convergence as the content-propagation wait
    // above, so it carries the same 30s budget. The marker round-trips client
    // keystroke → XmlFragment → server Observer A → Y.Text against a document
    // that is ~3× the fixture by the last turn. How many server drains the 15
    // characters actually produce here is NOT measured — `delay: 5` makes one
    // drain per keystroke the plausible shape, but the numbers below come from
    // an offline probe that drove one character per transaction by
    // construction, so treat per-drain costs as a per-drain figure and not as a
    // count of this test's drains. The marker always lands (it is never dropped
    // — the final assertion below confirms all three survive), just slowly.
    //
    // The budget was raised 10s → 30s once, on the theory that it was merely
    // ungenerous. Do NOT raise it again: a third bump hides the mechanism, and the
    // mechanism has since been measured, so there is nothing left to guess at.
    //
    // What it is NOT. The long-standing suspicion was that the cost is Observer A
    // re-deriving Y.Text from the XmlFragment per keystroke, growing superlinearly
    // with the fragment. Both halves are wrong. Measured offline (no browser, no
    // dev server, no websocket) the bare re-derive — yXmlFragmentToProseMirrorRootNode
    // + serialize — is ~28ms at 231 KB / 1502 children, about 6.6% of the drain, so
    // even 15 drains of it is under half a second. And the drain scales LINEARLY,
    // not superlinearly: 135 / 280 / 424 ms at 1× / 2× / 3× the fixture.
    //
    // What it is. `computeMapDrivenBodySplice` (packages/server/src/map-driven-splice.ts)
    // is ~87% of the per-keystroke drain, doing full-document passes whose cost its
    // own docblock has flagged as unbounded by document size since long before
    // anyone measured it. One of its two parses is now memoized — a drain's
    // `oldBody` is the previous drain's `newBody` — removing ~46% of the function's
    // cost, pinned by parse-count tests in packages/server/src/map-driven-*.test.ts.
    // The surviving serialize + parse are still O(document) and still why this wait
    // needs a budget this large. See that docblock for what is left: the parse wants
    // an incremental parser, while the serialize duplicates one the caller already
    // did and is reducible under a condition spelled out there. Either way, not by
    // raising the number below.
    await page.waitForFunction(
      (m: string) => window.__activeProvider?.document?.getText('source')?.toString()?.includes(m),
      marker,
      { timeout: 30_000 },
    );

    // Diagnostic: capture turn state
    const turnState = await page.evaluate(() => {
      const provider = window.__activeProvider;
      const ytext = provider?.document?.getText('source');
      const frag = provider?.document?.getXmlFragment('default');
      return {
        ytextLen: ytext?.toString()?.length ?? 0,
        fragChildren: frag?.length ?? 0,
      };
    });
    console.log(
      `[Layer C] Turn complete: ytext=${turnState.ytextLen}, fragment=${turnState.fragChildren}, ` +
        `grewFrom=${lengthBeforeWrite}`,
    );
  }

  // 5. Final assertions.
  // `filterCriticalErrors` (from `_helpers/error-filters.ts`) strips known
  // dev-server noise — favicon/HMR/Vite chatter, WebSocket reconnect race
  // during /api/test-reset. The remaining entries are genuine failures.
  // See the helper module for the full predicate list + rationale.
  const errors = logs.filter((l) => l.type === 'error' || l.type === 'uncaught');
  const criticalErrors = filterCriticalErrors(errors);
  if (criticalErrors.length > 0) {
    // Include full URL + line info in the assertion failure so the flake is
    // diagnosable from CI logs alone.
    console.error('[Layer C] Critical errors detected:', JSON.stringify(criticalErrors, null, 2));
  }
  expect(criticalErrors).toEqual([]);

  const finalState = await page.evaluate(() => {
    const provider = window.__activeProvider;
    return {
      ytext: provider.document.getText('source').toString(),
    };
  });

  // All three user markers preserved
  for (const marker of markers) {
    expect(finalState.ytext).toContain(marker);
  }
});
