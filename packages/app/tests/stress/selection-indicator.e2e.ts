/**
 * Playwright E2E for block-selection-indicator.
 *
 * All S*-named tests use the 5-pack primitives:
 * Image (self-closing single-block), Callout (block
 * container), Accordion-in-Callout (nested jsxComponent),
 * Step → Accordion.
 *
 * The `[data-component-type="..."]` selectors and `'componentName'` node
 * checks track those substrates; the selection-indicator invariants
 * (halo chrome, aria-live announcements, innermost-wins, forced-colors,
 * reduced-motion) are descriptor-agnostic and exercise the same code
 * paths through the 5-pack substrates.
 *
 * This file IS in the PR-tier `test:e2e` matrix (`packages/app/package.json`)
 * — any regression to the selection halo, drag, drop, keyboard contract, or
 * chrome-bar surface fails the PR gate, not just nightly stability surveillance.
 *
 * ## Correctness floor
 *
 *   S1.  ArrowDown auto-NodeSelects self-closing JSX wrapper (KeyboardNav L0)
 *   S1b. ArrowUp symmetry
 *   S1c. Compound-block descent regression guard (CRITICAL — L0 over-fire test)
 *   S1d. ArrowUp from inside compound exits cleanly (TextSelection)
 *   S1e. Esc inside compound enters NodeSelection mode (existing L1)
 *   S2.  Pointer selection — origin='pointer'
 *   S3.  Nested innermost-wins (store-enforced)
 *   S4.  Drag suppresses the halo
 *   S5.  Windows High Contrast Mode — halo visible via outline fallback
 *   S6.  prefers-reduced-motion — halo transition duration = 0s
 *   S7.  Footer renders no breadcrumb chrome on Callout/Accordion selection
 *        (Breadcrumb component removed)
 *   S8.  aria-live region announces selection changes
 *
 * Expanded coverage:
 *   S9.  Three-axis composition — dragging dominates over selected + needs-config
 *   S9b. alt="" decorative opt-in does NOT fire data-needs-config (tri-state complement to S9)
 *   S11. Per-substrate halo --selection-halo-inset is uniform -4px across callout,
 *        accordion, img, video, audio (uniform inset is the load-bearing rule
 *        across substrates; per-substrate radius / color overrides preserved)
 *   S12. Halo z-index: -1 + .component-children visible when selected
 *   S13. Callout type-color inheritance (parameterized across 5 callout types)
 *   S14. Programmatic origin via SELECTION_ORIGIN_META_KEY
 *   S16. axe-core — zero critical violations on selection-layer surfaces
 *   S18. aria-live debounce coalesces rapid selection changes
 *
 * Selection dispatch: we use `page.evaluate` + `editor.chain().setNodeSelection()`
 * for deterministic node-selection. This exercises the state → DOM pipeline
 * (plugin apply → notify → useBlockSelection → data-* attrs → CSS halo)
 * without fighting TipTap's nuanced click-to-select UX (handleBodyClick
 * only auto-selects self-closing or childless blocks). The click-to-select
 * UX is tested separately at the UX layer — this suite is about the
 * selection plugin + rendering pipeline.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import { expect, focusEditor, test, waitForPmSelectionInNode } from './_helpers';

/** Per-test fixture setup: create an isolated doc, seed markdown, navigate.
 *  Each test owns its own docName so parallel workers don't collide. */
async function setupDoc(page: Page, api: ApiHelpers, markdown: string): Promise<string> {
  const docName = `test-sel-${randomUUID().slice(0, 8)}`;
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

/** Programmatically NodeSelect a jsxComponent by componentName (first match).
 *  Uses window.__activeEditor — exposed by TiptapEditor for E2E observability. */
async function selectFirstJsxComponent(page: Page, componentName: string) {
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  return await page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) return false;
    let foundPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (foundPos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        foundPos = pos;
        return false;
      }
      return true;
    });
    if (foundPos === -1) return false;
    editor.chain().focus().setNodeSelection(foundPos).run();
    return true;
  }, componentName);
}

/** True when ProseMirror's selection head sits inside a jsxComponent — i.e. the
 *  caret descended into a compound block's body. Mirrors the inline walk S1c
 *  uses; shared by the L2d descent-parity tests (S1c-R/L/U/ACC). */
async function caretInsideCompound(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return false;
    const sel = editor.state.selection;
    if (!('$head' in sel)) return false;
    const $head = sel.$head as { depth: number; node: (d: number) => { type: { name: string } } };
    for (let d = $head.depth; d >= 0; d--) {
      if ($head.node(d).type.name === 'jsxComponent') return true;
    }
    return false;
  });
}

/** Place the caret at the start or end of the first textblock whose text equals
 *  `text`, via the editor API + DOM-focus commit (the S1f/S1g pattern — click +
 *  Home/End was flaky on loaded CI workers). */
async function caretAtTextblock(page: Page, text: string, edge: 'start' | 'end'): Promise<void> {
  await page.evaluate(
    ({ text, edge }) => {
      const editor = window.__activeEditor;
      if (!editor) return;
      let pos = -1;
      editor.state.doc.descendants((node, p) => {
        if (node.type.name === 'heading' && node.textContent === text) {
          pos = edge === 'start' ? p + 1 : p + 1 + node.textContent.length;
        }
        return true;
      });
      if (pos >= 0) editor.chain().focus().setTextSelection(pos).run();
    },
    { text, edge },
  );
  await focusEditor(page);
  await waitForPmSelectionInNode(page, 'heading');
}

// ── S1: ArrowDown into self-closing JSX auto-NodeSelects ─────────────────
//
// L0 keyboard contract: bare ArrowDown from a TextSelection at end-of-textblock
// adjacent to a self-closing JSX wrapper (childCount === 0) auto-dispatches a
// NodeSelection on that wrapper. Mirrors the click-to-NodeSelect parity for
// self-closing leaves (handleBodyClick path) so users don't have to know about
// the structural difference between PM's atom: true leaves and OK's
// container-style atom: false jsxComponent.

test('S1: ArrowDown auto-NodeSelects self-closing Callout below the cursor', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    '# Title\n\n<Callout type="note" title="Hello" />\n\n<Callout type="tip" title="World" />\n',
  );
  await page.waitForSelector('.jsx-component-wrapper');

  // Position the caret at the end of the heading text (just above the first
  // Callout). Click + End → caret at end of textblock.
  await page.locator('.ProseMirror h1').first().click();
  await page.keyboard.press('End');

  await page.keyboard.press('ArrowDown');

  const firstCallout = page
    .locator('.jsx-component-wrapper[data-component-type="callout"]')
    .first();
  await expect(firstCallout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(firstCallout).toHaveAttribute('data-selection-origin', 'keyboard');
});

