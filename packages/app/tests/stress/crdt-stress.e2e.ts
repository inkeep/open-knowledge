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
    // Inject large content via agent API. Default `position: append` (omitted)
    // so each turn stacks onto the previous — testing coexistence of agent
    // writes + accumulated user typing across turns.
    const writeRes = await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: FIXTURE }),
    });
    expect(writeRes.ok).toBe(true);

    // Wait for content to propagate to Y.Text
    await page.waitForFunction(
      (expected: number) =>
        window.__activeProvider?.document?.getText('source')?.toString()?.length >= expected,
      FIXTURE.length - 200, // tolerance for whitespace normalization
      { timeout: 30_000 },
    );

    // Simulate user typing (real keyboard events)
    await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
    await page.keyboard.type(marker, { delay: 5 });

    // Wait for Observer A to sync the user-typed marker into Y.Text('source').
    // Same Observer-A-mediated Y.Text convergence as the content-propagation wait
    // above, so it carries the same 30s budget. The marker round-trips client
    // keystroke → XmlFragment → server Observer A → Y.Text; across the 3 turns the
    // doc accumulates to ~3× the fixture, so by the later turns Observer A re-derives
    // Y.Text from a much larger fragment and that round-trip can exceed 10s under
    // workers=4 contention. The marker always lands (it is never dropped — the final
    // assertion below confirms all three survive), just slowly under accumulating
    // load, so a 10s budget cut a still-in-flight sync off mid-turn.
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
      `[Layer C] Turn complete: ytext=${turnState.ytextLen}, fragment=${turnState.fragChildren}`,
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
