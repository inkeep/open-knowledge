import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

async function sourceFor(page: Page, docName: string): Promise<string> {
  return page.evaluate((name) => {
    const pool = (
      window as unknown as {
        __providerPool?: {
          entries?: {
            get?: (
              n: string,
            ) =>
              | { provider?: { document?: { getText: (s: string) => { toString(): string } } } }
              | undefined;
          };
        };
      }
    ).__providerPool;
    const viaPool = pool?.entries?.get?.(name)?.provider?.document?.getText('source')?.toString();
    if (viaPool) return viaPool;
    const active = (
      window as unknown as {
        __activeProvider?: { document?: { getText: (s: string) => { toString(): string } } };
      }
    ).__activeProvider;
    return active?.document?.getText('source')?.toString() ?? '';
  }, docName);
}

test('PRD-6955(b): remote fix to a hidden-but-mounted doc survives reveal + local touch', async ({
  page,
  api,
  baseURL,
}) => {
  const docA = `prd-6955b-a-${randomUUID().slice(0, 8)}`;
  const docB = `prd-6955b-b-${randomUUID().slice(0, 8)}`;
  const ORIG = '# Doc A\n\nstate one CORRUPT marker.\n\ntail para.\n';
  await api.seedDocs([
    { name: docA, markdown: ORIG },
    { name: docB, markdown: '# Doc B\n\nparking doc.\n' },
  ]);

  await page.goto(`/#/${docA}`);
  await waitForProvider(page);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').last()).toContainText(
    'state one CORRUPT marker.',
  );
  await page.goto(`/#/${docB}`);
  await waitForProvider(page);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').last()).toContainText(
    'parking doc.',
  );

  const res = await fetch(`${baseURL}/api/agent-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName: docA,
      find: 'state one CORRUPT marker.',
      replace: 'state two FIXED marker.',
    }),
  });
  expect(res.ok).toBe(true);

  await expect
    .poll(() => sourceFor(page, docA), { timeout: 10_000 })
    .toContain('state two FIXED marker.');

  await page.goto(`/#/${docA}`);
  await waitForProvider(page);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').last()).toContainText(
    'state two FIXED marker.',
  );
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').last();
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' touched', { delay: 15 });
  await expect
    .poll(() => sourceFor(page, docA), { timeout: 10_000 })
    .toContain('tail para. touched');

  const text = await sourceFor(page, docA);
  console.log('[6955b] final head:', JSON.stringify(text.slice(0, 120)));
  expect(text).toContain('state two FIXED marker.');
  expect(text).not.toContain('state one CORRUPT marker.');
});
