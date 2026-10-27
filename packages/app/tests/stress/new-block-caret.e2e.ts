import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  placeCaretAtEndOfText,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const FIRST_LINE = 'Start here:';
const LONG_LINE = 'abcdefghijklmnopqrstuvwxyz0123456789';
const AGENT_LINE = 'The agent added this line.';

type Gap = 'same-task' | 'after-frame';

interface CaretReading {
  frameRanBeforeInput: boolean;
  flashStateAtInput: string | null;
  caretInNewEmptyBlock: boolean;
  parentOffset: number;
  parentText: string;
}

async function openFreshDoc(page: Page, api: ApiHelpers): Promise<string> {
  const docName = `new-block-caret-${randomUUID()}`;
  await api.seedDocs([{ name: docName, markdown: `${FIRST_LINE}\n` }]);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(EDITOR)).toContainText(FIRST_LINE);
  await placeCaretAtEndOfText(page, FIRST_LINE);
  return docName;
}

async function pressEnterThen(
  page: Page,
  gap: Gap,
  input: 'type-marker' | 'move-up',
): Promise<CaretReading> {
  return page.evaluate(
    async ({ gap, input, longLine }) => {
      const editor = window.__activeEditor;
      if (!editor) throw new Error('window.__activeEditor not set');
      const view = editor.view;
      const nextFrame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      let frameRan = false;
      requestAnimationFrame(() => {
        frameRan = true;
      });
      const blocksBefore = view.state.doc.childCount;
      const indexBefore = view.state.selection.$from.index(0);
      view.dom.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
      const afterEnter = view.state.selection.$from;
      const caretInNewEmptyBlock =
        view.state.doc.childCount === blocksBefore + 1 &&
        afterEnter.index(0) === indexBefore + 1 &&
        afterEnter.parent.content.size === 0;
      if (input === 'move-up') editor.commands.insertContent(longLine);
      if (gap === 'after-frame') await nextFrame();
      const frameRanBeforeInput = frameRan;
      const flashStateAtInput =
        view.dom.closest('[data-agent-flash-state]')?.getAttribute('data-agent-flash-state') ??
        null;
      if (input === 'type-marker') {
        // oxlint-disable-next-line typescript/no-deprecated -- execCommand is the only way to run Chromium's native insertText, the command a keypress runs, in the same task as Enter
        document.execCommand('insertText', false, '*');
        await Promise.resolve();
      } else {
        document.getSelection()?.modify('move', 'backward', 'line');
        await nextFrame();
      }
      const { $from } = view.state.selection;
      return {
        frameRanBeforeInput,
        flashStateAtInput,
        caretInNewEmptyBlock,
        parentOffset: $from.parentOffset,
        parentText: $from.parent.textContent,
      };
    },
    { gap, input, longLine: LONG_LINE },
  );
}

const readSource = (page: Page): Promise<string> =>
  page.evaluate(() => window.__activeProvider?.document?.getText('source')?.toString() ?? '');

test.describe('typing into a block made in the same frame as its caret', () => {
  test('a marker typed before the next frame keeps the caret after it, so "* " becomes a bullet', async ({
    page,
    api,
  }) => {
    await openFreshDoc(page, api);

    const reading = await pressEnterThen(page, 'same-task', 'type-marker');

    expect(reading.frameRanBeforeInput).toBe(false);
    expect(reading.caretInNewEmptyBlock).toBe(true);
    expect({ offset: reading.parentOffset, text: reading.parentText }).toEqual({
      offset: 1,
      text: '*',
    });

    await page.keyboard.type(' Milk');
    await expect(page.locator(EDITOR).locator('ul > li')).toHaveText(['Milk']);
    await expect.poll(() => readSource(page)).toMatch(/^Start here:\n\n[*-] Milk\n?$/);
  });

  test('control: the same marker typed after a frame keeps the caret after it', async ({
    page,
    api,
  }) => {
    await openFreshDoc(page, api);

    const reading = await pressEnterThen(page, 'after-frame', 'type-marker');

    expect(reading.frameRanBeforeInput).toBe(true);
    expect(reading.caretInNewEmptyBlock).toBe(true);
    expect({ offset: reading.parentOffset, text: reading.parentText }).toEqual({
      offset: 1,
      text: '*',
    });
  });

  test('moving up before the next frame keeps the caret column in the block it just left', async ({
    page,
    api,
  }) => {
    await openFreshDoc(page, api);

    const reading = await pressEnterThen(page, 'same-task', 'move-up');

    expect(reading.frameRanBeforeInput).toBe(false);
    expect(reading.caretInNewEmptyBlock).toBe(true);
    expect({ offset: reading.parentOffset, text: reading.parentText }).toEqual({
      offset: FIRST_LINE.length,
      text: FIRST_LINE,
    });
  });

  test('moving up before the next frame keeps the caret column while a reduced-motion agent flash is on', async ({
    page,
    api,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const docName = await openFreshDoc(page, api);
    await api.writeAsAgent(docName, `${FIRST_LINE}\n\n${AGENT_LINE}\n`, {
      agentId: 'flash-probe',
      agentName: 'FlashProbe',
    });
    await expect(page.locator(EDITOR)).toContainText(AGENT_LINE);
    await expect(page.locator(`.tiptap-editor:has(${EDITOR})`)).toHaveAttribute(
      'data-agent-flash-state',
      'editing',
    );
    await placeCaretAtEndOfText(page, FIRST_LINE);

    const reading = await pressEnterThen(page, 'same-task', 'move-up');

    expect(reading.flashStateAtInput).toBe('editing');
    expect(reading.frameRanBeforeInput).toBe(false);
    expect(reading.caretInNewEmptyBlock).toBe(true);
    expect({ offset: reading.parentOffset, text: reading.parentText }).toEqual({
      offset: FIRST_LINE.length,
      text: FIRST_LINE,
    });
  });
});

test('a selection across blocks keeps content-visibility auto on the blocks between its ends', async ({
  page,
  api,
}) => {
  const lines = ['Line zero', 'Line one', 'Line two', 'Line three', 'Line four', 'Line five'];
  const docName = `selection-blocks-${randomUUID()}`;
  await api.seedDocs([{ name: docName, markdown: `${lines.join('\n\n')}\n` }]);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(EDITOR)).toContainText('Line five');
  const selectionEnds = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    const ends: number[] = [];
    editor.state.doc.forEach((node, pos) => {
      ends.push(pos + node.nodeSize - 1);
    });
    editor.chain().focus().setTextSelection({ from: ends[1], to: ends[4] }).run();
    const { $from, $to } = editor.state.selection;
    return { from: $from.index(0), to: $to.index(0) };
  });
  expect(selectionEnds).toEqual({ from: 1, to: 4 });

  const blockVisibility = (): Promise<string[]> =>
    page.evaluate((editorSelector) => {
      const root = document.querySelector(editorSelector);
      if (!root) throw new Error('editor not found');
      return Array.from(root.children)
        .filter((el) => el.classList.contains('ok-chunk-wrapper'))
        .map((el) => getComputedStyle(el).contentVisibility);
    }, EDITOR);
  await expect
    .poll(blockVisibility)
    .toEqual(['auto', 'visible', 'auto', 'auto', 'visible', 'auto']);
});
