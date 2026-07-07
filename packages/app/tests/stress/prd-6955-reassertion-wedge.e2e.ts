/**
 * WEDGE fault-injection — full repro attempt of the stale-replica
 * wholesale re-assertion. Mechanism under test: if the y-prosemirror binding's
 * Y→PM half stops applying (wedge) while PM→Y stays live, the next local PM
 * transaction makes the binding diff stale-PM vs updated-fragment and emit ops
 * that RESURRECT the stale content over a newer remote fix.
 *
 * Fault injection: wrap view.dispatch to DROP transactions carrying y-sync
 * plugin metadata (the remote-update apply path) — PM freezes at V1 while the
 * Y doc receives the V2 fix. Then type one char. RED = V1 text resurrected.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

async function sourceText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = (
      window as unknown as {
        __activeProvider?: { document?: { getText: (s: string) => { toString(): string } } };
      }
    ).__activeProvider;
    return active?.document?.getText('source')?.toString() ?? '';
  });
}

test('PRD-6955(b) wedge: Y→PM apply dropped + local touch → does stale PM resurrect over the fix?', async ({
  page,
  api,
  baseURL,
}) => {
  const docName = `prd-6955-wedge-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([
    { name: docName, markdown: '# Wedge probe\n\nstate one STALE marker.\n\ntail para.\n' },
  ]);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  // Event-driven settle (e2e STOP rule bans waitForTimeout): the binding must
  // have rendered V1 into the visible PM doc — and the editor must be
  // registered as active — before the dispatch patch lands.
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').last()).toContainText(
    'state one STALE marker.',
  );
  await expect
    .poll(
      () =>
        page.evaluate(() => !!(window as unknown as { __activeEditor?: unknown }).__activeEditor),
      { timeout: 10_000 },
    )
    .toBe(true);

  // sanity: V1 in Y.Text
  expect(await sourceText(page)).toContain('state one STALE marker.');

  // FAULT INJECTION: drop y-sync-tagged transactions at the active editor's dispatch
  const patched = await page.evaluate(() => {
    const active = (
      window as unknown as { __activeEditor?: { view?: { dispatch: (tr: unknown) => void } } }
    ).__activeEditor;
    const view = active?.view;
    if (!view) return 'no-active-editor';
    const orig = view.dispatch.bind(view);
    (view as { dispatch: (tr: unknown) => void }).dispatch = (tr: unknown) => {
      const t = tr as { meta?: Record<string, unknown> };
      const meta = (t as { meta?: Record<string, unknown> }).meta ?? {};
      const keys = Object.keys(meta);
      if (keys.some((k) => k.includes('y-sync'))) {
        (window as unknown as { __droppedYSync: number }).__droppedYSync =
          ((window as unknown as { __droppedYSync?: number }).__droppedYSync ?? 0) + 1;
        return; // WEDGE: remote Y→PM application silently dropped
      }
      orig(tr as never);
    };
    return 'patched';
  });
  console.log('[wedge] dispatch patch:', patched);
  expect(patched).toBe('patched');

  // remote fix lands while the binding is wedged
  const res = await fetch(`${baseURL}/api/agent-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName,
      find: 'state one STALE marker.',
      replace: 'state two FIXED marker.',
    }),
  });
  expect(res.ok).toBe(true);

  // Mid-state gate: the fix MUST be present in the client Y.Text before the local
  // touch — so a final-assertion failure can only mean resurrection, never an
  // agent-patch that silently failed to land.
  await expect
    .poll(() => sourceText(page), { timeout: 10_000 })
    .toContain('state two FIXED marker.');

  const dropped = await page.evaluate(
    () => (window as unknown as { __droppedYSync?: number }).__droppedYSync ?? 0,
  );
  console.log('[wedge] after fix: Y.Text has FIXED | dropped y-sync trs:', dropped);
  // Injection-validity gate: the wedge must have actually swallowed the remote
  // apply. If the y-sync meta key ever stops matching, this fails loudly instead
  // of letting the test pass as a vacuous healthy-path duplicate.
  expect(dropped).toBeGreaterThan(0);

  // the local touch: one real keystroke through the wedged editor
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').last();
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' X', { delay: 20 });
  // Event-driven settle: under the staleness guard's recycle recovery the
  // keystroke lands in the recycled (healthy) editor and completes the
  // PM→Y→server-observer→Y.Text pipeline; poll for that completion signal
  // instead of a fixed sleep.
  await expect.poll(() => sourceText(page), { timeout: 10_000 }).toContain('tail para. X');

  const finalY = await sourceText(page);
  console.log('[wedge] FINAL Y.Text head:', JSON.stringify(finalY.slice(0, 140)));
  console.log(
    '[wedge] resurrection?',
    finalY.includes('state one STALE marker.'),
    '| fix survived?',
    finalY.includes('state two FIXED marker.'),
  );

  // RED-direction: the fix must survive a wedged binding's local touch
  expect(finalY).toContain('state two FIXED marker.');
  expect(finalY).not.toContain('state one STALE marker.');
});
