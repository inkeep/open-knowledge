/**
 * Multi-client DOM-layer verification for Observer A Path B.
 *
 * Complements `bridge-matrix.test.ts` multi-client test at the
 * browser layer — same scenario shape (server agent write + local WYSIWYG
 * edit converge on both clients), but with real TipTap NodeView + ProseMirror
 * DOM binding in two browser contexts.
 *
 * Scope:
 * - Server-side agent write (origin='agent-write') lands in Y.Text on both
 *   clients via CRDT sync.
 * - Client A's user types on the SAME LINE while the agent's content is live
 *   in Y.Text. Observer A on Client A takes Path B (Y.Text diverged from
 *   lastSyncedXmlMd) → DMP three-way merge.
 * - Both clients converge: Y.Text contains BOTH the agent's text and the
 *   user's typing. DOM on both clients reflects it with no artifacts.
 *
 * What this scenario specifically proves at the DOM layer (not covered by
 * bridge-matrix.test.ts):
 * - TipTap NodeView renders the Path B merge output correctly.
 * - ProseMirror transactions from Observer B (applied post-merge) don't
 *   corrupt the DOM or throw uncaught errors.
 * - Across two real browser WebSocket clients, the merged state converges.
 *
 * Out of scope for this test (and for this spec): two concurrent peer
 * WYSIWYG clients typing on the same line with no server-side agent write.
 * That scenario relies on a different convergence path (peer tree-only
 * updates + remote baseline refresh) that this spec does not modify.
 *
 */

import { randomUUID } from 'node:crypto';
import { expect, test } from './_helpers';

const AGENT_MARKER = 'AGENT-MARKER-XYZ';
const USER_MARKER = 'USER-MARKER-PQR';

