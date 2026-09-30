import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const ABOVE = 'Paragraph above the caret.';
const ABOVE_GROWN = 'Paragraph above the caret, grown by another editor.';
const TARGET = 'Target paragraph holds the caret.';
const TARGET_REWRITTEN = 'Target paragraph rewritten on disk.';
const BELOW = 'Paragraph below the caret.';
const BELOW_REWRITTEN = 'Paragraph below, rewritten on disk.';
const MID_OFFSET = 'Target '.length;

function markdown(above: string, target: string, below: string): string {
  return `${above}\n\n${target}\n\n${below}\n`;
}

function seedOnDisk(contentDir: string, docName: string): string {
  const filePath = join(contentDir, `${docName}.md`);
  writeFileSync(filePath, markdown(ABOVE, TARGET, BELOW), 'utf-8');
  return filePath;
}

async function openWithCaret(page: Page, docName: string, offset: number | 'end'): Promise<void> {
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
  const expected = offset === 'end' ? TARGET.length : offset;
  await page.evaluate(
    ({ b, at }: { b: string; at: number }) => {
      const editor = window.__activeEditor;
      if (!editor) throw new Error('no active editor');
      let target = -1;
      editor.state.doc.descendants((node, pos) => {
        if (target >= 0) return false;
        if (!node.isTextblock || !node.textContent.includes(b)) return true;
        target = pos + 1 + at;
        return false;
      });
      if (target < 0) throw new Error('the target paragraph is not in the editor');
      editor.commands.setTextSelection(target);
    },
    { b: TARGET, at: expected },
  );
  await page.waitForFunction(
    ({ b, at }: { b: string; at: number }) => {
      const editor = window.__activeEditor;
      if (!editor) return false;
      const { $from, empty } = editor.state.selection;
      if (!empty || !editor.isFocused || !$from.parent.textContent.includes(b)) return false;
      return $from.parentOffset === at;
    },
    { b: TARGET, at: expected },
    { timeout: 10_000 },
  );
}

async function waitForDiskEditInEditor(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (b: string) =>
      window.__activeProvider?.document?.getText('source')?.toString()?.includes(b) ?? false,
    text,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    (b: string) => window.__activeEditor?.state.doc.textContent.includes(b) ?? false,
    text,
    { timeout: 10_000 },
  );
}

async function readSource(page: Page): Promise<string> {
  return page.evaluate(
    () => window.__activeProvider?.document?.getText('source')?.toString() ?? '',
  );
}

function paragraph(source: string, index: number): string {
  return source.split('\n\n')[index] ?? '';
}

test.describe('another editor saves the file while the caret is in it', () => {
  test('a change to the paragraph above leaves the caret where it was', async ({
    page,
    workerServer,
  }) => {
    const docName = `test-disk-caret-above-${randomUUID().slice(0, 8)}`;
    const filePath = seedOnDisk(workerServer.contentDir, docName);
    await openWithCaret(page, docName, MID_OFFSET);

    writeFileSync(filePath, markdown(ABOVE_GROWN, TARGET, BELOW), 'utf-8');
    await waitForDiskEditInEditor(page, ABOVE_GROWN);

    await page.keyboard.type('XYZ', { delay: 60 });
    await expect
      .poll(async () => paragraph(await readSource(page), 1), { timeout: 10_000 })
      .toBe(`${TARGET.slice(0, MID_OFFSET)}XYZ${TARGET.slice(MID_OFFSET)}`);
    expect(paragraph(await readSource(page), 0)).toBe(ABOVE_GROWN);
  });

  test('a rewrite of the caret paragraph keeps an end caret at its end', async ({
    page,
    workerServer,
  }) => {
    const docName = `test-disk-caret-end-${randomUUID().slice(0, 8)}`;
    const filePath = seedOnDisk(workerServer.contentDir, docName);
    await openWithCaret(page, docName, 'end');

    writeFileSync(filePath, markdown(ABOVE, TARGET_REWRITTEN, BELOW), 'utf-8');
    await waitForDiskEditInEditor(page, TARGET_REWRITTEN);

    await page.keyboard.type('XYZ', { delay: 60 });
    await expect
      .poll(async () => paragraph(await readSource(page), 1), { timeout: 10_000 })
      .toBe(`${TARGET_REWRITTEN}XYZ`);
  });

  test('undo after a disk change retracts only the local typing', async ({
    page,
    workerServer,
  }) => {
    const docName = `test-disk-caret-undo-${randomUUID().slice(0, 8)}`;
    const filePath = seedOnDisk(workerServer.contentDir, docName);
    await openWithCaret(page, docName, 'end');

    await page.keyboard.insertText('XYZ');
    await expect
      .poll(() => readFileSync(filePath, 'utf-8'), { timeout: 15_000 })
      .toBe(markdown(ABOVE, `${TARGET}XYZ`, BELOW));

    writeFileSync(filePath, markdown(ABOVE, `${TARGET}XYZ`, BELOW_REWRITTEN), 'utf-8');
    await waitForDiskEditInEditor(page, BELOW_REWRITTEN);

    await page.keyboard.press('ControlOrMeta+z');
    await expect
      .poll(async () => readSource(page), { timeout: 10_000 })
      .toBe(markdown(ABOVE, TARGET, BELOW_REWRITTEN));
  });
});
