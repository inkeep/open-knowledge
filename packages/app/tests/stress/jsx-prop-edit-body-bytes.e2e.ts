import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const CALLOUT = '.jsx-component-wrapper[data-component-type="callout"]';

const CASES = [
  {
    name: 'a top-level Callout',
    seed: '# Notes\n\n<Callout type="note">\nFirst line.\n\nSecond line.\n</Callout>\n\nAfter.\n',
  },
  {
    name: 'a Callout with a doc-relative image',
    seed: '# Notes\n\n<Callout type="note">\nSee this:\n\n![](img.png)\n</Callout>\n\nAfter.\n',
  },
  {
    name: 'a Callout with an inline doc-relative image',
    seed: '<Callout type="note">\nSee ![](img.png) here.\n</Callout>\n\nAfter.\n',
  },
  {
    name: 'a Callout in a list item',
    seed: '- Item\n\n  <Callout type="note">\n  First line.\n  </Callout>\n\nAfter.\n',
  },
  {
    name: 'a Callout in a blockquote',
    seed: '> <Callout type="note">\n> First line.\n> </Callout>\n\nAfter.\n',
  },
  {
    name: 'a Callout with a quoted ">" in an attribute',
    seed: '<Callout type="note" title="a > b">\nFirst line.\n</Callout>\n\nAfter.\n',
  },
  {
    name: 'a Callout that holds another Callout',
    seed: '<Callout type="note">\nOuter.\n\n<Callout type="tip">\nInner.\n</Callout>\n</Callout>\n\nAfter.\n',
  },
];

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

async function setCalloutType(page: Page, value: string): Promise<void> {
  const wrapper = page.locator(CALLOUT).first();
  await wrapper.locator('p').first().hover();
  await wrapper.getByRole('button', { name: 'Callout properties' }).first().click();
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover.locator('[data-prop-panel]')).toBeVisible();
  await popover.locator('#prop-type').click();
  await page.getByRole('option', { name: value, exact: true }).click();
  await popover.getByRole('button', { name: 'Done' }).click();
  await expect(popover).toHaveCount(0);
}

for (const { name, seed } of CASES) {
  test(`a Properties edit on ${name} changes only the opening tag`, async ({ page, api }) => {
    const docName = `jsx-prop-edit-bytes-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.testReset(docName);
    await api.replaceDoc(docName, seed);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await expect(page.locator(CALLOUT).first()).toBeVisible();
    expect(await readSource(page), 'opening the document changed its bytes').toBe(seed);

    await setCalloutType(page, 'warning');
    await expect.poll(() => readSource(page)).toContain('type="warning"');
    expect(
      await readSource(page),
      'the prop edit rewrote the Callout body, not only its opening tag',
    ).toBe(seed.replace('type="note"', 'type="warning"'));

    await setCalloutType(page, 'note');
    await expect.poll(() => readSource(page)).not.toContain('type="warning"');
    expect(
      await readSource(page),
      'changing the prop back did not restore the original bytes',
    ).toBe(seed);
  });
}

test('a body edit before a Properties edit survives the prop edit', async ({ page, api }) => {
  const seed = '<Callout type="note">\nFirst line.\n</Callout>\n\nAfter.\n';
  const docName = `jsx-prop-edit-bytes-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, seed);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  await page.locator(CALLOUT).locator('p', { hasText: 'First line.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Added.');
  await expect.poll(() => readSource(page)).toContain('First line. Added.');

  await setCalloutType(page, 'warning');
  await expect.poll(() => readSource(page)).toContain('type="warning"');
  expect(await readSource(page), 'the prop edit dropped the body edit').toContain(
    'First line. Added.',
  );
});
