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
  const docName = `jsx-wildcard-${randomUUID().slice(0, 8)}`;
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

test('S20: unregistered <UnknownWidget> auto-converts to rawMdxFallback on mount', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    '<UnknownWidget foo="bar">\n\nchildren remain editable\n\n</UnknownWidget>\n',
  );

  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      let foundFallback = false;
      let residualJsx = false;
      ed.state.doc.descendants((n: { type: { name: string }; attrs: Record<string, unknown> }) => {
        const cn = n.attrs?.componentName as string | undefined;
        const reason = n.attrs?.reason as string | undefined;
        if (n.type.name === 'rawMdxFallback' && reason?.includes('UnknownWidget')) {
          foundFallback = true;
        }
        if (n.type.name === 'jsxComponent' && cn === 'UnknownWidget') {
          residualJsx = true;
        }
      });
      return foundFallback && !residualJsx;
    },
    null,
    { timeout: 5_000 },
  );

  const summary = await page.evaluate(() => {
    const ed = window.__activeEditor;
    if (!ed) return null;
    const nodes: PmNodeSummary[] = [];
    ed.state.doc.descendants((n: { type: { name: string }; attrs: Record<string, unknown> }) => {
      nodes.push({
        type: n.type.name,
        componentName: (n.attrs?.componentName as string | undefined) ?? null,
        reason: (n.attrs?.reason as string | undefined) ?? null,
      });
    });
    return nodes;
  });
  expect(summary).not.toBeNull();
  const fallbacks = summary?.filter(
    (n) => n.type === 'rawMdxFallback' && n.reason?.includes('UnknownWidget'),
  );
  const residualJsxForUnknown = summary?.filter(
    (n) => n.type === 'jsxComponent' && n.componentName === 'UnknownWidget',
  );
  expect(fallbacks).toHaveLength(1);
  expect(residualJsxForUnknown).toHaveLength(0);
});
