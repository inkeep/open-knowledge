/**
 * JSX Backspace/Delete keyboard surface — Playwright E2E.
 *
 * Pins the observable behaviors that require a real browser to exercise
 * focus + keyboard dispatch:
 *
 *   - NodeSelection on Accordion + focus on the rendered <summary>;
 *     Backspace deletes the block. Same with Delete key.
 *   - NodeSelect Accordion, open popover (gear click), drift PM
 *     selection inside the body, close via Esc; the rAF composite
 *     restore re-anchors NodeSelection on the wrapper. (The downstream
 *     "Backspace deletes" outcome is covered elsewhere — this test scopes
 *     to the composite-restore invariant itself, avoiding duplicate
 *     moving parts.)
 *   - Same composite-restore invariant for the click-trigger-again-close
 *     path, plus the inverse case (click-outside-into-distant-paragraph)
 *     where the selection-still-inside guard short-circuits and
 *     NodeSelection is NOT restored — respecting the user's intent
 *     to "go there."
 *   - NodeSelection on a Callout + focus on a chrome button;
 *     Backspace deletes the block. Confirms the delete-from-chrome-focus
 *     behavior generalizes beyond Accordion to every composite.
 *   - Regression: cursor in a regular paragraph + Backspace deletes
 *     one character. The `!selected` early-return must NOT intercept
 *     normal text editing.
 *
 * Real Chromium is required: focus on `<summary>` and chrome `<button>`
 * elements + Radix popover lifecycles (rAF + onCloseAutoFocus) don't
 * replay deterministically under happy-dom / jsdom.
 *
 * This file is NOT in the CI `test:e2e` file list
 * (`packages/app/package.json` dispatches a fixed subset for PR-tier runs);
 * generic `bunx playwright test` invocations run it for pre-push coverage.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

interface ApiSeed {
  seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void>;
}

async function setupDoc(page: Page, api: ApiSeed, markdown: string): Promise<string> {
  const docName = `backspace-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  return docName;
}

/** Count jsxComponent nodes of a given componentName in the live doc. */
async function jsxNodeCount(page: Page, componentName: string): Promise<number> {
  return page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let count = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        count += 1;
      }
      return true;
    });
    return count;
  }, componentName);
}

/** Programmatically NodeSelect the first jsxComponent matching componentName. */
async function nodeSelectFirstJsx(page: Page, componentName: string) {
  await page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        pos = p;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error(`jsxComponent ${name} not found`);
    editor.chain().focus().setNodeSelection(pos).run();
  }, componentName);
}

/** Report the current selection's constructor name (NodeSelection / TextSelection / …). */
async function selectionType(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    return editor.state.selection.constructor.name;
  });
}

/** Drift PM's selection inside the wrapper's body — mirrors what happens when
 *  Radix `onCloseAutoFocus` returns focus to the trigger button: PM observes
 *  a focus change and resolves a TextSelection at the nearest in-body
 *  position. We do the drift explicitly to keep the test deterministic
 *  across Radix versions. */
async function driftSelectionIntoFirstJsxBody(page: Page, componentName: string) {
  await page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        pos = p;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error(`jsxComponent ${name} not found`);
    // Land selection inside the body (one position past the opening token).
    editor
      .chain()
      .setTextSelection(pos + 2)
      .run();
  }, componentName);
}

// ── Backspace + Delete on NodeSelected Accordion with summary focus ─

test('AC14: Backspace deletes a NodeSelected Accordion when focus is on <summary>', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Accordion title="A">\n\nbody\n\n</Accordion>\n\nafter\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');
  expect(await jsxNodeCount(page, 'Accordion')).toBe(1);

  await nodeSelectFirstJsx(page, 'Accordion');
  expect(await selectionType(page)).toBe('NodeSelection');

  // <details>'s <summary> is the keyboard-focusable element: DOM focus
  // lives on a cE=false descendant of the wrapper while the block is
  // NodeSelected. Dispatch a `keydown` directly to the summary via DOM
  // (bubbles through React's delegated handler tree, exercising the
  // onKeyDown on the NodeViewWrapper). page.keyboard.press would route
  // through Playwright's input system and can interact with PM's own
  // DOM-keydown listener; dispatching via DOM makes the path deterministic
  // across focus model races.
  await page.evaluate(() => {
    const summary = document.querySelector(
      '.jsx-component-wrapper[data-component-type="accordion"] summary',
    ) as HTMLElement | null;
    if (!summary) throw new Error('summary not found');
    summary.focus();
    summary.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
    );
  });

  await expect.poll(() => jsxNodeCount(page, 'Accordion'), { timeout: 2_000 }).toBe(0);
});

