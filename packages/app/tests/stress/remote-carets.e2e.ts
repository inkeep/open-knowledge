import { randomUUID } from 'node:crypto';
import { expect, test, toggleMode } from './_helpers';

const SEED = 'Alpha paragraph zero.\n\nBravo paragraph one.\n\nCharlie paragraph two.\n';

async function openDoc(page: import('@playwright/test').Page, docName: string): Promise<void> {
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider), null, { timeout: 15_000 });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(
    () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('Charlie'),
    null,
    { timeout: 10_000 },
  );
}

async function placeCaretAt(page: import('@playwright/test').Page, at: number): Promise<void> {
  await page.locator('.ProseMirror:not(.composer-prosemirror)').click();
  await page.waitForFunction(() => window.__activeEditor?.isFocused === true, null, {
    timeout: 10_000,
  });
  await page.evaluate((target: number) => {
    window.__activeEditor?.commands.setTextSelection(target);
  }, at);
}

async function placeCaretAtEnd(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.ProseMirror:not(.composer-prosemirror)').click();
  await page.waitForFunction(() => window.__activeEditor?.isFocused === true, null, {
    timeout: 10_000,
  });
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('no active editor');
    const size = editor.state.doc.content.size;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        (editor.state.selection.constructor as never as { near: (p: unknown) => unknown }).near(
          editor.state.doc.resolve(Math.max(0, size - 2)),
        ) as never,
      ),
    );
  });
}

