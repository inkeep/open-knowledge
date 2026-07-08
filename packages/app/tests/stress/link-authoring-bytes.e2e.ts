/**
 * Byte-pinning E2E for WYSIWYG linkification: exact Y.Text oracles (never
 * substring matches) for the three link-creation paths — typed URL + space,
 * lone-URL paste at cursor, lone-URL paste over a selection — plus the
 * per-path single-undo contract.
 *
 * Exact bytes are the point. A plain-text URL serializes GFM-escaped
 * (`https\://…`) so it stays prose on re-parse, while a linkified URL
 * serializes as the bare literal; a `toContain('inkeep.com')` cannot tell
 * those apart, whole-string equality on Y.Text can.
 *
 * Two serialization behaviors of the bridge shape the oracles below — both
 * pre-existing, neither introduced by linkification:
 *
 *  - Paragraph-trailing whitespace does not round-trip: `'AGENTS.md '`
 *    serializes as `'AGENTS.md\n'`. Expected bytes never carry a trailing
 *    space before the newline.
 *
 *  - A mark-only change can be byte-invisible. Server Observer A settles
 *    without rewriting Y.Text when the new fragment serialization is within
 *    `normalizeBridge` tolerance of the settled bytes, and the CommonMark
 *    escape-collapse class makes `https\://x` and `https://x` compare equal
 *    (they are parse-equivalent: escaped autolink-shaped bytes re-parse to
 *    the same link). So a typed conversion — which only ADDS a mark over
 *    text that is already in Y.Text — leaves the escaped bytes at rest
 *    until the next content-bearing edit re-serializes the paragraph, at
 *    which point the bare literal lands. The typed-path tests pin exactly
 *    that lifecycle: mark first (fragment truth), bare bytes on the next
 *    edit (Y.Text truth). Paste paths insert or restructure content, so
 *    their bytes settle immediately.
 *
 * Link marks render as `<span data-link role="link">` chips (InternalLink
 * deliberately emits no `<a href>` — anchor navigation would race the
 * InteractionLayer), so DOM assertions target the chip.
 *
 * Clipboard injection: DataTransfer + dispatchEvent (same pattern as
 * paste-fidelity.e2e.ts) — bypasses the navigator.clipboard permission
 * gate on headless Chromium.
 *
 * Run:
 *   cd packages/app && bunx playwright test tests/stress/link-authoring-bytes.e2e.ts
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  expect,
  focusEditor,
  selectText,
  simulateCopyAndRead,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const LINK_CHIP = `${EDITOR} span[data-link]`;
const URL_LITERAL = 'https://inkeep.com';

async function getYText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

/** Paste a text/plain-only payload into the WYSIWYG editor. */
async function pasteText(page: Page, text: string) {
  await page.evaluate((content) => {
    const editor = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
    if (!editor) throw new Error('ProseMirror editor not found');
    const dt = new DataTransfer();
    dt.setData('text/plain', content);
    const event = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);
  }, text);
}

/** PM-layer truth: does the active editor's doc carry a link mark, and what
 *  is its plain text? Byte oracles cannot see a mark whose serialization is
 *  within bridge tolerance (file header), so mark-level assertions read the
 *  fragment side directly. */
async function pmLinkSnapshot(page: Page): Promise<{ hasLink: boolean; text: string }> {
  return page.evaluate(() => {
    const ed = window.__activeEditor;
    return {
      hasLink: JSON.stringify(ed?.state.doc.toJSON() ?? {}).includes('"type":"link"'),
      text: ed?.state.doc.textContent ?? '',
    };
  });
}

/** Wait until the active editor's doc gains (or is confirmed to hold) a link
 *  mark — the typed path lands it a microtask after the boundary keystroke. */
async function waitForPmLink(page: Page): Promise<void> {
  await page.waitForFunction(
    () => JSON.stringify(window.__activeEditor?.state.doc.toJSON() ?? {}).includes('"type":"link"'),
    null,
    { timeout: 5_000 },
  );
}

// ─── lone-URL paste at cursor ───