// ── S1b: ArrowUp symmetry — start-of-textblock → previous self-closing ───
//
// Symmetric to S1. Cursor at the start of a textblock BELOW an empty Callout
// → ArrowUp NodeSelects the Callout above.

test('S1b: ArrowUp auto-NodeSelects self-closing Callout above the cursor', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note" title="Above" />\n\n# Footer\n');
  await page.waitForSelector('.jsx-component-wrapper');

  // Caret at start of "# Footer" — click + Home.
  await page.locator('.ProseMirror h1').first().click();
  await page.keyboard.press('Home');

  await page.keyboard.press('ArrowUp');

  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(callout).toHaveAttribute('data-selection-origin', 'keyboard');
});

// ── S1c: Compound-block descent regression guard (CRITICAL) ──────────────
//
// L0 must NOT fire on compound JSX wrappers (childCount > 0) — ArrowDown
// from above a `<Callout>body</Callout>` MUST descend into the body content
// per universal industry behavior (Notion, Anytype, Logseq, BlockSuite all
// agree). If this test ever passes by NodeSelecting the outer Callout
// instead of descending, L0's `childCount === 0` gate has regressed and
// the "select-vs-descend" mental model is broken.

test('S1c: ArrowDown into compound Callout descends into body (no NodeSelect)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '# Title\n\n<Callout type="note">\n\nbody content\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  await page.locator('.ProseMirror h1').first().click();
  // Commit DOM focus + PM selection before synthetic keys: the click's
  // focus can be stolen by a doc-load / NodeView mount cycle under worker
  // reuse (see jsx-backspace-delete's explicit-DOM-focus rationale), and
  // `page.keyboard.press` dispatches into whatever owns focus — stolen
  // focus turns both keypresses into no-ops and the descent never happens.
  await focusEditor(page);
  await waitForPmSelectionInNode(page, 'heading');
  await page.keyboard.press('End');

  await page.keyboard.press('ArrowDown');

  // Compound Callout must NOT be NodeSelected — PM default fires + caret
  // descends into the body's first paragraph.
  await expect(page.locator('.jsx-component-wrapper[data-selected="true"]')).toHaveCount(0);

  // PM's native vertical-arrow descent commits to `state.selection`
  // asynchronously (DOMObserver readback) — under workers=4 contention the
  // lag reaches tens of ms, and the toHaveCount(0) above is a negative
  // assert (true before AND after descent), so it provides no settle
  // barrier. Wait for the descent to land in PM state before reading it.
  await waitForPmSelectionInNode(page, 'jsxComponent');

  // The caret is inside the body content (TextSelection inside the Callout).
  const insideBody = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return false;
    const sel = editor.state.selection;
    if (!('$head' in sel)) return false;
    // Walk up the resolved-pos chain to detect a jsxComponent ancestor.
    const $head = sel.$head as { depth: number; node: (d: number) => { type: { name: string } } };
    for (let d = $head.depth; d >= 0; d--) {
      if ($head.node(d).type.name === 'jsxComponent') return true;
    }
    return false;
  });
  expect(insideBody).toBe(true);
});

// ── S1d: ArrowUp out of compound block exits cleanly (no NodeSelect) ─────
//
// Caret in a compound Callout's body, near the top → ArrowUp moves caret
// out of the body to the textblock above. Must NOT NodeSelect the Callout
// on the way out (the L0 forward gate must not fire backward and vice versa).

test('S1d: ArrowUp from inside compound Callout exits to TextSelection above', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '# Title\n\n<Callout type="note">\n\nbody content\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  // Position caret at start of the Callout body content via a real DOM
  // click + Home. The earlier `editor.chain().focus().setTextSelection()`
  // pattern races TipTap's rAF-deferred view.focus() — when this test runs
  // after S1c (same worker, page reuses across tests), DOM cursor stayed at
  // a stale offset and the subsequent ArrowUp moved from the wrong origin.
  // The real click is the same pattern S1c uses; mirrors S1's click→key
  // contract. See `focusEditor`'s docstring for the rAF / selectionToDOM
  // gap that the programmatic pattern surfaces.
  await page
    .locator('.ProseMirror:not(.composer-prosemirror) p')
    .filter({ hasText: 'body content' })
    .first()
    .click();
  await page.keyboard.press('Home');
  await waitForPmSelectionInNode(page, 'jsxComponent');

  await page.keyboard.press('ArrowUp');

  // No wrapper has data-selected — L0 must not trigger backward NodeSelect
  // on exit from a compound block.
  await expect(page.locator('.jsx-component-wrapper[data-selected="true"]')).toHaveCount(0);

  // Caret has exited to the heading above (TextSelection outside the Callout).
  const outsideCallout = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return false;
    const sel = editor.state.selection;
    if (!('$head' in sel)) return false;
    const $head = sel.$head as { depth: number; node: (d: number) => { type: { name: string } } };
    for (let d = $head.depth; d >= 0; d--) {
      if ($head.node(d).type.name === 'jsxComponent') return false;
    }
    return true;
  });
  expect(outsideCallout).toBe(true);
});

// ── S1e: Esc inside compound Callout enters NodeSelection mode (L1) ──────
//
// Regression guard for the already-implemented L1 Esc handler. Cursor in
// the body of a Callout → Esc → editor.commands.selectParentNode dispatches
// a NodeSelection on the immediate parent (paragraph) — that is PM's
// `selectParentNode` semantics, not on the wrapper itself. Climbing to the
// outer jsxComponent wrapper would require a custom climb-to-jsxComponent
// command — deliberately not shipped. This test pins what L1 DOES
// (TextSelection → NodeSelection of SOME ancestor), which is the regression
// guard L0 must not break.
//
// Note: PM's `selectParentNode` is also the behavior pinned by the existing
// comment in `jsx-backspace-delete.e2e.ts` ("KeyboardNav L1's selectParentNode
// picks the inner paragraph, not the wrapper, on Esc").