test('AC14: Delete key deletes a NodeSelected Accordion when focus is on <summary>', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Accordion title="B">\n\nbody\n\n</Accordion>\n\nafter\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');
  expect(await jsxNodeCount(page, 'Accordion')).toBe(1);

  await nodeSelectFirstJsx(page, 'Accordion');
  await page.evaluate(() => {
    const summary = document.querySelector(
      '.jsx-component-wrapper[data-component-type="accordion"] summary',
    );
    (summary as HTMLElement | null)?.focus();
  });

  await page.keyboard.press('Delete');

  await expect.poll(() => jsxNodeCount(page, 'Accordion'), { timeout: 2_000 }).toBe(0);
});

// ── Popover Esc-close restores NodeSelection; then Backspace deletes

test('AC15: gear-click → Esc-close restores NodeSelection (FR16 round-trip)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Accordion title="C">\n\nbody\n\n</Accordion>\n\nafter\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');
  expect(await jsxNodeCount(page, 'Accordion')).toBe(1);

  await nodeSelectFirstJsx(page, 'Accordion');
  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5_000 });
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

  // Emulate the drift: Radix's focus-return on real keyboard rounds
  // leaves PM with a TextSelection inside the body. We drift explicitly so
  // the test exercises the composite restore branch deterministically.
  await driftSelectionIntoFirstJsxBody(page, 'Accordion');
  expect(await selectionType(page)).toBe('TextSelection');

  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]', {
    state: 'detached',
    timeout: 5_000,
  });

  // The rAF composite restore re-anchors NodeSelection on the wrapper.
  // The downstream Backspace-deletes outcome is covered elsewhere (same
  // pre-condition, fewer moving parts) — this test scopes to the
  // composite-restore invariant itself.
  await expect.poll(() => selectionType(page), { timeout: 2_000 }).toBe('NodeSelection');
});

// ── every popover-close path that keeps selection inside restores NodeSelection

test('AC16: programmatic close restores NodeSelection on the wrapper', async ({ page, api }) => {
  await setupDoc(page, api, '<Accordion title="D">\n\nbody\n\n</Accordion>\n\nafter\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await nodeSelectFirstJsx(page, 'Accordion');
  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5_000 });
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

  await driftSelectionIntoFirstJsxBody(page, 'Accordion');
  expect(await selectionType(page)).toBe('TextSelection');

  // Programmatic close — `setPopoverOpen(false)` flows through the controlled
  // `<Popover open=...>` and routes through `handleOpenChange(false)`. We
  // emulate by clicking the gear button a second time (Radix toggles open
  // state on the trigger), which is the click-trigger-again-close path.
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]', {
    state: 'detached',
    timeout: 5_000,
  });

  await expect.poll(() => selectionType(page), { timeout: 2_000 }).toBe('NodeSelection');
});

test('AC16: selection-still-inside guard does NOT restore when click-outside moves PM into a distant paragraph', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    'first paragraph\n\n<Accordion title="E">\n\nbody\n\n</Accordion>\n\nafter\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await nodeSelectFirstJsx(page, 'Accordion');
  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5_000 });
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

  // Move PM's selection OUTSIDE the wrapper — emulates a click-outside that
  // lands in a paragraph far from the Accordion. With PM positioned at the
  // start of the doc (offset 1), the guard `selFrom < p || selFrom >=
  // nodeEnd` short-circuits and the composite restore is skipped.
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    editor?.chain().setTextSelection(1).run();
  });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]', {
    state: 'detached',
    timeout: 5_000,
  });

  // Give the rAF restore one full double-rAF cycle to fire (if it were
  // going to fire). The guard `selFrom < p || selFrom >= nodeEnd` must
  // short-circuit; selection stays where the user moved it.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  expect(await selectionType(page)).toBe('TextSelection');
});

// ── delete-from-chrome-focus generalizes beyond Accordion — Callout deletes from chrome focus

test('AC17: Backspace deletes a NodeSelected Callout when focus is on a chrome button', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
  expect(await jsxNodeCount(page, 'Callout')).toBe(1);

  await nodeSelectFirstJsx(page, 'Callout');
  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await wrapper.hover();
  // Focus a chrome button that does NOT mutate state on click — the gear
  // (properties) is canonical. Hover keeps the chrome visible so .focus()
  // lands on an attached element.
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5_000 });
  await gear.focus();

  await page.keyboard.press('Backspace');

  await expect.poll(() => jsxNodeCount(page, 'Callout'), { timeout: 2_000 }).toBe(0);
});

