import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });
const INDENTED_STEP = /\n[ \t]+<\/?Step\b/;

const STEPS = [
  '<Steps>',
  '',
  '<Step>',
  '',
  'Content one.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'Content two.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'Content three.',
  '',
  '</Step>',
  '',
  '</Steps>',
  '',
].join('\n');

const readSource = (page: Page) =>
  page.evaluate(() => window.__activeProvider?.document?.getText('source')?.toString() ?? '');

async function settleSource(page: Page, mustInclude: string) {
  await page.evaluate(
    (needle) =>
      new Promise<void>((resolve, reject) => {
        let last = -1;
        let stableTicks = 0;
        let totalTicks = 0;
        const POLL_MS = 100;
        const REQUIRED_STABLE_TICKS = 3;
        const MAX_TICKS = 100;
        const tick = () => {
          totalTicks += 1;
          if (totalTicks > MAX_TICKS) {
            reject(
              new Error(
                `settleSource: "${needle}" did not land + settle within ${MAX_TICKS * POLL_MS}ms`,
              ),
            );
            return;
          }
          const s = window.__activeProvider?.document?.getText('source')?.toString() ?? '';
          if (s.includes(needle) && s.length === last) {
            stableTicks += 1;
            if (stableTicks >= REQUIRED_STABLE_TICKS) {
              resolve();
              return;
            }
          } else {
            stableTicks = 0;
            last = s.length;
          }
          setTimeout(tick, POLL_MS);
        };
        setTimeout(tick, POLL_MS);
      }),
    mustInclude,
  );
}

let docName: string;
test.beforeEach(async ({ page, api }) => {
  docName = `qa-livetype-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror');
  await api.replaceDoc(docName, STEPS);
  await page.waitForFunction(
    () => document.querySelector('.ProseMirror')?.textContent?.includes('Content one'),
    null,
    { timeout: 10_000 },
  );
});

test.describe('QA canary — live per-keystroke typing on <Steps> (browser, source mode)', () => {
  test('typing a burst into a Step body lands contiguous, no re-indent, no growth', async ({
    page,
  }) => {
    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content');
    await page
      .locator('.cm-content:visible')
      .getByText('Content one.', { exact: false })
      .first()
      .click();
    await page.keyboard.press('End');
    await page.keyboard.type('ZZZZZ', { delay: 45 });
    await settleSource(page, 'ZZZZZ');

    const src = await readSource(page);
    expect(src).toContain('Content one.ZZZZZ');
    expect(src).not.toMatch(INDENTED_STEP);
    expect((src.match(/<Step>/g) ?? []).length).toBe(3);
    expect((src.match(/<Steps>/g) ?? []).length).toBe(1);
    expect(src.length).toBeLessThan(STEPS.length + 32);
  });

  test('typing a burst at a Step body-start boundary lands contiguous, tags intact', async ({
    page,
  }) => {
    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content');
    await page
      .locator('.cm-content:visible')
      .getByText('Content two.', { exact: false })
      .first()
      .click();
    await page.keyboard.press('Home');
    await page.keyboard.type('QQQQQ', { delay: 45 });
    await settleSource(page, 'QQQQQ');

    const src = await readSource(page);
    expect(src).toContain('QQQQQContent two.');
    expect(src).not.toMatch(INDENTED_STEP);
    expect((src.match(/<Step>/g) ?? []).length).toBe(3);
    expect(src.length).toBeLessThan(STEPS.length + 32);
  });

  test('in-browser reopen after a live edit preserves bytes, no corruption', async ({
    page,
    api,
  }) => {
    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content');
    await page
      .locator('.cm-content:visible')
      .getByText('Content three.', { exact: false })
      .first()
      .click();
    await page.keyboard.press('End');
    await page.keyboard.type('RRRRR', { delay: 45 });
    await settleSource(page, 'RRRRR');

    const other = `qa-other-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${other}.md`);
    await page.goto(`/#/${other}`);
    await waitForProvider(page);
    await page.waitForSelector('.cm-content');
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForFunction(
      () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('RRRRR'),
      null,
      { timeout: 10_000 },
    );

    const src = await readSource(page);
    expect(src).toContain('Content three.RRRRR');
    expect(src).not.toMatch(INDENTED_STEP);
    expect((src.match(/<Step>/g) ?? []).length).toBe(3);
    expect(src.length).toBeLessThan(STEPS.length + 32);
  });
});