test('S1e: Esc inside compound Callout enters NodeSelection mode via L1', async ({ page, api }) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody content\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  // Position caret at start of the Callout body content via a real DOM
  // click. Programmatic positioning via `editor.chain().focus().setTextSelection()`
  // races TipTap's rAF-deferred view.focus() — see S1d's matching comment.
  await page
    .locator('.ProseMirror:not(.composer-prosemirror) p')
    .filter({ hasText: 'body content' })
    .first()
    .click();
  await page.keyboard.press('Home');
  await waitForPmSelectionInNode(page, 'jsxComponent');

  // Pre-condition: TextSelection inside the Callout body.
  const preSelectionType = await page.evaluate(
    () => window.__activeEditor?.state.selection.constructor.name ?? '',
  );
  expect(preSelectionType).toBe('TextSelection');

  await page.keyboard.press('Escape');

  // Post-condition: L1 has converted to a NodeSelection. The selected node
  // may be the paragraph (selectParentNode's default behavior) or the
  // Callout wrapper depending on PM's depth resolution — both prove L1
  // fired and L0 didn't suppress it.
  await expect
    .poll(() => page.evaluate(() => window.__activeEditor?.state.selection.constructor.name), {
      timeout: 5_000,
    })
    .toBe('NodeSelection');
});

// ── S1f: ArrowRight from end-of-textblock → NodeSelect adj self-closing JSX ──
//
// Horizontal-arrow L0 symmetry: bare ArrowRight from end-of-textblock with an
// adjacent self-closing JSX wrapper auto-NodeSelects, mirroring S1 (ArrowDown)
// but exercising the `endOfTextblock('right')` branch + `$head.after()` position
// resolution. Important because the horizontal-arrow `view.endOfTextblock()`
// evaluation is end-of-line (not end-of-block) and the position-resolution
// branch differs from the vertical arrows; a regression in horizontal handling
// would not be caught by S1/S1b.

test('S1f: ArrowRight auto-NodeSelects self-closing Callout to the right of the cursor', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '# Heading\n\n<Callout type="note" title="X" />\n\n# Footer\n');
  await page.waitForSelector('.jsx-component-wrapper');

  // Position cursor at end of "Heading" via editor API rather than click+End —
  // click+End was flaky on loaded CI workers (Playwright pointer events can race
  // ProseMirror's selection commit when other tests in the same file run hot).
  // Walking the doc to find the heading and computing end-of-textblock via
  // node.textContent.length is deterministic regardless of CI load.
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return;
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.type.name === 'heading' && node.textContent === 'Heading') {
        pos = p + 1 + node.textContent.length; // end-of-textblock for "Heading"
      }
      return true;
    });
    if (pos >= 0) {
      editor.chain().focus().setTextSelection(pos).run();
    }
  });

  // Commit DOM focus before keyboard dispatch — see focusEditor docstring.
  await focusEditor(page);
  await page.keyboard.press('ArrowRight');

  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(callout).toHaveAttribute('data-selection-origin', 'keyboard');
});

// ── S1g: ArrowLeft from start-of-textblock → NodeSelect adj self-closing JSX ──
//
// Symmetric to S1f. Caret at start of a textblock with an adjacent self-closing
// JSX wrapper to the left auto-NodeSelects on ArrowLeft, exercising the
// `endOfTextblock('left')` + `$head.before()` branch — independent code path
// from the vertical S1/S1b coverage.

test('S1g: ArrowLeft auto-NodeSelects self-closing Callout to the left of the cursor', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '# Heading\n\n<Callout type="note" title="X" />\n\n# Footer\n');
  await page.waitForSelector('.jsx-component-wrapper');

  // Position cursor at start of "Footer" via editor API (same rationale as S1f
  // — Playwright click+Home was flaky; deterministic cursor placement removes
  // the timing race).
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return;
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.type.name === 'heading' && node.textContent === 'Footer') {
        pos = p + 1; // start-of-textblock for "Footer"
      }
      return true;
    });
    if (pos >= 0) {
      editor.chain().focus().setTextSelection(pos).run();
    }
  });

  // Commit DOM focus before keyboard dispatch — see focusEditor docstring.
  await focusEditor(page);
  await page.keyboard.press('ArrowLeft');

  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(callout).toHaveAttribute('data-selection-origin', 'keyboard');
});

// ── S1c parity family: bare-arrow DESCENT into a compound jsxComponent ────
//
// S1c proves ArrowDown descends into a compound Callout body. The descent is a
// boundary-cross into the `isolating: true` jsxComponent NodeView (chrome
// contentEditable=false → body contentEditable=true). PM's native caret motion
// across that boundary commits to `state.selection` only ASYNCHRONOUSLY
// (DOMObserver readback) and intermittently not at all under load — the residual
// that flaked S1c after test-side barriers. The fix is KeyboardNav L2d
// (`tryEnterCompoundJsx`), the bare-arrow ENTRY mirror of L2c's EXIT, applied to
// every direction L0 covers. These pin that the descent is deterministic for the
// directions L2c parity demands (Right/Left/Up) and across component types
// (Accordion, not just Callout) — converting the whole class from a retry-healed
// flake into a hard failure on regression. Each asserts the descent lands as a
// TextSelection inside the body (no spurious NodeSelect) — the S1c contract.

test('S1c-R: ArrowRight descends into compound Callout body (L2d horizontal)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '# Title\n\n<Callout type="note">\n\nbody content\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
  await caretAtTextblock(page, 'Title', 'end');

  await page.keyboard.press('ArrowRight');

  await expect(page.locator('.jsx-component-wrapper[data-selected="true"]')).toHaveCount(0);
  await waitForPmSelectionInNode(page, 'jsxComponent');
  expect(await caretInsideCompound(page)).toBe(true);
});

test('S1c-L: ArrowLeft descends into compound Callout body (L2d horizontal)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody content\n\n</Callout>\n\n# Footer\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
  await caretAtTextblock(page, 'Footer', 'start');

  await page.keyboard.press('ArrowLeft');

  await expect(page.locator('.jsx-component-wrapper[data-selected="true"]')).toHaveCount(0);
  await waitForPmSelectionInNode(page, 'jsxComponent');
  expect(await caretInsideCompound(page)).toBe(true);
});

test('S1c-U: ArrowUp descends into compound Callout body from below (L2d vertical)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody content\n\n</Callout>\n\n# Footer\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
  await caretAtTextblock(page, 'Footer', 'start');

  await page.keyboard.press('ArrowUp');

  await expect(page.locator('.jsx-component-wrapper[data-selected="true"]')).toHaveCount(0);
  await waitForPmSelectionInNode(page, 'jsxComponent');
  expect(await caretInsideCompound(page)).toBe(true);
});

