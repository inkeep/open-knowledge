import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, toggleMode } from './_helpers';

const SEED = 'Alpha paragraph zero.\n\nBravo paragraph one.\n\nCharlie paragraph two.\n';
const CARET_IN_BRAVO = 5;

async function openDoc(page: Page, docName: string): Promise<void> {
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider), null, { timeout: 15_000 });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(
    () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('Charlie'),
    null,
    { timeout: 10_000 },
  );
}

async function focusEditor(page: Page): Promise<void> {
  await page.locator('.ProseMirror:not(.composer-prosemirror)').click();
  await page.waitForFunction(() => window.__activeEditor?.isFocused === true, null, {
    timeout: 10_000,
  });
}

async function sourceCaret(page: Page, set?: number): Promise<number> {
  return page.evaluate((target: number | null) => {
    const content = Array.from(document.querySelectorAll<HTMLElement>('.cm-editor'))
      .find((el) => el.getClientRects().length > 0)
      ?.querySelector('.cm-content') as
      | (Element & {
          cmTile?: { root?: { view?: never } };
          cmView?: { rootView?: { view?: never } };
        })
      | null;
    const view = (content?.cmTile?.root?.view ?? content?.cmView?.rootView?.view) as
      | {
          dispatch: (spec: unknown) => void;
          focus: () => void;
          state: { selection: { main: { head: number } } };
        }
      | undefined;
    if (!view) throw new Error('no CodeMirror EditorView on the content DOM');
    if (target !== null) {
      view.dispatch({ selection: { anchor: target, head: target } });
      view.focus();
    }
    return view.state.selection.main.head;
  }, set ?? null);
}

async function visualCaret(page: Page): Promise<[number, number]> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('no active editor');
    const $at = editor.state.doc.resolve(editor.state.selection.from);
    return [$at.index(0), $at.parentOffset] as [number, number];
  });
}

type Shape = 'word' | 'block';

async function dragToEndOfLastParagraph(page: Page, shape: Shape): Promise<string> {
  return page.evaluate((kind: Shape) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('no active editor');
    const view = editor.view;
    const doc = view.state.doc;
    const first = doc.child(0);
    let grabAt: number;
    if (kind === 'word') {
      const from = 1 + first.textContent.indexOf('zero');
      editor.commands.setTextSelection({ from, to: from + 4 });
      grabAt = from + 2;
    } else {
      editor.commands.setNodeSelection(0);
      grabAt = 2;
    }
    const lastStart = first.nodeSize + doc.child(1).nodeSize;
    const dropAt = lastStart + 1 + doc.child(2).textContent.indexOf('two') + 3;
    const dataTransfer = new DataTransfer();
    const fire = (type: string, pos: number): void => {
      const c = view.coordsAtPos(pos);
      view.dom.dispatchEvent(
        new DragEvent(type, {
          dataTransfer,
          bubbles: true,
          cancelable: true,
          clientX: c.left + 1,
          clientY: (c.top + c.bottom) / 2,
        }),
      );
    };
    fire('dragstart', grabAt);
    if (!view.dragging?.move) throw new Error('the synthetic dragstart did not start a move');
    fire('dragover', dropAt);
    fire('drop', dropAt);
    fire('dragend', dropAt);
    return window.__activeProvider?.document?.getText('source')?.toString() ?? '';
  }, shape);
}

const MOVED: Record<Shape, string> = {
  word: 'Alpha paragraph .\n\nBravo paragraph one.\n\nCharlie paragraph twozero.\n',
  block: 'Bravo paragraph one.\n\nCharlie paragraph two.\n\nAlpha paragraph zero.\n',
};

for (const [shape, reader] of [
  ['word', 'visual'],
  ['block', 'visual'],
  ['word', 'source'],
] as const) {
  test(`dragging a ${shape} past a peer's caret leaves that caret in place (peer in ${reader})`, async ({
    browser,
    api,
    baseURL,
  }) => {
    const docName = `drag-move-${shape}-${reader}-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.testReset(docName);
    await api.replaceDoc(docName, SEED);

    const ctxA = await browser.newContext({ baseURL });
    const ctxB = await browser.newContext({ baseURL });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await openDoc(pageA, docName);
      await openDoc(pageB, docName);

      if (reader === 'source') {
        await toggleMode(pageB, 'source');
        const at = SEED.indexOf('Bravo') + CARET_IN_BRAVO;
        expect(await sourceCaret(pageB, at), 'the source caret did not land in Bravo').toBe(at);
      } else {
        await focusEditor(pageB);
        await pageB.evaluate((offset: number) => {
          const editor = window.__activeEditor;
          if (!editor) throw new Error('no active editor');
          editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1 + offset);
        }, CARET_IN_BRAVO);
        expect(await visualCaret(pageB)).toEqual([1, CARET_IN_BRAVO]);
      }

      await focusEditor(pageA);
      const written = await dragToEndOfLastParagraph(pageA, shape);
      expect(written, 'the drop did not move the text').toBe(MOVED[shape]);

      await expect
        .poll(
          async () =>
            pageB.evaluate(
              () => window.__activeProvider?.document?.getText('source')?.toString() ?? '',
            ),
          { timeout: 10_000, message: 'the peer never received the drop' },
        )
        .toBe(MOVED[shape]);

      if (reader === 'source') {
        await expect
          .poll(async () => sourceCaret(pageB), {
            timeout: 5_000,
            message: 'the peer source caret left Bravo',
          })
          .toBe(MOVED[shape].indexOf('Bravo') + CARET_IN_BRAVO);
      } else {
        const bravoBlock = shape === 'block' ? 0 : 1;
        await expect
          .poll(async () => visualCaret(pageB), {
            timeout: 5_000,
            message: 'the peer caret left Bravo',
          })
          .toEqual([bravoBlock, CARET_IN_BRAVO]);
      }
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
}