// ── Regression: text editing in a regular paragraph is unaffected ──
//
// An Esc-from-inside-Accordion baseline is not exercised here because this
// codebase doesn't support it cleanly: `selectParentNode` on Esc picks the
// inner paragraph (not the wrapper), so the "Esc + Backspace deletes the
// Accordion" premise doesn't hold; and body-text cursor positioning is hard
// to make deterministic across Accordion <details> open/closed state.
//
// What this regression test needs: prove the React onKeyDown does NOT
// intercept normal text editing. The cleanest pin is a regular paragraph
// outside any JSX wrapper — there, `selected` is false on every wrapper, the
// early-return fires, PM handles the Backspace natively, one character
// deletes.

test('FR17 regression: cursor in a regular paragraph + Backspace deletes one character', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, 'hello world\n\n<Callout type="note">\n\nbody\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  // Position cursor at the end of the first paragraph ("hello world").
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    // Doc starts with the paragraph (pos 0 = doc start; pos 1 = inside the
    // paragraph; pos 1+11 = end of "hello world" text).
    editor.chain().focus().setTextSelection(12).run();
  });
  expect(await selectionType(page)).toBe('TextSelection');

  // Explicit DOM focus — `editor.chain().focus()` sets PM's selection but
  // `page.keyboard.press` only reaches whatever element currently owns
  // browser focus, which a doc-load + NodeView mount cycle can leave
  // elsewhere (notably on the prior test's chrome button under
  // single-worker reuse).
  await page.evaluate(() => {
    const pm = document.querySelector(
      '.ProseMirror:not(.composer-prosemirror)',
    ) as HTMLElement | null;
    pm?.focus();
  });

  await page.keyboard.press('Backspace');

  // Verify one character was deleted from the paragraph — text becomes
  // "hello worl" — AND the Callout is untouched.
  const firstParagraphText = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return '';
    return editor.state.doc.firstChild?.textContent ?? '';
  });
  expect(firstParagraphText).toBe('hello worl');
  expect(await jsxNodeCount(page, 'Callout')).toBe(1);
});

// Target surface: text-edit cursor INSIDE a JSX wrapper's body —
// normal char-by-char editing must not be intercepted in this state.
// Distinct from the paragraph-outside regression above: here the keydown
// fires INSIDE a NodeViewWrapper, so React routes it through the
// handleKeyDown branch, where the `!selected` early-return must short-
// circuit before reaching `preventDefault + deleteSelection`. Uses Callout
// rather than Accordion because <details> open/closed state makes positioning
// the cursor inside the body non-deterministic; the invariant is
// composite-shape-agnostic so Callout is the cleanest pin.

// ── Portal containment guard — Backspace / Delete inside a PopoverContent input
//
// The `<PopoverContent>` Radix renders is portaled to `document.body`, so its
// DOM is NOT inside the NodeViewWrapper. But React synthetic events propagate
// through the React virtual tree, including portals — so a `keydown` inside
// the popover's content WILL reach the NodeViewWrapper's `onKeyDown` even
// though `target` lives elsewhere in the DOM. The containment guard in
// `JsxComponentView.tsx` (`if (!e.currentTarget.contains(target)) return;`)
// suppresses this case. Without it, pressing Backspace or Delete to fix a typo
// in a prop-panel input would dispatch `setNodeSelection(p).deleteSelection()`
// and silently destroy the user's block — a real data-loss path. This pair
// pins the guard against any future refactor (React event-system change, Radix
// portal mechanism shift, or accidental guard removal) that would re-expose
// the failure mode. Both keys run through the same `Backspace || Delete`
// branch in `handleKeyDown`, so covering each in turn catches a future split
// where one branch loses the containment check independently.

interface PortalKeyCase {
  readonly key: 'Backspace' | 'Delete';
  readonly cursorTo: 'end' | 'start';
  readonly expected: string;
}

const PORTAL_KEY_CASES: readonly PortalKeyCase[] = [
  // Cursor at end of "Hello World" — Backspace removes the trailing 'd'.
  { key: 'Backspace', cursorTo: 'end', expected: 'Hello Worl' },
  // Cursor at start of "Hello World" — Delete removes the leading 'H'.
  // (Delete at the end would be a no-op against trailing-end position.)
  { key: 'Delete', cursorTo: 'start', expected: 'ello World' },
];