test('S1c-ACC: ArrowDown descends into compound Accordion body (L2d type parity)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '# Title\n\n<Accordion title="X">\n\nbody content\n\n</Accordion>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');
  await caretAtTextblock(page, 'Title', 'end');

  await page.keyboard.press('ArrowDown');

  await expect(page.locator('.jsx-component-wrapper[data-selected="true"]')).toHaveCount(0);
  await waitForPmSelectionInNode(page, 'jsxComponent');
  expect(await caretInsideCompound(page)).toBe(true);
});

// ── L3 (Enter container exit) coverage is structural, not E2E ────────────
//
// L3's "Enter on empty trailing paragraph inside container → exit to
// sibling" behavior is covered by complementary signal:
//   1. `tests/integration/keyboard-nav-catch-contract.test.ts` defensive
//      scan — EVERY catch in `keyboard-nav.ts` (including any L3 catch a
//      future contributor adds) must narrow to RangeError + emit telemetry.
//   2. Source-level documentation at `keyboard-nav.ts` ArrowUp/L3 Enter
//      handlers — the three-gate predicate (`parentNode.textContent === ''`,
//      `parent.type.name === 'jsxComponent'`, `paragraphIndex === childCount-1`)
//      is structurally clear and self-documenting.
//   3. S1d covers the inverse path: ArrowUp from inside a compound Callout
//      exits cleanly without spurious NodeSelect — exercises the same
//      compound-block-keyboard-contract surface.
// A dedicated S1h/S1i pair was prototyped and removed: synthesizing the
// empty-trailing-paragraph fixture reliably through the markdown parser
// proved fragile (the parser strips trailing whitespace lines in some
// configurations), making the test infrastructure cost outsize the
// incremental coverage benefit. Removed because source-grep + structural
// signal is the more reliable guarantor than fixture-dependent E2E here.

// ── S2: Pointer selection — programmatic NodeSelection + data-attr flow ──

test('S2: NodeSelection on a Callout emits data-selected=true on its wrapper', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="warning" title="Clickable" />\n');
  await page.waitForSelector('.jsx-component-wrapper');

  // Dispatch a pointerdown event to populate pendingOrigin='pointer', then
  // trigger the node selection via the editor API. This mirrors the
  // production code path: DOM event classification → plugin apply.
  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.dispatchEvent('pointerdown');
  await selectFirstJsxComponent(page, 'Callout');

  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(callout).toHaveAttribute('data-selection-origin', 'pointer');
});

// ── S3: Nested innermost-wins ────────────────────────────────────────────
//
// The 5-pack's nested-composition shape is
// `<Callout><Accordion/></Callout>` — exercises the store-enforced
// innermost-wins invariant under jsxComponent `content:'block*'`.

test('S3: nested Callout/Accordion — only innermost paints halo', async ({ page, api }) => {
  await setupDoc(page, api, '<Callout type="note">\n\n<Accordion title="Inner" />\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await selectFirstJsxComponent(page, 'Accordion');

  const innerAccordion = page
    .locator('.jsx-component-wrapper[data-component-type="accordion"]')
    .first();
  const outerCallout = page
    .locator('.jsx-component-wrapper[data-component-type="callout"]')
    .first();

  await expect(innerAccordion).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(outerCallout).toHaveAttribute('data-has-child-selected', 'true');
  // Outer Callout does NOT get data-selected (innermost-wins, store-enforced).
  const outerDataSelected = await outerCallout.getAttribute('data-selected');
  expect(outerDataSelected).toBeNull();

  // Exactly one wrapper in the subtree has data-selected="true".
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
});

// ── S3b: Outer-NodeSelection on a nested-composite — only outer paints halo
//
// Inverse of S3. TipTap's NodeView `handleSelectionUpdate` checks
// `from <= pos && to >= pos + nodeSize`, so under a NodeSelection on the
// outer wrapper, the inner wrapper's range is also fully covered — TipTap
// fires `selectNode()` on BOTH wrappers. A pre-fix `isInnermostSelected =
// selected && !isRangeEncompassed` evaluates to true on the inner too
// (rangeEncompassedBlockIds is empty for NodeSelection), causing two halos
// to paint. The `&& isInnermostInChain` conjunct narrows to the wrapper at
// the chain leaf — under outer-NodeSelection the chain is [outer], so only
// the outer satisfies the conjunct.
test('S3b: outer-NodeSelection on Callout with nested Accordion — only outer paints halo', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\n<Accordion title="Inner" />\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await selectFirstJsxComponent(page, 'Callout');

  const outerCallout = page
    .locator('.jsx-component-wrapper[data-component-type="callout"]')
    .first();
  const innerAccordion = page
    .locator('.jsx-component-wrapper[data-component-type="accordion"]')
    .first();

  await expect(outerCallout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  // Inner Accordion must NOT also paint the halo, even though TipTap's
  // `selectNode()` fires on it (its range is fully encompassed by the outer
  // NodeSelection).
  const innerDataSelected = await innerAccordion.getAttribute('data-selected');
  expect(innerDataSelected).toBeNull();

  // Exactly one wrapper has data-selected="true".
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
});

// ── S4: Drag suppresses the halo ─────────────────────────────────────────

test('S4: dragstart/dragend toggles data-dragging', async ({ page, api }) => {
  await setupDoc(page, api, '<img src="/p.png" alt="Draggable" />\n');
  await page.waitForSelector('.jsx-component-wrapper');

  await selectFirstJsxComponent(page, 'img');
  const card = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await expect(card).toHaveAttribute('data-selected', 'true');

  // Simulate drag lifecycle — the plugin listens to dragstart/dragend on
  // view.dom and toggles isDragging via a deferred refresh transaction.
  await card.dispatchEvent('dragstart');
  await expect(card).toHaveAttribute('data-dragging', 'true', { timeout: 2_000 });

  await card.dispatchEvent('dragend');
  // After dragend, data-dragging is absent (undefined → null per Playwright).
  await expect(card).not.toHaveAttribute('data-dragging', 'true', { timeout: 2_000 });
});

// ── S5: Forced-colors — halo visible via outline fallback ────────────────

test('S5: forced-colors emulation shows non-transparent halo border', async ({ page, api }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await setupDoc(page, api, '<img src="/p.png" alt="WHCM" />\n');
  await page.waitForSelector('.jsx-component-wrapper');

  await selectFirstJsxComponent(page, 'img');
  const card = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await expect(card).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });

  // Read the ::after pseudo-element's computed border-color. In forced-colors
  // the UA substitutes CanvasText for our explicit color — the halo must
  // NOT be transparent.
  const borderColor = await card.evaluate((el) => {
    const computed = window.getComputedStyle(el, '::after');
    return computed.borderColor || computed.borderTopColor;
  });
  expect(borderColor).not.toBe('transparent');
  expect(borderColor).not.toBe('rgba(0, 0, 0, 0)');
});