test.describe('lone-URL paste at cursor — bare-literal bytes', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-linkbytes-cursor-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector(EDITOR);
    await page.click(EDITOR);
  });

  test('pasted lone URL lands as a link with exactly the bare-literal bytes', async ({ page }) => {
    await pasteText(page, URL_LITERAL);
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('https://inkeep.com\n');
    await expect(page.locator(`${LINK_CHIP}[aria-label="Link: ${URL_LITERAL}"]`)).toHaveCount(1);
  });

  test('WYSIWYG copy of the pasted link round-trips clean text/plain', async ({ page }) => {
    await pasteText(page, URL_LITERAL);
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('https://inkeep.com\n');
    const out = await simulateCopyAndRead(page, 'wysiwyg');
    expect(out.plain).toBe('https://inkeep.com\n');
  });

  test('one undo removes the pasted link entirely', async ({ page }) => {
    await pasteText(page, URL_LITERAL);
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('https://inkeep.com\n');
    await focusEditor(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('');
    await expect(page.locator(LINK_CHIP)).toHaveCount(0);
  });

  test('explicit-scheme dotless host (localhost) pastes as a link with bare-literal bytes', async ({
    page,
  }) => {
    // The dotted-domain rule is schemeless-only: http://localhost is a GFM
    // autolink literal, so it converts and its bytes stay the bare URL.
    const localUrl = 'http://localhost:5174/#/some-doc';
    await pasteText(page, localUrl);
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe(`${localUrl}\n`);
    await expect(page.locator(`${LINK_CHIP}[aria-label="Link: ${localUrl}"]`)).toHaveCount(1);
  });
});

// ─── lone-URL paste over a selection ───

test.describe('lone-URL paste over a selection — [text](url) bytes', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-linkbytes-sel-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector(EDITOR);
    // Seed through the agent-write path (a remote, undo-untracked origin) so
    // the linkify mark is the first locally-tracked undo item — mirrors real
    // usage, where the selected text long predates the paste.
    await api.replaceDoc(docName, 'inkeep docs\n');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('inkeep docs\n');
    await expect(page.locator(`${EDITOR} p`).first()).toContainText('inkeep docs');
  });

  test('pasting a URL over a selected word keeps the text and links it', async ({ page }) => {
    await selectText(page, 'docs');
    await pasteText(page, URL_LITERAL);
    await expect
      .poll(() => getYText(page), { timeout: 5_000 })
      .toBe('inkeep [docs](https://inkeep.com)\n');
    await expect(page.locator(`${LINK_CHIP}[aria-label="Link: ${URL_LITERAL}"]`)).toHaveCount(1);
  });

  test('one undo restores the pre-paste unlinked text', async ({ page }) => {
    await selectText(page, 'docs');
    await pasteText(page, URL_LITERAL);
    await expect
      .poll(() => getYText(page), { timeout: 5_000 })
      .toBe('inkeep [docs](https://inkeep.com)\n');
    await focusEditor(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('inkeep docs\n');
    await expect(page.locator(LINK_CHIP)).toHaveCount(0);
  });
});

// ─── typed URL + space ───

test.describe('typed URL + space — GFM autolink byte contract', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-linkbytes-typed-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector(EDITOR);
    await page.click(EDITOR);
  });

  test('typed GFM URL converts on space; bytes settle bare on the next edit', async ({ page }) => {
    await page.keyboard.type('https://inkeep.com ');
    // Conversion truth lives in the fragment: the mark lands immediately, but
    // the mark-only change is within bridge tolerance of the escaped bytes
    // already at rest (file header), so Y.Text is asserted after the next
    // content-bearing edit forces a re-serialization.
    await waitForPmLink(page);
    await expect(page.locator(`${LINK_CHIP}[aria-label="Link: ${URL_LITERAL}"]`)).toHaveCount(1);
    await page.keyboard.type('done');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('https://inkeep.com done\n');
  });

  test('typed filename-shaped token stays plain and serializes unlinked', async ({ page }) => {
    await page.keyboard.type('AGENTS.md ');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('AGENTS.md\n');
    await expect(page.locator(LINK_CHIP)).toHaveCount(0);
  });

  test('one undo removes only the mark — text intact, bytes re-escape', async ({ page }) => {
    await page.keyboard.type('https://inkeep.com ');
    await waitForPmLink(page);
    await page.keyboard.press('ControlOrMeta+z');
    // Mark gone, typed text and trailing space intact at the fragment layer.
    await expect
      .poll(() => pmLinkSnapshot(page), { timeout: 5_000 })
      .toEqual({ hasLink: false, text: 'https://inkeep.com ' });
    await expect(page.locator(LINK_CHIP)).toHaveCount(0);
    // The next edit re-serializes the now-unmarked paragraph: the URL escapes
    // back to prose form — the sharp proof that the undone doc's canonical
    // bytes are the escaped ones (not merely that they never changed).
    await page.keyboard.type('x');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toBe('https\\://inkeep.com x\n');
  });
});