test('a peer editing in WYSIWYG renders a remote caret in the other client', async ({
  browser,
  api,
  baseURL,
}) => {
  const docName = `remote-carets-${randomUUID().slice(0, 8)}`;
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

    await placeCaretAtEnd(pageA);

    await expect
      .poll(
        async () =>
          pageA.evaluate(() => {
            const aw = window.__activeProvider?.awareness;
            return aw?.getLocalState()?.cursor != null;
          }),
        { timeout: 10_000, message: 'A never published a cursor field' },
      )
      .toBe(true);

    await expect
      .poll(async () => pageB.locator('.collaboration-cursor__caret').count(), {
        timeout: 10_000,
        message: 'B never rendered a remote caret',
      })
      .toBeGreaterThan(0);

    const label = await pageB.locator('.collaboration-cursor__label').first().textContent();
    expect(label ?? '').not.toBe('');
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test('a WYSIWYG caret renders for a peer sitting in source mode', async ({
  browser,
  api,
  baseURL,
}) => {
  const docName = `remote-carets-cross-${randomUUID().slice(0, 8)}`;
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
    await toggleMode(pageB, 'source');

    await placeCaretAtEnd(pageA);

    await expect
      .poll(async () => pageB.locator('.cm-ySelectionCaret').count(), {
        timeout: 10_000,
        message: 'the source-mode peer never rendered the WYSIWYG caret',
      })
      .toBeGreaterThan(0);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test('a caret resting at the end of a paragraph renders there, not one character back', async ({
  browser,
  api,
  baseURL,
}) => {
  const docName = `remote-carets-blockend-${randomUUID().slice(0, 8)}`;
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

    const endOfFirst = await pageA.evaluate(() => {
      const doc = window.__activeEditor?.state.doc;
      if (!doc) throw new Error('no editor');
      return doc.child(0).content.size + 1;
    });
    await placeCaretAt(pageA, endOfFirst);

    await expect
      .poll(async () => pageB.locator('.collaboration-cursor__caret').count(), { timeout: 10_000 })
      .toBe(1);

    const rendered = await pageB.evaluate(() => {
      const el = document.querySelector('.collaboration-cursor__caret');
      const editor = window.__activeEditor;
      if (!el || !editor) return null;
      return editor.view.posAtDOM(el, 0);
    });
    expect(rendered, 'the peer resolved the caret to a different position').toBe(endOfFirst);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test('a caret label stays on screen for as long as its peer is there', async ({
  browser,
  api,
  baseURL,
}) => {
  const docName = `remote-carets-label-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, SEED);

  const ctxA = await browser.newContext({ baseURL });
  const ctxB = await browser.newContext({ baseURL });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const labelOpacity = async (): Promise<number> =>
    pageA.evaluate(() => {
      const label = document.querySelector('.collaboration-cursor__label');
      return label === null ? -1 : Number(getComputedStyle(label).opacity);
    });

  try {
    await openDoc(pageA, docName);
    await openDoc(pageB, docName);

    await placeCaretAt(pageB, 6);
    await expect
      .poll(async () => pageA.locator('.collaboration-cursor__caret').count(), { timeout: 10_000 })
      .toBe(1);
    await expect.poll(labelOpacity, { timeout: 5_000 }).toBeGreaterThan(0.9);

    const label = pageA.locator('.collaboration-cursor__label').first();
    expect((await label.textContent()) ?? '').not.toBe('');

    await expect
      .poll(
        async () => {
          const box = await label.boundingBox();
          return box === null ? 0 : Math.round(box.width);
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);

    await expect
      .poll(labelOpacity, {
        timeout: 8_000,
        message: 'the label faded out while its peer was still in the document',
      })
      .toBeGreaterThan(0.9);

    const painted = await pageA.evaluate(() => {
      const label = document.querySelector('.collaboration-cursor__label');
      const host = document.querySelector('.ok-remote-caret-host');
      if (label === null || host === null) return null;
      const labelRect = label.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      return {
        hostContentVisibility: getComputedStyle(host).contentVisibility,
        labelAboveHost: labelRect.top < hostRect.top,
        labelHeight: Math.round(labelRect.height),
      };
    });
    expect(painted, 'no block was marked as hosting the caret').not.toBeNull();
    expect(
      painted?.labelAboveHost,
      'the label no longer sits outside its block, so this test no longer guards anything',
    ).toBe(true);
    expect(painted?.labelHeight).toBeGreaterThan(0);
    expect(
      painted?.hostContentVisibility,
      'the block hosting the caret kept its paint containment, which clips the label away entirely — the label keeps its full box and opacity while painting nothing, so only this catches it',
    ).toBe('visible');
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

async function setSourceCaret(page: import('@playwright/test').Page, at: number): Promise<number> {
  await page.locator('.cm-content').click();
  return page.evaluate((pos: number) => {
    const content = Array.from(document.querySelectorAll<HTMLElement>('.cm-editor'))
      .find((el) => el.getClientRects().length > 0)
      ?.querySelector('.cm-content');
    const handle = content as
      | (Element & {
          cmTile?: { root?: { view?: never } };
          cmView?: { rootView?: { view?: never } };
        })
      | null
      | undefined;
    const view = (handle?.cmTile?.root?.view ?? handle?.cmView?.rootView?.view) as
      | {
          dispatch: (spec: unknown) => void;
          focus: () => void;
          state: { selection: { main: { head: number } } };
        }
      | undefined;
    if (!view) throw new Error('no CodeMirror EditorView on the content DOM');
    view.dispatch({ selection: { anchor: pos, head: pos } });
    view.focus();
    return view.state.selection.main.head;
  }, at);
}

test('a peer caret never renders as a paragraph the document does not have', async ({
  browser,
  api,
  baseURL,
}) => {
  const docName = `remote-carets-phantom-${randomUUID().slice(0, 8)}`;
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
    await toggleMode(pageA, 'source');

    const blocksBefore = await pageB.evaluate(
      () => window.__activeEditor?.state.doc.childCount ?? -1,
    );

    const gap = SEED.indexOf('\n\n') + 1;
    const head = await setSourceCaret(pageA, gap);
    expect(head, 'the source caret did not land on the blank line between the blocks').toBe(gap);

    await expect
      .poll(async () => pageB.locator('.collaboration-cursor__caret').count(), { timeout: 10_000 })
      .toBe(1);

    const rendered = await pageB.evaluate(() => {
      const pm = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
      const caret = document.querySelector('.collaboration-cursor__caret');
      return {
        topLevelChildren: pm?.children.length ?? -1,
        caretIsTopLevel: caret !== null && caret.parentElement === pm,
        blocks: window.__activeEditor?.state.doc.childCount ?? -1,
      };
    });

    expect(
      rendered.caretIsTopLevel,
      'the caret rendered between blocks, which paints a paragraph that is not in the document',
    ).toBe(false);
    expect(
      rendered.topLevelChildren,
      'the peer grew a visible block the document does not have',
    ).toBe(blocksBefore);
    expect(rendered.blocks, 'the document itself changed shape').toBe(blocksBefore);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

declare global {
  interface Window {
    __cursorCleared?: number;
    __caretVanished?: number;
  }
}

for (const writerMode of ['wysiwyg', 'source'] as const) {
  test(`a peer caret survives its owner typing in ${writerMode}`, async ({
    browser,
    api,
    baseURL,
  }) => {
    const docName = `remote-carets-typing-${writerMode}-${randomUUID().slice(0, 8)}`;
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
      if (writerMode === 'source') await toggleMode(pageA, 'source');

      const editorSelector =
        writerMode === 'source' ? '.cm-content' : '.ProseMirror:not(.composer-prosemirror)';
      await pageA.locator(editorSelector).click();
      if (writerMode === 'wysiwyg') {
        await pageA.waitForFunction(() => window.__activeEditor?.isFocused === true, null, {
          timeout: 10_000,
        });
      }

      await expect
        .poll(async () => pageB.locator('.collaboration-cursor__caret').count(), {
          timeout: 10_000,
        })
        .toBe(1);

      await pageA.evaluate(() => {
        const awareness = window.__activeProvider?.awareness;
        if (!awareness) throw new Error('no awareness');
        window.__cursorCleared = 0;
        awareness.on('change', () => {
          const local = awareness.getLocalState() as { cursor?: unknown } | null;
          if (local !== null && local.cursor == null) window.__cursorCleared += 1;
        });
      });
      await pageB.evaluate(() => {
        const root = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
        if (!root) throw new Error('no editor root');
        window.__caretVanished = 0;
        new MutationObserver(() => {
          if (document.querySelectorAll('.collaboration-cursor__caret').length === 0) {
            window.__caretVanished += 1;
          }
        }).observe(root, { childList: true, subtree: true });
      });

      for (const character of ['Z', 'Y', 'X']) await pageA.keyboard.type(character);
      await expect
        .poll(
          async () =>
            pageA.evaluate(
              () =>
                window.__activeProvider?.document?.getText('source')?.toString()?.includes('ZYX') ??
                false,
            ),
          { timeout: 10_000 },
        )
        .toBe(true);

      const cleared = await pageA.evaluate(() => window.__cursorCleared ?? -1);
      const vanished = await pageB.evaluate(() => window.__caretVanished ?? -1);

      expect(
        cleared,
        `typing in ${writerMode} cleared the writer's own cursor field, which another editor owns`,
      ).toBe(0);
      expect(vanished, `the peer's caret blinked out while its owner typed in ${writerMode}`).toBe(
        0,
      );
      await expect(pageB.locator('.collaboration-cursor__caret')).toHaveCount(1);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
}