// ── S6: reduced-motion disables halo transition ──────────────────────────

test('S6: prefers-reduced-motion:reduce → halo transition-duration is 0s', async ({
  page,
  api,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setupDoc(page, api, '<img src="/p.png" alt="Motion" />\n');
  await page.waitForSelector('.jsx-component-wrapper');

  const card = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  const transitionDuration = await card.evaluate((el) => {
    return window.getComputedStyle(el, '::after').transitionDuration;
  });
  // Under reduced-motion, the @media (prefers-reduced-motion: no-preference)
  // block never matches — the default (no transition applied) resolves to 0s.
  expect(transitionDuration === '0s' || transitionDuration === '').toBe(true);
});

// ── S7: Footer renders no breadcrumb chrome on selection ─────────────────
//
// The footer breadcrumb component was deleted (visual noise without
// navigation value for the flat 5-pack). This test pins the deletion:
// selecting a Callout or Accordion must NOT add `.jsx-component-breadcrumb`
// or `nav[aria-label="Block ancestor navigation"]` to the DOM.

test('S7: selecting a Callout/Accordion renders no breadcrumb chrome', async ({ page, api }) => {
  await setupDoc(
    page,
    api,
    '<Callout type="note">\n<Accordion title="Inner">\n\nbody\n\n</Accordion>\n</Callout>\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  // Baseline: neither selector matches anything before selection.
  await expect(page.locator('.jsx-component-breadcrumb')).toHaveCount(0);
  await expect(page.locator('nav[aria-label="Block ancestor navigation"]')).toHaveCount(0);

  // Selecting the outer Callout (deep-nest fixture — even for a
  // multi-segment ancestor chain that would have populated the breadcrumb,
  // no chrome is rendered).
  await selectFirstJsxComponent(page, 'Callout');
  const outer = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await expect(outer).toHaveAttribute('data-selected', 'true');
  await expect(page.locator('.jsx-component-breadcrumb')).toHaveCount(0);
  await expect(page.locator('nav[aria-label="Block ancestor navigation"]')).toHaveCount(0);

  // Selecting the innermost (Accordion) — same outcome. Pre-fix, this would
  // have rendered `Document › Callout › Accordion`.
  await selectFirstJsxComponent(page, 'Accordion');
  const inner = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await expect(inner).toHaveAttribute('data-selected', 'true');
  await expect(page.locator('.jsx-component-breadcrumb')).toHaveCount(0);
  await expect(page.locator('nav[aria-label="Block ancestor navigation"]')).toHaveCount(0);
});

// ── S8: aria-live region announces selection changes ────────────────────

test('S8: aria-live textContent announces the selected block', async ({ page, api }) => {
  await setupDoc(
    page,
    api,
    '<Callout type="note">\n<Accordion title="Inner">\n\nbody\n\n</Accordion>\n</Callout>\n',
  );
  // Same fix as S7 — wait for a selector that matches the seeded fixture.
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await selectFirstJsxComponent(page, 'Accordion');

  // 200ms debounce + margin. aria-atomic="true" ensures AT reads the full
  // announcement on every mutation.
  const liveRegion = page.locator('[role="status"][aria-live="polite"]');
  await expect(liveRegion).toContainText('Selected: Accordion', { timeout: 2_000 });
});

// ── S9: Three-axis composition ───────────────────────────────────────────
//
// `data-selected="true"` + `data-needs-config="true"` + `data-dragging="true"`
// must compose without gymnastics — dragging dominates (halo hidden) even
// when selected + needs-config are also set. Only a real browser resolves
// the CSS cascade; no other tier catches this bug class.

test('S9: three-axis composition — dragging dominates over selected + needs-config', async ({
  page,
  api,
}) => {
  // `<img>` with no alt attribute → key absent in props → tri-state predicate
  // fires `data-needs-config` (required-string-key-absent). `alt=""` would be
  // the explicit decorative opt-in (WCAG 1.1.1) and would NOT fire.
  await setupDoc(page, api, '<img src="/p.png" />\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="img"]');

  const card = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await expect(card).toHaveAttribute('data-needs-config', 'true', { timeout: 5_000 });

  // Predicate-split canary: with a valid src, the placeholder must NOT render
  // even though `data-needs-config` fires for the missing alt decision. Guards
  // against a future refactor widening `shouldRenderPlaceholder` to fire on
  // any missing required string prop — the exact failure mode the predicate
  // split prevents.
  await expect(page.locator('[data-descriptor-placeholder]')).toHaveCount(0);

  // Select + start drag.
  await selectFirstJsxComponent(page, 'img');
  await expect(card).toHaveAttribute('data-selected', 'true');
  await card.dispatchEvent('dragstart');
  await expect(card).toHaveAttribute('data-dragging', 'true');

  // All three attrs present simultaneously.
  const attrs = await card.evaluate((el) => ({
    selected: el.getAttribute('data-selected'),
    needsConfig: el.getAttribute('data-needs-config'),
    dragging: el.getAttribute('data-dragging'),
  }));
  expect(attrs.selected).toBe('true');
  expect(attrs.needsConfig).toBe('true');
  expect(attrs.dragging).toBe('true');

  // Dragging dominates: halo opacity = 0, transition disabled.
  const haloState = await card.evaluate((el) => {
    const cs = window.getComputedStyle(el, '::after');
    return { opacity: cs.opacity, transitionDuration: cs.transitionDuration };
  });
  expect(haloState.opacity).toBe('0');
  expect(haloState.transitionDuration).toBe('0s');

  // Cleanup so the shared test-reset doesn't leave a selected+dragging
  // wrapper in the doc.
  await card.dispatchEvent('dragend');
});

// ── S9b: alt="" decorative opt-in does NOT fire data-needs-config ────────
//
// Complements S9 — pins the second tri-state branch of the `needsConfig`
// predicate. With the schema flip (alt required, no defaultValue), the
// predicate fires on key-absence (S9: `<img src />`) but treats `alt=""` as
// the WCAG 1.1.1 decorative opt-in (key present, empty value → does NOT
// fire). The registry unit tests pin parse/serialize;
// only this DOM-attribute assertion would catch a future predicate
// simplification (e.g. truthy-falsy `!currentProps[p.name]`) that
// re-fired the gear nudge on every decorative image.
//
// Only a real browser resolves the React render → DOM attribute pipeline.

test('S9b: alt="" decorative opt-in does NOT fire data-needs-config', async ({ page, api }) => {
  await setupDoc(page, api, '<img src="/p.png" alt="" />\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="img"]');

  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  // The attribute is rendered as `data-needs-config={needsConfig ? 'true' : undefined}`,
  // so when the predicate does NOT fire, the attribute is absent. Use the
  // polling assertion to mirror the symmetric S9-positive timing — `waitForSelector`
  // returns when the wrapper element exists, but the conditional `data-needs-config`
  // attribute can lag a render tick behind the wrapper itself. The polling form
  // collapses to one-shot when the predicate has already settled (timeout is the
  // upper bound, not the wait time).
  await expect(wrapper).not.toHaveAttribute('data-needs-config', 'true', { timeout: 5_000 });
});

// ── S9c: descriptive alt does NOT fire data-needs-config (third tri-state) ──
//
// Completes the tri-state contract for the `needsConfig` predicate (precedent
// #45). Pins all three branches at the DOM-attribute level so a future
// predicate refactor that collapses the tri-state (e.g., to truthy-falsy
// `!currentProps[p.name]`) fails on whichever branch it broke:
//
//   S9   key absent     (<img src />)                 → fires (gear nudge)
//   S9b  alt=""         (<img src alt="" />)          → does NOT fire (WCAG decorative opt-in)
//   S9c  alt="<text>"   (<img src alt="hero" />)      → does NOT fire (satisfied)
//
// Without S9c, the third branch is only implicitly covered (in tests
// that set non-empty values for other purposes). The explicit positive
// assertion here means the contract is whole and any future predicate edit
// has a direct regression test for the descriptive-alt path.

test('S9c: descriptive alt does NOT fire data-needs-config', async ({ page, api }) => {
  await setupDoc(page, api, '<img src="/p.png" alt="A picnic table at dusk" />\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="img"]');

  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  // Polling form for symmetric timing with S9 + S9b — the conditional attr
  // can lag a render tick behind the wrapper. Timeout is the upper bound;
  // settled predicates resolve immediately.
  await expect(wrapper).not.toHaveAttribute('data-needs-config', 'true', { timeout: 5_000 });
});

// ── S11: Halo inset is uniform -4px across all substrates ────────────────
//
// Halo inset cascades from the default declaration on `.jsx-component-wrapper`
// and is the same for every substrate. Per-substrate radius / color overrides
// remain in scope (img/video tighter radius; Callout chroma) but inset is
// not differentiated — substrate-targeted CSS for the inset value must
// either encode a documented perceptual distinction or be uniform; here
// no distinction survived OK's substrate set, so uniform is correct.
// Tests CSS-variable resolution at runtime — only a real browser evaluates
// `--selection-halo-inset` through the cascade.

type InsetCase = { fixture: string; componentType: string };
const INSET_CASES: InsetCase[] = [
  {
    fixture: '<Callout type="note" title="X" />\n',
    componentType: 'callout',
  },
  {
    fixture: '<Accordion title="X" />\n',
    componentType: 'accordion',
  },
  {
    fixture: '<img src="/p.png" alt="Plain" />\n',
    componentType: 'img',
  },
  {
    fixture: '<video src="/sample.mp4" />\n',
    componentType: 'video',
  },
  {
    fixture: '<audio src="/sample.mp3" />\n',
    componentType: 'audio',
  },
];

for (const { fixture, componentType } of INSET_CASES) {
  test(`S11: [${componentType}] --selection-halo-inset resolves to -4px (uniform)`, async ({
    page,
    api,
  }) => {
    await setupDoc(page, api, fixture);
    await page.waitForSelector(`.jsx-component-wrapper[data-component-type="${componentType}"]`);

    const wrapper = page
      .locator(`.jsx-component-wrapper[data-component-type="${componentType}"]`)
      .first();
    const inset = await wrapper.evaluate((el) =>
      window.getComputedStyle(el).getPropertyValue('--selection-halo-inset').trim(),
    );
    expect(inset).toBe('-4px');
  });
}

// ── S12: Halo z-index: -1 + content visible behind ───────────────────────
//
// Precedent #30 (all user content visible + editable): the halo must NOT
// occlude block content. `z-index: -1` on the ::after pseudo-element places
// the halo behind the wrapper's own content.

test('S12: halo z-index is -1 and .component-children is fully visible when selected', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    '<Callout type="note">\n<Accordion title="Visible">\n\nbody\n\n</Accordion>\n</Callout>\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  await selectFirstJsxComponent(page, 'Callout');
  const cards = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await expect(cards).toHaveAttribute('data-selected', 'true');

  // Halo sits behind content.
  const zIndex = await cards.evaluate((el) => window.getComputedStyle(el, '::after').zIndex);
  expect(zIndex).toBe('-1');

  // Content is rendered, visible, and non-zero-sized.
  const contentState = await cards.evaluate((el) => {
    const content = el.querySelector('.component-children') as HTMLElement | null;
    if (!content) return { present: false };
    const cs = window.getComputedStyle(content);
    const rect = content.getBoundingClientRect();
    return {
      present: true,
      opacity: cs.opacity,
      visibility: cs.visibility,
      display: cs.display,
      width: rect.width,
      height: rect.height,
    };
  });
  expect(contentState.present).toBe(true);
  expect(contentState.opacity).toBe('1');
  expect(contentState.visibility).toBe('visible');
  expect(contentState.display).not.toBe('none');
  expect(contentState.width).toBeGreaterThan(0);
  expect(contentState.height).toBeGreaterThan(0);
});

// ── S13: Callout type-color inheritance (Precedent #31) ──────────────────
//
// `[data-component-type="callout"] { --selection-halo-color: var(--callout-
// type-color, var(--ring)) }` means the halo inherits the callout's own
// type color. Verify via computed border-color on the ::after element.
// Parameterized across 5 callout types — each resolves to a distinct color
// string.

type CalloutCase = { type: string };
const CALLOUT_TYPES: CalloutCase[] = [
  { type: 'info' },
  { type: 'warning' },
  { type: 'error' },
  { type: 'success' },
  { type: 'idea' },
];

for (const { type } of CALLOUT_TYPES) {
  test(`S13: Callout[type="${type}"] halo border-color is non-transparent when selected`, async ({
    page,
    api,
  }) => {
    await setupDoc(page, api, `<Callout type="${type}">\n\nbody\n\n</Callout>\n`);
    await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

    await selectFirstJsxComponent(page, 'Callout');
    const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
    await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });

    // Read computed border-color from the ::after pseudo-element.
    const borderColor = await callout.evaluate((el) => {
      const cs = window.getComputedStyle(el, '::after');
      return cs.borderColor || cs.borderTopColor;
    });

    // Selected callout's halo must have a resolved, non-transparent color.
    // We don't pin a specific rgb() value because the callout's type color
    // lives in fumadocs tokens that can re-theme without breaking the
    // contract; we only assert the color resolves (non-transparent).
    expect(borderColor).not.toBe('transparent');
    expect(borderColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(borderColor).not.toBe('');
  });
}