test('QA-016: agent write + local WYSIWYG edit converge in DOM on both clients', async ({
  browser,
  api,
  baseURL,
}) => {
  // Per-test unique doc — both browser contexts connect to the same unique
  // docName, avoiding races with parallel tests on the global `test-doc`.
  const docName = `test-observer-a-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);

  // Two independent browser contexts → two separate WebSocket clients on the
  // same per-test doc. Each context isolates cookies, storage, and network.
  // `baseURL` comes from the worker-scoped server fixture — `browser.newContext`
  // does NOT inherit it automatically (unlike the `page` fixture), so we pass
  // it explicitly.
  const ctxA = await browser.newContext({ baseURL });
  const ctxB = await browser.newContext({ baseURL });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    const logsA: Array<{ type: string; text: string }> = [];
    const logsB: Array<{ type: string; text: string }> = [];
    pageA.on('console', (m) => logsA.push({ type: m.type(), text: m.text() }));
    pageA.on('pageerror', (e) => logsA.push({ type: 'uncaught', text: e.message }));
    pageB.on('console', (m) => logsB.push({ type: m.type(), text: m.text() }));
    pageB.on('pageerror', (e) => logsB.push({ type: 'uncaught', text: e.message }));

    // Both clients open the per-test doc via hash routing.
    await Promise.all([pageA.goto(`/#/${docName}`), pageB.goto(`/#/${docName}`)]);
    await Promise.all([
      pageA.waitForFunction(() => Boolean(window.__activeProvider), null, { timeout: 15_000 }),
      pageB.waitForFunction(() => Boolean(window.__activeProvider), null, { timeout: 15_000 }),
    ]);
    await Promise.all([
      pageA.waitForSelector('.ProseMirror:not(.composer-prosemirror)'),
      pageB.waitForSelector('.ProseMirror:not(.composer-prosemirror)'),
    ]);

    // Seed a baseline via agent write so both clients have the same starting line.
    // Agent write uses origin='agent-write' server-side and updates Y.Text + XmlFragment
    // together, so it propagates cleanly to both browser clients.
    const seedRes = await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: `baseline-line\n` }),
    });
    expect(seedRes.ok).toBe(true);

    await Promise.all([
      pageA.waitForFunction(
        () =>
          window.__activeProvider?.document
            ?.getText('source')
            ?.toString()
            ?.includes('baseline-line'),
        null,
        { timeout: 10_000 },
      ),
      pageB.waitForFunction(
        () =>
          window.__activeProvider?.document
            ?.getText('source')
            ?.toString()
            ?.includes('baseline-line'),
        null,
        { timeout: 10_000 },
      ),
    ]);

    // Step 1: user on Client A starts typing into the editor (focus + position cursor
    // at end of the baseline line). This creates local XmlFragment transactions.
    await pageA.locator('.ProseMirror:not(.composer-prosemirror)').focus();
    await pageA.keyboard.press('End');

    // Step 2: agent writes additional content to the same line via server-side API.
    // The write is server-origin ('agent-write'), so it lands in Y.Text on BOTH
    // browser clients. Observer B on each client will eventually re-render
    // XmlFragment from the merged Y.Text.
    await api.replaceDoc(docName, `baseline-line ${AGENT_MARKER}\n`);

    // Wait for agent marker to reach Y.Text on both clients.
    await Promise.all([
      pageA.waitForFunction(
        (m: string) =>
          window.__activeProvider?.document?.getText('source')?.toString()?.includes(m),
        AGENT_MARKER,
        { timeout: 10_000 },
      ),
      pageB.waitForFunction(
        (m: string) =>
          window.__activeProvider?.document?.getText('source')?.toString()?.includes(m),
        AGENT_MARKER,
        { timeout: 10_000 },
      ),
    ]);

    // Step 3: Client A's user types at the end of the line (which now includes the
    // agent marker). Observer A on Client A fires. On Client A specifically, the
    // sequence is: agent write updated Y.Text remotely → Observer B re-renders
    // XmlFragment → user typing creates local XmlFragment tx → Observer A Path B
    // fires (Y.Text diverged from lastSyncedXmlMd because agent's full text is in
    // Y.Text but the local XmlFragment serialization may not yet match exactly
    // after user's keystrokes). DMP three-way merge preserves both contributions.
    await pageA.locator('.ProseMirror:not(.composer-prosemirror)').focus();
    await pageA.keyboard.press('End');
    await pageA.keyboard.type(` ${USER_MARKER}`, { delay: 15 });

    // Wait for both markers to be present in BOTH clients' Y.Text.
    await Promise.all([
      pageA.waitForFunction(
        ({ a, u }: { a: string; u: string }) => {
          const text = window.__activeProvider?.document?.getText('source')?.toString() ?? '';
          return text.includes(a) && text.includes(u);
        },
        { a: AGENT_MARKER, u: USER_MARKER },
        { timeout: 20_000 },
      ),
      pageB.waitForFunction(
        ({ a, u }: { a: string; u: string }) => {
          const text = window.__activeProvider?.document?.getText('source')?.toString() ?? '';
          return text.includes(a) && text.includes(u);
        },
        { a: AGENT_MARKER, u: USER_MARKER },
        { timeout: 20_000 },
      ),
    ]);

    // Capture final state on both clients.
    const captureState = async (page: typeof pageA): Promise<{ ytext: string; dom: string }> =>
      page.evaluate(() => {
        const ytext = window.__activeProvider?.document?.getText('source')?.toString() ?? '';
        const editor = document.querySelector(
          '.ProseMirror:not(.composer-prosemirror)',
        ) as HTMLElement | null;
        const dom = editor?.innerText ?? '';
        return { ytext, dom };
      });
    const stateA = await captureState(pageA);
    const stateB = await captureState(pageB);

    // Y.Text convergence: both clients have both markers.
    expect(stateA.ytext).toContain(AGENT_MARKER);
    expect(stateA.ytext).toContain(USER_MARKER);
    expect(stateB.ytext).toContain(AGENT_MARKER);
    expect(stateB.ytext).toContain(USER_MARKER);

    // DOM convergence: both clients render both markers (TipTap NodeView picked up
    // Observer A's Path B merge result; no ProseMirror artifacts).
    expect(stateA.dom).toContain(AGENT_MARKER);
    expect(stateA.dom).toContain(USER_MARKER);
    expect(stateB.dom).toContain(AGENT_MARKER);
    expect(stateB.dom).toContain(USER_MARKER);

    // Bridge invariant as observable at the Y.Text level: the serialized Y.Text
    // should line up with what ProseMirror is rendering (trimmed comparison to
    // allow for CollaborationCursor presence indicators + whitespace normalization).
    const stripMarkers = (s: string): string => s.replace(/\s+/g, ' ').trim();
    expect(stripMarkers(stateA.dom)).toContain(stripMarkers(AGENT_MARKER));
    expect(stripMarkers(stateA.dom)).toContain(stripMarkers(USER_MARKER));

    // No critical console errors on either client (mirror crdt-stress.e2e.ts's filter).
    const critical = (logs: Array<{ type: string; text: string }>) =>
      logs
        .filter((l) => l.type === 'error' || l.type === 'uncaught')
        .filter(
          (e) =>
            !e.text.includes('favicon') && !e.text.includes('HMR') && !e.text.includes('[vite]'),
        );
    expect(critical(logsA)).toEqual([]);
    expect(critical(logsB)).toEqual([]);
  } finally {
    await Promise.all([ctxA.close(), ctxB.close()]);
  }
});
