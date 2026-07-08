/**
 * IME composition into the nested-CodeMirror raw box under concurrent mutation
 * — Playwright + CDP `Input.imeSetComposition`.
 *
 * An unregistered `<CustomWidget>` auto-converts to a `rawMdxFallback` box: a
 * live nested CodeMirror editor whose NodeView sets `stopEvent: () => true`, so
 * ProseMirror never sees keystrokes typed inside it. Real IME composition
 * (CJK/accents) lands directly on that nested `.cm-content`, and CodeMirror's
 * DOM path — not ProseMirror's — owns the composition. The seam of interest is
 * the PM→CM content sync in `RawMdxFallbackCMView.tsx`: when the box's PM
 * `textContent` changes externally (a remote/Observer-B edit, an agent write),
 * a `useEffect` dispatches the delta straight into the live CodeMirror view
 * with no `composing` gate. This exercises what happens when that external
 * dispatch (or a full remount) lands WHILE the user is mid-composition.
 *
 * Requires a real browser + CDP: there is no jsdom path to a live IME
 * composition, and the app CodeMirror NodeView only mounts under the React
 * portal infra a real browser provides. `Input.imeSetComposition` +
 * `Input.insertText` is the only way to drive a genuine composition
 * (`view.composing === true` at dispatch time) rather than a synthetic
 * keystroke, which would not set the composing flag and so would not exercise
 * the seam at all.
 *
 * Two concurrent-mutation shapes are exercised, because they reach the box by
 * different code paths:
 *   - An INCREMENTAL in-place Y.Text edit (what a remote peer's delta becomes
 *     after CRDT sync — the Observer-B path). This preserves the box's element
 *     identity, so the NodeView is NOT remounted and the live PM→CM `useEffect`
 *     fires INTO the composing CodeMirror view. This is the direct seam.
 *   - A full-document agent `replaceDoc`. Its reparse hands the box a new
 *     element, so the whole NodeView remounts mid-composition.
 *
 * Both are asserted at real fidelity via the CRDT convergence oracle
 * (`getText('source')`): the composed glyph must survive exactly once (no drop,
 * no duplication) and the concurrent write must survive too.
 *
 * This file IS in the CI `test:e2e` subset (the unregistered browser tier runs
 * under `check:full:parallel`).
 */