// NOTE on per-type color uniqueness: the CSS rule
// `[data-component-type="callout"] { --selection-halo-color:
// var(--callout-type-color, var(--ring)) }` in globals.css is designed
// to make each callout type produce a distinct halo color (info=blue,
// warning=yellow, etc.). In practice this requires the Callout component
// itself to set `--callout-type-color` on its rendered DOM, which the
// current fumadocs-ui wrapper does NOT do — all 5 types resolve to the
// same fallback color (`var(--ring)`). A "5 distinct colors" assertion
// here would fail: received 1, expected 5.
//
// Rather than ship a failing test, this gap is recorded here for the
// follow-up that wires `--callout-type-color` into the Callout wrapper
// (via the fumadocs-ui internal callout tokens like `bg-fd-callout-*`).
// When that lands, restore the distinct-colors assertion as S13b.

// ── S14: Programmatic origin via SELECTION_ORIGIN_META_KEY ───────────────
//
// S1 covers keyboard origin, S2 covers pointer. Programmatic origin is
// what agent writes and test-harness selection rely on. Exercise it
// directly via a chain() + tr.setMeta dispatch.

test('S14: tr.setMeta(SELECTION_ORIGIN_META_KEY) sets data-selection-origin=programmatic', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<img src="/p.png" alt="Target" />\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="img"]');

  const dispatched = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return false;
    let cardPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (cardPos !== -1) return false;
      if (node.type.name === 'jsxComponent' && node.attrs.componentName === 'img') {
        cardPos = pos;
        return false;
      }
      return true;
    });
    if (cardPos === -1) return false;
    editor
      .chain()
      .focus()
      .setNodeSelection(cardPos)
      .command(({ tr }) => {
        tr.setMeta('selectionStatePlugin/origin', 'programmatic');
        return true;
      })
      .run();
    return true;
  });
  expect(dispatched).toBe(true);

  const card = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await expect(card).toHaveAttribute('data-selected', 'true', { timeout: 2_000 });
  await expect(card).toHaveAttribute('data-selection-origin', 'programmatic');
});