for (const { key, cursorTo, expected } of PORTAL_KEY_CASES) {
  test(`portal guard: ${key} in PopoverContent title input edits the input, not the block`, async ({
    page,
    api,
  }) => {
    await setupDoc(
      page,
      api,
      '<Callout type="note" title="Hello">\n\nbody\n\n</Callout>\n\nafter\n',
    );
    await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
    expect(await jsxNodeCount(page, 'Callout')).toBe(1);

    await nodeSelectFirstJsx(page, 'Callout');
    const wrapper = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
    await wrapper.hover();
    const gear = wrapper.locator('button[aria-label*="properties"]').first();
    await gear.waitFor({ state: 'visible', timeout: 5_000 });
    await gear.click({ force: true });
    await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

    // The title input is portaled outside the NodeViewWrapper's DOM but reachable
    // via React's event tree. Type into it, then dispatch the key via DOM —
    // exercising the path where `target` lives in PopoverContent (at document.body)
    // while `currentTarget` is the NodeViewWrapper.
    const titleInput = page.locator('[data-slot="popover-content"] input[type="text"]').first();
    await titleInput.waitFor({ state: 'visible', timeout: 5_000 });
    await titleInput.focus();

    // Type extra characters into the title to give us something to delete.
    await titleInput.fill('Hello World');
    // Position the cursor where the chosen key will actually remove a character.
    // `fill` leaves the cursor at the end; Backspace operates there, but Delete
    // needs the caret at index 0 to bite into the string instead of no-op'ing.
    if (cursorTo === 'start') {
      await titleInput.evaluate((el) => {
        (el as HTMLInputElement).setSelectionRange(0, 0);
      });
    }
    await page.keyboard.press(key);

    // Invariant 1: the Callout still exists (the block was NOT deleted out from
    // under the user). This is the data-loss guard.
    await expect.poll(() => jsxNodeCount(page, 'Callout'), { timeout: 2_000 }).toBe(1);

    // Invariant 2: the input lost exactly one character (PM did NOT swallow the
    // key and the browser's native input behavior ran).
    await expect.poll(() => titleInput.inputValue(), { timeout: 2_000 }).toBe(expected);
  });
}

test('AC19: cursor inside a JSX wrapper body + Backspace deletes one character (not the wrapper)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nhello world\n\n</Callout>\n\nafter\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
  expect(await jsxNodeCount(page, 'Callout')).toBe(1);

  // Position the cursor at the end of the Callout body text ("hello world"
  // — 11 chars). Walk all descendants until we hit the first text node
  // matching "hello world"; absolute pos comes from the doc walk directly so
  // we never reason about nested-node coordinate offsets.
  const beforeText = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let endOfTextPos = -1;
    let bodyText = '';
    editor.state.doc.descendants((node, pos) => {
      if (endOfTextPos !== -1) return false;
      if (node.isText && (node.text ?? '').includes('hello world')) {
        endOfTextPos = pos + (node.text?.length ?? 0);
        bodyText = node.text ?? '';
        return false;
      }
      return true;
    });
    if (endOfTextPos === -1) throw new Error('Callout body text not found');
    editor.chain().focus().setTextSelection(endOfTextPos).run();
    return bodyText;
  });
  expect(beforeText).toBe('hello world');
  expect(await selectionType(page)).toBe('TextSelection');

  // Explicit DOM focus on the ProseMirror editable area — page.keyboard.press
  // only delivers to whatever element currently owns DOM focus, and a recent
  // doc-load + JSX-component mount cycle can leave that focus elsewhere. The
  // editor.chain().focus() above sets PM's selection but not necessarily the
  // browser's activeElement.
  await page.evaluate(() => {
    const pm = document.querySelector(
      '.ProseMirror:not(.composer-prosemirror)',
    ) as HTMLElement | null;
    pm?.focus();
  });

  // Dispatch Backspace. With cursor inside the body, the Callout wrapper is
  // NOT NodeSelected (`selected` is strictly the NodeSelection-on case), so
  // the `!selected` early-return must fire and PM's native backspace runs —
  // deleting one character from the body.
  await page.keyboard.press('Backspace');

  const afterText = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return '';
    let text = '';
    editor.state.doc.descendants((node) => {
      if (node.type.name !== 'jsxComponent') return true;
      if ((node.attrs.componentName as string) !== 'Callout') return true;
      node.descendants((child) => {
        if (child.isText) {
          text = child.text ?? '';
          return false;
        }
        return true;
      });
      return false;
    });
    return text;
  });
  expect(afterText).toBe('hello worl');
  expect(await jsxNodeCount(page, 'Callout')).toBe(1);
});
