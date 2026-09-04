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

  expect(await sourceText(page)).toContain('state one STALE marker.');

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
        return;
      }
      orig(tr as never);
    };
    return 'patched';
  });
  console.log('[wedge] dispatch patch:', patched);
  expect(patched).toBe('patched');

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

  await expect
    .poll(() => sourceText(page), { timeout: 10_000 })
    .toContain('state two FIXED marker.');

  const dropped = await page.evaluate(
    () => (window as unknown as { __droppedYSync?: number }).__droppedYSync ?? 0,
  );
  console.log('[wedge] after fix: Y.Text has FIXED | dropped y-sync trs:', dropped);
  expect(dropped).toBeGreaterThan(0);

  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').last();
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' X', { delay: 20 });
  await expect.poll(() => sourceText(page), { timeout: 10_000 }).toContain('tail para. X');

  const finalY = await sourceText(page);
  console.log('[wedge] FINAL Y.Text head:', JSON.stringify(finalY.slice(0, 140)));
  console.log(
    '[wedge] resurrection?',
    finalY.includes('state one STALE marker.'),
    '| fix survived?',
    finalY.includes('state two FIXED marker.'),
  );

  expect(finalY).toContain('state two FIXED marker.');
  expect(finalY).not.toContain('state one STALE marker.');
});
