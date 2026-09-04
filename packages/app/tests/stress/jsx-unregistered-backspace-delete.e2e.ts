import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import { expect, test } from './_helpers';

interface FallbackNode {
  type: { name: string };
  attrs: Record<string, unknown>;
  textContent: string;
}

async function setupDoc(page: Page, api: ApiHelpers, markdown: string): Promise<string> {
  const docName = `unreg-del-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, markdown);
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  return docName;
}

async function waitForFallback(page: Page, componentName: string): Promise<void> {
  await page.waitForFunction(
    (name) => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      let fallback = false;
      let residualJsx = false;
      ed.state.doc.descendants((n: FallbackNode) => {
        const reason = n.attrs?.reason as string | undefined;
        const cn = n.attrs?.componentName as string | undefined;
        if (n.type.name === 'rawMdxFallback' && reason?.includes(name)) fallback = true;
        if (n.type.name === 'jsxComponent' && cn === name) residualJsx = true;
      });
      return fallback && !residualJsx;
    },
    componentName,
    { timeout: 8_000 },
  );
}

async function fallbackState(page: Page): Promise<{ count: number; text: string | null }> {
  return page.evaluate(() => {
    const ed = window.__activeEditor;
    if (!ed) return { count: 0, text: null };
    let count = 0;
    let text: string | null = null;
    ed.state.doc.descendants((n: FallbackNode) => {
      if (n.type.name === 'rawMdxFallback') {
        count += 1;
        if (text === null) text = n.textContent;
      }
    });
    return { count, text };
  });
}

async function nodeSelectFallbackAndFocusPm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ed = window.__activeEditor;
    if (!ed) throw new Error('window.__activeEditor not set');
    let pos = -1;
    ed.state.doc.descendants((n: FallbackNode, p: number) => {
      if (pos !== -1) return false;
      if (n.type.name === 'rawMdxFallback') {
        pos = p;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error('rawMdxFallback not found');
    ed.chain().focus().setNodeSelection(pos).run();
  });
  await page.evaluate(() => {
    const pm = document.querySelector(
      '.ProseMirror:not(.composer-prosemirror)',
    ) as HTMLElement | null;
    pm?.focus();
  });
}

for (const key of ['Backspace', 'Delete'] as const) {
  test(`FR-B2 delete-the-wrapper: ${key} removes a NodeSelected unregistered box`, async ({
    page,
    api,
  }) => {
    await setupDoc(
      page,
      api,
      '<UnknownWidget foo="bar">\n\nchildren remain editable\n\n</UnknownWidget>\n\nafter\n',
    );
    await waitForFallback(page, 'UnknownWidget');
    expect((await fallbackState(page)).count).toBe(1);

    await nodeSelectFallbackAndFocusPm(page);
    await page.keyboard.press(key);

    await expect.poll(() => fallbackState(page).then((s) => s.count), { timeout: 2_000 }).toBe(0);
  });
}

test('FR-B2 delete-to-empty: native per-char delete inside the CM empties the box, container survives as blank', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<UnknownWidget foo="bar">\n\nHI\n\n</UnknownWidget>\n\nafter\n');
  await waitForFallback(page, 'UnknownWidget');

  const before = await fallbackState(page);
  expect(before.count).toBe(1);
  const srcLen = before.text?.length ?? 0;
  expect(srcLen).toBeGreaterThan(0);

  await page.evaluate(() => {
    const cm = document.querySelector(
      '.raw-mdx-fallback-wrapper .cm-content',
    ) as HTMLElement | null;
    if (!cm) throw new Error('.raw-mdx-fallback-wrapper .cm-content not found');
    cm.focus();
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(document.activeElement?.closest('.raw-mdx-fallback-wrapper .cm-content')),
      ),
    )
    .toBe(true);

  for (let i = 0; i < srcLen + 5; i++) await page.keyboard.press('Delete');
  for (let i = 0; i < srcLen + 5; i++) await page.keyboard.press('Backspace');

  await expect.poll(() => fallbackState(page), { timeout: 2_000 }).toEqual({ count: 1, text: '' });
});
