
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import { expect, test } from './_helpers';

interface PmNodeSummary {
  type: string;
  componentName: string | null;
  reason: string | null;
}

async function setupDoc(page: Page, api: ApiHelpers, markdown: string): Promise<string> {
  const docName = `rawmdx-onblur-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, markdown);
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror');
  return docName;
}

async function readPmNodes(page: Page): Promise<PmNodeSummary[]> {
  return await page.evaluate(() => {
    const ed = window.__activeEditor;
    if (!ed) return [];
    const out: PmNodeSummary[] = [];
    ed.state.doc.descendants((n: { type: { name: string }; attrs: Record<string, unknown> }) => {
      out.push({
        type: n.type.name,
        componentName: (n.attrs?.componentName as string | undefined) ?? null,
        reason: (n.attrs?.reason as string | undefined) ?? null,
      });
    });
    return out;
  });
}


test('S21: fixing broken MDX in nested CM upgrades rawMdxFallback to jsxComponent on blur', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Foo>text</Bar>\n');

  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      let found = false;
      ed.state.doc.descendants((n: { type: { name: string } }) => {
        if (n.type.name === 'rawMdxFallback') found = true;
      });
      return found;
    },
    null,
    { timeout: 5_000 },
  );

  const fallbackCm = page.locator('.raw-mdx-fallback-wrapper .cm-content').first();
  await expect(fallbackCm).toBeAttached({ timeout: 5_000 });
  await fallbackCm.click();

  const originalLen = '<Foo>text</Bar>'.length;
  for (let i = 0; i < originalLen; i++) await page.keyboard.press('Backspace');
  await page.keyboard.insertText('<Callout type="info">\n\nfixed content\n\n</Callout>');

  await page.locator('.ProseMirror').focus();

  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      let foundCallout = false;
      let residualFallback = false;
      ed.state.doc.descendants((n: { type: { name: string }; attrs: Record<string, unknown> }) => {
        const cn = n.attrs?.componentName as string | undefined;
        if (n.type.name === 'jsxComponent' && cn === 'Callout') foundCallout = true;
        if (n.type.name === 'rawMdxFallback') residualFallback = true;
      });
      return foundCallout && !residualFallback;
    },
    null,
    { timeout: 5_000 },
  );

  const summary = await readPmNodes(page);
  expect(summary.filter((n) => n.type === 'rawMdxFallback')).toHaveLength(0);
  expect(
    summary.filter((n) => n.type === 'jsxComponent' && n.componentName === 'Callout'),
  ).toHaveLength(1);
});


test('S22: blur with still-invalid source does not churn the rawMdxFallback node', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Foo>text</Bar>\n');

  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      let found = false;
      ed.state.doc.descendants((n: { type: { name: string } }) => {
        if (n.type.name === 'rawMdxFallback') found = true;
      });
      return found;
    },
    null,
    { timeout: 5_000 },
  );

  const before = await readPmNodes(page);
  const beforeFallback = before.find((n) => n.type === 'rawMdxFallback');
  expect(beforeFallback).toBeDefined();

  const fallbackCm = page.locator('.raw-mdx-fallback-wrapper .cm-content').first();
  await fallbackCm.click();

  const originalLen = '<Foo>text</Bar>'.length;
  for (let i = 0; i < originalLen; i++) await page.keyboard.press('Backspace');
  await page.keyboard.insertText('<Foo>text</Baz>');

  await page.locator('.ProseMirror').focus();

  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      let found = false;
      ed.state.doc.descendants((n: { type: { name: string } }) => {
        if (n.type.name === 'rawMdxFallback') found = true;
      });
      return found;
    },
    null,
    { timeout: 2_000 },
  );

  const after = await readPmNodes(page);
  const afterFallbacks = after.filter((n) => n.type === 'rawMdxFallback');
  expect(afterFallbacks).toHaveLength(1);
  expect(after.filter((n) => n.type === 'jsxComponent' && n.componentName === 'Foo')).toHaveLength(
    0,
  );
});