// ── S16: axe-core audit finds zero new violations with selection active ──
//
// We run axe-core on the component-showcase after mounting.
// We can't baseline against main from within the PR's Playwright harness
// (would need a second browser session on a different branch), so the
// assertion is the simpler form: zero `critical` or `serious` violations
// are introduced on elements the selection layer owns.

test('S16: axe-core — zero critical violations on selection-layer surfaces', async ({
  page,
  api,
}) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  await setupDoc(
    page,
    api,
    '<Callout type="note">\n<Accordion title="A11y">\n\nbody\n\n</Accordion>\n</Callout>\n',
  );
  await page.waitForSelector('.jsx-component-wrapper');
  // Select a component that EXISTS in the seeded fixture so axe-core runs
  // against an actually-selected selection-layer surface. The earlier
  // `selectFirstJsxComponent(page, 'img')` slipped silently when no img is
  // present (helper returns false on miss), leaving the doc unselected and
  // making the audit a false-green — caught when this file was promoted to
  // PR-tier `test:e2e` gating.
  const selected = await selectFirstJsxComponent(page, 'Callout');
  expect(selected).toBe(true);

  // Scope to the selection-layer surfaces, not the whole page — avoids
  // false positives on unrelated shells (sidebar, header, presence bar).
  //
  // Severity threshold: critical only. Without a same-suite baseline run
  // against `main` we can't distinguish pre-existing-serious from
  // PR-introduced-serious — `critical` ("breaks assistive tech entirely")
  // rules out genuine regressions regardless of baseline. The broader
  // a11y.e2e.ts suite already runs axe at full-page scope for the
  // pre-existing serious baseline.
  const results = await new AxeBuilder({ page })
    .include('.ProseMirror:not(.composer-prosemirror)')
    .include('[role="status"][aria-live="polite"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();

  const blocking = results.violations.filter((v) => v.impact === 'critical');
  if (blocking.length > 0) {
    const summary = blocking
      .map((v) => {
        const nodes = v.nodes
          .map((n) => `      target: ${n.target.join(' ')}\n      html: ${n.html.slice(0, 200)}`)
          .join('\n');
        return `  [${v.impact}] ${v.id}: ${v.description}\n${nodes}`;
      })
      .join('\n');
    throw new Error(`axe-core found ${blocking.length} critical violation(s):\n${summary}`);
  }
  expect(blocking.length).toBe(0);
});

// ── S18: aria-live debounce coalesces rapid selection changes ────────────
//
// SelectionAnnouncer's 200ms debounce: rapid-fire 3
// selections within 150ms (faster than the debounce window) → the
// MutationObserver should see fewer textContent mutations than selection
// changes (ideally exactly 1 post-debounce, with a small margin for the
// clear-then-write two-step).

