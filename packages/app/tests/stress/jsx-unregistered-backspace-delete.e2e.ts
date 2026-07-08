/**
 * Unregistered-JSX Backspace/Delete keyboard surface — Playwright E2E.
 *
 * The registered-component delete surface (NodeSelected wrapper + native
 * Backspace/Delete deletes the block; caret-inside-body deletes one char) is
 * pinned in `jsx-backspace-delete.e2e.ts` against Callout/Accordion. The
 * UNREGISTERED path had zero native-keyboard coverage: an unregistered
 * `<UnknownWidget>` auto-converts to a nested-CodeMirror `rawMdxFallback`
 * box, a different NodeView (`stopEvent: () => true`, `contentEditable=false`
 * wrapper) whose delete behaviors are its own.
 *
 * Two behaviors are pinned here:
 *
 *   1. delete-the-wrapper — with the box NodeSelected and DOM focus on the
 *      outer ProseMirror, native Backspace (and Delete) removes the whole
 *      rawMdxFallback block.
 *   2. delete-to-empty — with DOM focus inside the nested CodeMirror, native
 *      per-char delete empties the raw source; the container survives as a
 *      blank rawMdxFallback (the `jsx-container-boundary-blank` tolerated
 *      state), it is not removed. This routes CM keystrokes through
 *      `forwardUpdate`'s empty-source branch (`tr.delete`), which jsdom
 *      cannot exercise — the app CodeMirror NodeView needs the React portal
 *      infra that only mounts in a real browser.
 *
 * Real Chromium is required: collapsed-caret native delete and nested-CM
 * focus/keystroke routing do not replay deterministically under jsdom (no
 * layout; the CM NodeView never mounts).
 *
 * Not in the CI `test:e2e` subset historically for JSX-editor tests, but this
 * file IS in the subset so the unregistered browser tier runs under
 * `check:full:parallel`.
 */

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

/** Wait for the unregistered component to auto-convert to a rawMdxFallback. */
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

/** Count rawMdxFallback nodes and read the first one's text content. */
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

/** NodeSelect the first rawMdxFallback, then give DOM focus to the outer PM. */
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
  // page.keyboard.press delivers to whatever owns DOM focus; a doc-load +
  // NodeView mount cycle can leave that elsewhere. Anchor it on the outer PM.
  await page.evaluate(() => {
    const pm = document.querySelector(
      '.ProseMirror:not(.composer-prosemirror)',
    ) as HTMLElement | null;
    pm?.focus();
  });
}

// ── delete-the-wrapper: NodeSelected unregistered box + native key removes it ─

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

    // The whole rawMdxFallback block is removed.
    await expect.poll(() => fallbackState(page).then((s) => s.count), { timeout: 2_000 }).toBe(0);
  });
}

// ── delete-to-empty: per-char native delete inside the nested CM empties the
//    source; the container survives as a blank rawMdxFallback ──

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

  // Focus the nested CodeMirror content directly (a plain click on the box
  // resolves to a NodeSelection via the focus-change listener, not a CM
  // caret; JS focus lands DOM focus inside `.cm-content` deterministically).
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

  // Delete forward then backward so the whole CM doc empties regardless of the
  // initial caret position — no reliance on line structure or Mod-chords
  // (Mod-a select-all leaks focus back to the outer PM). Each native keystroke
  // routes through CodeMirror → forwardUpdate; the terminal empty source hits
  // forwardUpdate's `tr.delete` branch.
  for (let i = 0; i < srcLen + 5; i++) await page.keyboard.press('Delete');
  for (let i = 0; i < srcLen + 5; i++) await page.keyboard.press('Backspace');

  // The container is preserved (count still 1) but its source is empty.
  await expect.poll(() => fallbackState(page), { timeout: 2_000 }).toEqual({ count: 1, text: '' });
});
