import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });
const visualToggle = (page: Page) => page.getByRole('radio', { name: 'Visual editor' });

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

async function waitForSourceQuiescence(page: Page): Promise<void> {
  let previous: string | null = null;
  await expect
    .poll(
      async () => {
        const current = await readSource(page);
        const settled = current === previous;
        previous = current;
        return settled;
      },
      { timeout: 10_000, intervals: [250] },
    )
    .toBe(true);
}

async function closeUndoStep(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__activeEditor?.state as unknown as
      | Record<string, { undoManager?: { stopCapturing: () => void } } | undefined>
      | undefined;
    const binding = state?.okProjectionBinding$;
    if (!binding?.undoManager) throw new Error('no projection undo manager on the active editor');
    binding.undoManager.stopCapturing();
  });
}

async function caretAtEndOf(page: Page, locatorText: string): Promise<void> {
  const paragraph = page
    .locator('.ProseMirror:not(.composer-prosemirror) > p')
    .filter({ hasText: locatorText })
    .last();
  await paragraph.evaluate((el) => {
    el.closest<HTMLElement>('.ProseMirror')?.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function openDocInSourceMode(
  page: Page,
  api: { createPage: (name: string) => Promise<unknown> },
) {
  const docName = `test-source-undo-flip-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await sourceToggle(page).click();
  const cm = page.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  return cm;
}

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const ONE = 'Seed paragraph one.';
const FILLER = 'Filler paragraph for the peer.';
const THREE = 'Seed paragraph three.';

interface SeedApi {
  createPage(path: string): Promise<void>;
  testReset(docName?: string): Promise<void>;
  replaceDoc(docName: string, markdown: string): Promise<void>;
}

async function seedParagraphs(api: SeedApi, tag: string): Promise<string> {
  const docName = `test-source-undo-${tag}-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, `${ONE}\n\n${FILLER}\n\n${THREE}\n`);
  return docName;
}

async function openSeeded(page: Page, docName: string): Promise<void> {
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector(EDITOR);
  await expect.poll(() => readSource(page), { timeout: 15_000 }).toContain(THREE);
}

async function caretAtEndOfParagraph(page: Page, startsWith: string): Promise<void> {
  await page.locator(EDITOR).getByText(startsWith, { exact: false }).first().click();
  await page.waitForFunction(() => window.__activeEditor?.isFocused ?? false);
  await page.evaluate((prefix) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('no active editor');
    let end = -1;
    editor.state.doc.descendants((node, pos) => {
      if (end !== -1) return false;
      if (node.type.name === 'paragraph' && node.textContent.startsWith(prefix)) {
        end = pos + 1 + node.content.size;
      }
      return true;
    });
    if (end === -1) throw new Error(`no paragraph starts with ${prefix}`);
    editor.commands.setTextSelection(end);
  }, startsWith);
}

async function agentRewritesParagraphOne(page: Page, api: SeedApi, docName: string) {
  const current = await readSource(page);
  await api.replaceDoc(docName, current.replace(/^[^\n]*\n/, 'Agent rewrote paragraph one.\n'));
  await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('Agent rewrote');
  await waitForSourceQuiescence(page);
}

test.describe('source undo after a mode flip (live app)', () => {
  test('source-mode Cmd+Z after WYSIWYG edits retracts them newest first and never destroys the untouched pre-flip line', async ({
    page,
    api,
  }) => {
    const cm = await openDocInSourceMode(page, api);
    await cm.click();
    await page.keyboard.insertText('hello bug\n\n\nhello bug');
    await expect
      .poll(() => readSource(page), { timeout: 10_000 })
      .toContain('hello bug\n\n\nhello bug');

    await visualToggle(page).click();
    const pm = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await expect(pm).toBeVisible({ timeout: 10_000 });
    await expect(pm).toContainText('hello bug');

    await caretAtEndOf(page, 'hello bug');
    await closeUndoStep(page);
    await page.keyboard.insertText(' oops');
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('hello bug oops');
    await waitForSourceQuiescence(page);
    await closeUndoStep(page);

    const blankParagraph = page
      .locator('.ProseMirror:not(.composer-prosemirror) > p')
      .filter({ hasText: /^$/ })
      .first();
    await blankParagraph.click();
    await page.keyboard.type('zoops', { delay: 40 });
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('zoops');
    await waitForSourceQuiescence(page);
    await closeUndoStep(page);

    await sourceToggle(page).click();
    await expect(cm).toBeVisible({ timeout: 10_000 });
    await waitForSourceQuiescence(page);

    const beforeUndo = await readSource(page);
    expect((beforeUndo.match(/hello bug/g) ?? []).length).toBe(2);
    expect(beforeUndo).toContain('hello bug oops');
    expect(beforeUndo).toContain('zoops');

    await cm.click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readSource(page), { timeout: 10_000 }).not.toContain('zoops');
    const afterOne = await readSource(page);
    expect(afterOne).toContain('hello bug oops');
    expect((afterOne.match(/hello bug/g) ?? []).length).toBe(2);

    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readSource(page), { timeout: 10_000 }).not.toContain('oops');
    expect(((await readSource(page)).match(/hello bug/g) ?? []).length).toBe(2);
  });

  test('a peer typing while you are in the visual editor leaves your own edit undoable from source', async ({
    page,
    api,
    browser,
    baseURL,
  }) => {
    const docName = await seedParagraphs(api, 'peer');
    await openSeeded(page, docName);
    await sourceToggle(page).click();
    await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 10_000 });
    await visualToggle(page).click();
    await expect(page.locator(EDITOR).first()).toBeVisible({ timeout: 10_000 });

    await caretAtEndOfParagraph(page, THREE);
    await page.keyboard.type(' typedvis', { delay: 30 });
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('typedvis');
    await waitForSourceQuiescence(page);
    await closeUndoStep(page);

    const peerContext = await browser.newContext({ baseURL });
    try {
      const peer = await peerContext.newPage();
      await openSeeded(peer, docName);
      await caretAtEndOfParagraph(peer, FILLER);
      await peer.keyboard.type(' PEERTEXT', { delay: 30 });
      await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain('PEERTEXT');
      await waitForSourceQuiescence(page);

      await sourceToggle(page).click();
      const cm = page.locator('.cm-content').first();
      await expect(cm).toBeVisible({ timeout: 10_000 });
      await cm.click();
      await page.keyboard.press('ControlOrMeta+z');

      await expect.poll(() => readSource(page), { timeout: 10_000 }).not.toContain('typedvis');
      expect(await readSource(page)).toContain('PEERTEXT');
    } finally {
      await peerContext.close();
    }
  });

  test('guard (PRD-8464): after an agent rewrites the whole document, source undo does not resurrect text you deleted', async ({
    page,
    api,
  }) => {
    const docName = await seedParagraphs(api, 'agent-src');
    await openSeeded(page, docName);
    await sourceToggle(page).click();
    const cm = page.locator('.cm-content').first();
    await expect(cm).toBeVisible({ timeout: 10_000 });
    await cm.getByText(ONE, { exact: false }).first().click();
    await page.keyboard.press('End');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
    await expect.poll(() => readSource(page), { timeout: 10_000 }).not.toContain(ONE);
    await waitForSourceQuiescence(page);
    await closeUndoStep(page);

    await visualToggle(page).click();
    await expect(page.locator(EDITOR).first()).toBeVisible({ timeout: 10_000 });
    await agentRewritesParagraphOne(page, api, docName);

    await sourceToggle(page).click();
    await expect(cm).toBeVisible({ timeout: 10_000 });
    const before = await readSource(page);
    await cm.click();
    await page.keyboard.press('ControlOrMeta+z');
    await waitForSourceQuiescence(page);
    expect(await readSource(page)).toBe(before);

    await page.keyboard.press('ControlOrMeta+z');
    await waitForSourceQuiescence(page);
    expect(await readSource(page)).toBe(before);
  });

  test('after an agent rewrites the whole document, visual undo does not resurrect text you deleted', async ({
    page,
    api,
  }) => {
    const docName = await seedParagraphs(api, 'agent-vis');
    await openSeeded(page, docName);
    await caretAtEndOfParagraph(page, ONE);
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
    await expect.poll(() => readSource(page), { timeout: 10_000 }).not.toContain(ONE);
    await waitForSourceQuiescence(page);
    await closeUndoStep(page);

    await agentRewritesParagraphOne(page, api, docName);

    const before = await readSource(page);
    await caretAtEndOfParagraph(page, THREE);
    await page.keyboard.press('ControlOrMeta+z');
    await waitForSourceQuiescence(page);
    expect(await readSource(page)).toBe(before);

    await page.keyboard.press('ControlOrMeta+z');
    await waitForSourceQuiescence(page);
    expect(await readSource(page)).toBe(before);
  });

  test('guard: a casual peek at Visual editor with no edit preserves source undo history', async ({
    page,
    api,
  }) => {
    const cm = await openDocInSourceMode(page, api);
    await cm.click();
    await page.keyboard.insertText('hello bug\n\n\nhello bug');
    await expect
      .poll(() => readSource(page), { timeout: 10_000 })
      .toContain('hello bug\n\n\nhello bug');

    await visualToggle(page).click();
    const pm = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await expect(pm).toBeVisible({ timeout: 10_000 });
    await expect(pm).toContainText('hello bug');

    await sourceToggle(page).click();
    await expect(cm).toBeVisible({ timeout: 10_000 });
    await waitForSourceQuiescence(page);

    await cm.click();
    await page.keyboard.press('ControlOrMeta+z');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).not.toContain('hello bug');
  });
});