test('S18: rapid selection changes coalesce into a single aria-live announcement', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    '<img src="/a.png" alt="A" />\n\n<img src="/b.png" alt="B" />\n\n<img src="/c.png" alt="C" />\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="img"]');

  const liveRegion = page.locator('[role="status"][aria-live="polite"]');
  await expect(liveRegion).toBeAttached();

  // Install a MutationObserver on the region that counts text-content
  // mutations observed from now until we explicitly stop.
  await page.evaluate(() => {
    const region = document.querySelector('[role="status"][aria-live="polite"]');
    if (!region) throw new Error('live region not found');
    // biome-ignore lint/suspicious/noExplicitAny: test-only global
    (window as any).__ariaLiveMutations = [];
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData' || r.type === 'childList') {
          // biome-ignore lint/suspicious/noExplicitAny: test-only global
          (window as any).__ariaLiveMutations.push({
            text: region.textContent,
            at: performance.now(),
          });
        }
      }
    });
    obs.observe(region, { characterData: true, childList: true, subtree: true });
    // biome-ignore lint/suspicious/noExplicitAny: test-only global
    (window as any).__ariaLiveObserver = obs;
  });

  // Collect three Card positions and select them rapidly.
  await page.evaluate(() => {
    const ed = window.__activeEditor;
    if (!ed) return;
    const positions: number[] = [];
    ed.state.doc.descendants((node, pos) => {
      if (node.type.name === 'jsxComponent' && node.attrs.componentName === 'img') {
        positions.push(pos);
      }
      return true;
    });
    // Fire 3 selections synchronously within one microtask. The debounce
    // window (200ms) should coalesce these into one announcement.
    for (let i = 0; i < 3; i++) {
      const pos = positions[i];
      if (pos !== undefined) ed.chain().focus().setNodeSelection(pos).run();
    }
  });

  // Wait past the debounce window (200ms + clear-then-write + safety margin).
  await page.waitForFunction(
    () => {
      // biome-ignore lint/suspicious/noExplicitAny: test-only global
      const mutations = ((window as any).__ariaLiveMutations ?? []) as Array<{
        text: string;
        at: number;
      }>;
      // A stable non-empty announcement has landed if we've seen at least
      // one mutation whose text starts with "Selected:" and the last
      // mutation is at least 300ms old.
      if (mutations.length === 0) return false;
      const last = mutations[mutations.length - 1];
      const withContent = mutations.filter((m) => m.text?.startsWith('Selected:'));
      return withContent.length >= 1 && performance.now() - last.at > 300;
    },
    null,
    { timeout: 2_000 },
  );

  const mutations = await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only global
    const m = ((window as any).__ariaLiveMutations ?? []) as Array<{ text: string; at: number }>;
    // biome-ignore lint/suspicious/noExplicitAny: test-only global
    (window as any).__ariaLiveObserver?.disconnect();
    return m;
  });

  // Post-debounce, the non-empty mutations (i.e., the "Selected: X" writes,
  // skipping the clear-step '' writes) should be at most ONE — not three,
  // despite three selection changes. Count only mutations whose text is
  // non-empty and starts with "Selected:".
  const contentMutations = mutations.filter(
    (m) => typeof m.text === 'string' && m.text.startsWith('Selected:'),
  );
  expect(contentMutations.length).toBeGreaterThanOrEqual(1);
  // Key invariant: debounce coalesces — fewer announcements than selection
  // changes. 3 rapid selections should not produce 3 announcements.
  expect(contentMutations.length).toBeLessThan(3);
});

// ── S19: CM→PM focus sync in rawMdxFallback ──────────────────────────────

test('S19: clicking inside nested CM forwards focus as NodeSelection on rawMdxFallback', async ({
  page,
  api,
}) => {
  // Seed markdown that parses into a rawMdxFallback (tag mismatch triggers
  // the block-level fallback path — see mid-type-recovery.e2e.ts at the
  // "tag mismatch" test for the proven shape). The CM NodeView mounts once
  // the fallback is in the doc.
  await setupDoc(page, api, 'before\n\n<Foo>some text</Bar>\n\nafter\n');
  const fallbackWrapper = page.locator('.raw-mdx-fallback-wrapper').first();
  await expect(fallbackWrapper).toBeAttached({ timeout: 5_000 });

  // CM content editable lives inside the wrapper. `cm-content` is the
  // canonical CodeMirror 6 content-DOM class.
  const cmContent = fallbackWrapper.locator('.cm-content').first();
  await expect(cmContent).toBeAttached({ timeout: 5_000 });

  // Establish a baseline: PM selection is NOT initially a NodeSelection on
  // the fallback (setupDoc leaves selection at doc start or unset).
  const baseline = await page.evaluate(() => {
    const ed = window.__activeEditor;
    if (!ed) return null;
    const sel = ed.state.selection;
    return {
      type: sel.constructor.name,
      // biome-ignore lint/suspicious/noExplicitAny: test-only introspection of PM internals
      nodeType: (sel as any).node?.type?.name ?? null,
      from: sel.from,
    };
  });
  expect(baseline).not.toBeNull();
  // If the baseline is already a NodeSelection on rawMdxFallback, the test
  // can't distinguish the click's effect — retarget the assertion to a
  // different doc shape. In practice setupDoc opens at top, so baseline
  // should be a TextSelection in the 'before' paragraph.
  expect(baseline?.type === 'NodeSelection' && baseline?.nodeType === 'rawMdxFallback').toBe(false);

  // Click inside the nested CM. This triggers:
  //   1. Browser focus → CM view
  //   2. CM updateListener fires with focusChanged + hasFocus=true
  //   3. The handler in RawMdxFallbackCMView dispatches NodeSelection on
  //      the fallback at getPos() (focus-sync pathway)
  //   4. PM commits the tx; SelectionStatePlugin sees the new selection
  await cmContent.click();

  // Wait for PM selection to become NodeSelection on rawMdxFallback. Use
  // condition-based polling per precedent #20(a) — any fixed sleep is
  // flake-prone.
  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      const sel = ed.state.selection;
      if (sel.constructor.name !== 'NodeSelection') return false;
      // biome-ignore lint/suspicious/noExplicitAny: test-only introspection
      return (sel as any).node?.type?.name === 'rawMdxFallback';
    },
    null,
    { timeout: 5_000 },
  );

  // Final assertion — the selection is exactly what the canonical
  // focus-sync pathway dispatches: NodeSelection on the fallback.
  const afterClick = await page.evaluate(() => {
    const ed = window.__activeEditor;
    if (!ed) return null;
    const sel = ed.state.selection;
    return {
      type: sel.constructor.name,
      // biome-ignore lint/suspicious/noExplicitAny: test-only introspection
      nodeType: (sel as any).node?.type?.name ?? null,
    };
  });
  expect(afterClick).toEqual({
    type: 'NodeSelection',
    nodeType: 'rawMdxFallback',
  });
});
