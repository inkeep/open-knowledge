import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const TARGET = 'Target block for co-editing.';
const REWRITTEN = 'Target block rewritten by the agent.';
const BLOCKS = 5;
const TARGET_INDEX = 2;

function seedMarkdown(): string {
  return `${Array.from({ length: BLOCKS }, (_, i) =>
    i === TARGET_INDEX ? TARGET : `Filler block ${i} untouched.`,
  ).join('\n\n')}\n`;
}

async function openWithCaret(page: Page, docName: string, place: 'end' | 'home'): Promise<void> {
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.waitForSelector(EDITOR);
  await page.waitForFunction(
    (b: string) =>
      window.__activeProvider?.document?.getText('source')?.toString()?.includes(b) ?? false,
    TARGET,
    { timeout: 15_000 },
  );
  await page.locator(EDITOR).getByText(TARGET, { exact: false }).first().click();
  await page.waitForFunction(() => window.__activeEditor?.isFocused === true, null, {
    timeout: 10_000,
  });
  await page.evaluate(
    ({ b, atEnd }: { b: string; atEnd: boolean }) => {
      const editor = window.__activeEditor;
      if (!editor) throw new Error('no active editor');
      let target = -1;
      editor.state.doc.descendants((node, pos) => {
        if (target >= 0) return false;
        if (!node.isTextblock || !node.textContent.includes(b)) return true;
        target = atEnd ? pos + 1 + node.content.size : pos + 1;
        return false;
      });
      if (target < 0) throw new Error('the target paragraph is not in the editor');
      editor.commands.setTextSelection(target);
    },
    { b: TARGET, atEnd: place === 'end' },
  );
  await page.waitForFunction(
    ({ b, atEnd }: { b: string; atEnd: boolean }) => {
      const editor = window.__activeEditor;
      if (!editor) return false;
      const { $from, empty } = editor.state.selection;
      if (!empty || !editor.isFocused || !$from.parent.textContent.includes(b)) return false;
      return $from.parentOffset === (atEnd ? $from.parent.content.size : 0);
    },
    { b: TARGET, atEnd: place === 'end' },
    { timeout: 10_000 },
  );
}

async function patchTargetBlock(baseURL: string, docName: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/agent-patch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docName, find: TARGET, replace: REWRITTEN }),
  });
  expect(res.status).toBe(200);
}

async function waitForRewrite(page: Page): Promise<void> {
  await page.waitForFunction(
    (b: string) =>
      window.__activeProvider?.document?.getText('source')?.toString()?.includes(b) ?? false,
    REWRITTEN,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    (b: string) => window.__activeEditor?.state.doc.textContent.includes(b) ?? false,
    REWRITTEN,
    { timeout: 10_000 },
  );
}

function targetParagraph(source: string): string {
  return source.split('\n\n')[TARGET_INDEX] ?? '';
}

test.describe('an agent rewrites the paragraph the caret sits in', () => {
  test('a caret at the end of the paragraph stays at its end', async ({ page, api, baseURL }) => {
    const docName = `test-agent-caret-end-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.testReset(docName);
    await api.replaceDoc(docName, seedMarkdown());
    await openWithCaret(page, docName, 'end');

    await patchTargetBlock(baseURL as string, docName);
    await waitForRewrite(page);

    await page.keyboard.type('XYZ', { delay: 60 });
    await expect
      .poll(
        async () =>
          targetParagraph(
            await page.evaluate(
              () => window.__activeProvider?.document?.getText('source')?.toString() ?? '',
            ),
          ),
        { timeout: 10_000 },
      )
      .toBe(`${REWRITTEN}XYZ`);
  });

  test('a caret at the start of the paragraph stays at its start', async ({
    page,
    api,
    baseURL,
  }) => {
    const docName = `test-agent-caret-home-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.testReset(docName);
    await api.replaceDoc(docName, seedMarkdown());
    await openWithCaret(page, docName, 'home');

    await patchTargetBlock(baseURL as string, docName);
    await waitForRewrite(page);

    await page.keyboard.type('XYZ', { delay: 60 });
    await expect
      .poll(
        async () =>
          targetParagraph(
            await page.evaluate(
              () => window.__activeProvider?.document?.getText('source')?.toString() ?? '',
            ),
          ),
        { timeout: 10_000 },
      )
      .toBe(`XYZ${REWRITTEN}`);
  });
});
