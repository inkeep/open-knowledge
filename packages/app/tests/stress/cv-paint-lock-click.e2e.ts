import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import { expect, test } from './_helpers';

const DOC_MARKDOWN = [
  '# Survival doc',
  '',
  'First paragraph with enough text to give the click a stable target.',
  '',
  'Second paragraph so the doc has several top-level blocks.',
].join('\n');

async function setupDoc(page: Page, api: ApiHelpers): Promise<string> {
  const docName = `test-cvlock-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, DOC_MARKDOWN);
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror) p');
  return docName;
}

type ClickOutcome = 'alive' | 'renderer-crashed';

async function clickFirstParagraphAndProbe(page: Page): Promise<ClickOutcome> {
  const crashed = new Promise<ClickOutcome>((resolve) => {
    page.once('crash', () => resolve('renderer-crashed'));
  });
  const target = page.locator('.ProseMirror:not(.composer-prosemirror) p').first();
  const box = await target.boundingBox();
  if (!box) throw new Error('editor paragraph has no bounding box');
  const x = box.x + Math.min(24, box.width / 2);
  const y = box.y + box.height / 2;
  const clickAndProbe = (async (): Promise<ClickOutcome> => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();
    await page.evaluate(() => document.readyState);
    return 'alive';
  })().catch((): ClickOutcome => 'renderer-crashed');
  return await Promise.race([crashed, clickAndProbe]);
}

test('click into the editor survives the inactive-pane paint lock (.ok-mode-hidden) landing mid-dispatch', async ({
  page,
  api,
}) => {
  await setupDoc(page, api);

  await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
    const pane = pm
      ?.closest('div.relative.flex-1')
      ?.querySelector(':scope > div.h-full:not(.ok-mode-hidden)');
    if (!(pane instanceof HTMLElement)) throw new Error('visual editor pane not found');
    window.addEventListener(
      'mousedown',
      () => {
        pane.classList.add('ok-mode-hidden');
        void pane.offsetHeight;
      },
      { capture: true, once: true },
    );
  });

  const outcome = await clickFirstParagraphAndProbe(page);
  expect(
    outcome,
    'renderer must survive a click whose editor pane gains the .ok-mode-hidden paint lock during the same dispatch',
  ).toBe('alive');
});