import { randomUUID } from 'node:crypto';
import type { CDPSession, Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import { expect, test } from './_helpers';

interface FallbackNode {
  type: { name: string };
  attrs: Record<string, unknown>;
  textContent: string;
}

// A CJK string chosen so a dropped, duplicated, or truncated composition is
// unambiguous in the serialized source. The concurrent marker is ASCII and
// disjoint from the glyph so their presence is independently observable.
const GLYPH = '日本語';
const MARKER = 'CONCURRENTZZZ';

async function setupBox(page: Page, api: ApiHelpers): Promise<string> {
  const docName = `ime-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, '<CustomWidget>\n\nAAA\n\n</CustomWidget>\n');
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      let ok = false;
      ed.state.doc.descendants((n: FallbackNode) => {
        if (
          n.type.name === 'rawMdxFallback' &&
          (n.attrs?.reason as string)?.includes('CustomWidget')
        )
          ok = true;
      });
      return ok;
    },
    null,
    { timeout: 8_000 },
  );
  return docName;
}

async function readYtext(page: Page): Promise<string> {
  return page.evaluate(
    () => window.__activeProvider?.document?.getText('source')?.toString() ?? '',
  );
}

/** Occurrences of `needle` in `haystack` — 0 = dropped, 1 = clean, ≥2 = duplicated. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Focus the nested CodeMirror content and place a collapsed caret at the very
 * end. A plain click resolves to a ProseMirror NodeSelection (the box's
 * focus-change listener), so the caret is placed via the DOM Selection API,
 * which CodeMirror's DOMObserver syncs into its own selection state.
 */
async function focusCmAtEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    const cm = document.querySelector(
      '.raw-mdx-fallback-wrapper .cm-content',
    ) as HTMLElement | null;
    if (!cm) throw new Error('.raw-mdx-fallback-wrapper .cm-content not found');
    cm.focus();
    const range = document.createRange();
    range.selectNodeContents(cm);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(document.activeElement?.closest('.raw-mdx-fallback-wrapper .cm-content')),
      ),
    )
    .toBe(true);
}

/**
 * Track composition start/end so a test can prove the nested editable is
 * genuinely mid-composition when the concurrent write fires — not settled. A
 * document-level capture listener catches the `compositionstart` CDP
 * `Input.imeSetComposition` dispatches on the focused `.cm-content` and
 * survives a NodeView remount. Without this, "the glyph survived once" could
 * green on a benign path where the composition had already ended before the
 * external dispatch, so the unguarded PM→CM seam was never actually exercised.
 */
async function installCompositionProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __imeDepth: number };
    w.__imeDepth = 0;
    document.addEventListener('compositionstart', () => (w.__imeDepth += 1), true);
    document.addEventListener('compositionend', () => (w.__imeDepth -= 1), true);
  });
}

/** True while an IME composition is in flight (an unmatched compositionstart). */
async function composing(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __imeDepth: number }).__imeDepth > 0);
}

/** Begin a marked IME composition at the current caret (not yet committed). */
async function beginComposition(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.imeSetComposition', {
    text: GLYPH,
    selectionStart: GLYPH.length,
    selectionEnd: GLYPH.length,
  });
}

/** Commit the in-flight composition (fires compositionend). */
async function commitComposition(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.insertText', { text: GLYPH });
}

test('FR-B3 baseline: CDP IME composes CJK into the nested raw box (harness + observable control)', async ({
  page,
  api,
}) => {
  await setupBox(page, api);
  await focusCmAtEnd(page);
  await installCompositionProbe(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    await beginComposition(cdp);
    // Non-vacuity: the harness drives a genuine composition (an unmatched
    // compositionstart is in flight), not an instant insert.
    expect(await composing(page)).toBe(true);
    await commitComposition(cdp);

    await expect.poll(() => readYtext(page)).toContain(GLYPH);
    const yt = await readYtext(page);
    // Harness proof: the composition lands exactly once.
    expect(occurrences(yt, GLYPH)).toBe(1);
    // Control: with no concurrent write, the marker is absent — so the
    // "marker survives" assertion in the concurrent arms below is reading the
    // real write, not a string that is always present.
    expect(yt.includes(MARKER)).toBe(false);
  } finally {
    await cdp.detach();
  }
});

test('FR-B3 Observer-B edit mid-composition: box stays mounted (live PM→CM seam), no glyph drop/dup, concurrent survives', async ({
  page,
  api,
}) => {
  await setupBox(page, api);

  // Tag the mounted CodeMirror element. If the box remounts, this element (and
  // its tag) is replaced; if it survives, the live [textContent] useEffect —
  // the unguarded PM→CM dispatch — is the path that ran.
  await page.evaluate(() => {
    const cm = document.querySelector('.raw-mdx-fallback-wrapper .cm-content');
    if (cm) (cm as HTMLElement).dataset.imeProbe = 'MOUNTED';
  });

  await focusCmAtEnd(page);
  await installCompositionProbe(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    await beginComposition(cdp);
    // Non-vacuity gate: the composition is in flight, so the incremental Y.Text
    // edit below dispatches through the unguarded PM→CM useEffect INTO a
    // composing view — the exact seam. Without this the arm could green on a
    // benign already-settled composition.
    expect(await composing(page)).toBe(true);

    // Incremental in-place Y.Text edit adjacent to the composition anchor —
    // what a remote peer's delta becomes after CRDT sync. Inserting right
    // before the closing tag keeps the box a rawMdxFallback while changing its
    // source, driving the Observer-B → node.textContent → live useEffect path.
    await page.evaluate((mark) => {
      const yt = window.__activeProvider?.document?.getText('source');
      if (!yt) throw new Error('no Y.Text');
      yt.insert(yt.toString().indexOf('</CustomWidget>'), `${mark} `);
    }, MARKER);
    await page.waitForFunction(
      (m) => window.__activeProvider?.document?.getText('source')?.toString()?.includes(m),
      MARKER,
      { timeout: 5_000 },
    );

    // The box stayed mounted through the external edit — the dispatch went into
    // the live composing view, not a fresh mount — and the composition is still
    // in flight, so the dispatch genuinely landed mid-composition.
    const tag = await page.evaluate(
      () =>
        (document.querySelector('.raw-mdx-fallback-wrapper .cm-content') as HTMLElement | null)
          ?.dataset.imeProbe ?? null,
    );
    expect(tag).toBe('MOUNTED');
    expect(await composing(page)).toBe(true);

    await commitComposition(cdp);

    await expect.poll(() => readYtext(page)).toContain(GLYPH);
    const yt = await readYtext(page);
    expect(occurrences(yt, GLYPH)).toBe(1); // no drop, no duplication
    expect(yt.includes(MARKER)).toBe(true); // the concurrent write survives
  } finally {
    await cdp.detach();
  }
});

test('FR-B3 agent write mid-composition: no glyph drop/dup, concurrent survives (box remounts)', async ({
  page,
  api,
}) => {
  const docName = await setupBox(page, api);
  await focusCmAtEnd(page);
  await installCompositionProbe(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    await beginComposition(cdp);
    // Non-vacuity: the agent write below lands while a composition is in flight
    // (the remount happens mid-composition, not after it settled).
    expect(await composing(page)).toBe(true);

    // A full-document agent write mid-composition. Its reparse hands the box a
    // new element (remount), a different path from the incremental edit above.
    await api.replaceDoc(docName, `<CustomWidget>\n\nAAA ${MARKER}\n\n</CustomWidget>\n`);
    await page.waitForFunction(
      (m) => window.__activeProvider?.document?.getText('source')?.toString()?.includes(m),
      MARKER,
      { timeout: 10_000 },
    );

    await commitComposition(cdp);

    await expect.poll(() => readYtext(page)).toContain(GLYPH);
    const yt = await readYtext(page);
    expect(occurrences(yt, GLYPH)).toBe(1); // no drop, no duplication
    expect(yt.includes(MARKER)).toBe(true); // the concurrent write survives
  } finally {
    await cdp.detach();
  }
});
