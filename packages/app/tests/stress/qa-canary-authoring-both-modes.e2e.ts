/** QA canary — authoring nested <Steps> across BOTH editor modes, from scratch,
 *  keystroke by keystroke through the transient-invalid states.
 *
 *  As-built model: <Steps>/<Step> are unregistered (componentMap) -> they render
 *  via the wildcard editable raw-source view even when VALID. There is no client
 *  "freeze": server parseWithFallback never throws, so an invalid span renders as
 *  rawMdxFallback (client cross-CRDT write paths are deleted, precedent #14).
 *  Transient state = rawMdxFallback, NOT a freeze.
 *
 *  Covers all three real typing surfaces: source CM, WYSIWYG ProseMirror (prose
 *  around Steps), WYSIWYG wildcard CM (the Step itself), plus a mode-flip mid-build.
 *  Includes a JITTER probe: typing in clean prose must not flash the Steps render.
 *
 *  ORACLE NOTE: CM source-mode auto-indents JSX tags on Enter while authoring. The
 *  indented shape is a stable, lossless serialize fixed point, and the bridge never
 *  GLOBALLY re-indents. Assertions therefore check STRUCTURE + CONTENT INTEGRITY,
 *  never flush-left tags, for authored-from-scratch content; SEEDED Steps guard the
 *  OUTER container against the global re-indent write-back (a contended drain may
 *  re-emit the INNER tags at the canonical nested indentation — a lossless fixed
 *  point, not the corruption class; see the T2/T3 oracle notes).
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });
const visualToggle = (page: Page) => page.getByRole('radio', { name: 'Visual editor' });
// A GLOBAL re-indent write-back (the bug this suite guards) would indent the
// OUTER <Steps> container too. Both the wildcard raw-source box's own commit
// path and a contended freshness re-derive may locally re-emit the inner
// <Step> with standard nested-JSX indentation (lossless, stable fixed point)
// — that is not the corruption class. Guard the outer tag.
const INDENTED_STEPS = /\n[ \t]+<\/?Steps\b/;

const readSource = (page: Page) =>
  page.evaluate(() => window.__activeProvider?.document?.getText('source')?.toString() ?? '');

async function structure(page: Page) {
  return page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    return {
      h2: pm?.querySelectorAll('h2').length ?? 0,
      p: pm?.querySelectorAll('p').length ?? 0,
      rawFallback: document.querySelectorAll('[data-raw-mdx-fallback]').length,
      wildcardCm: document.querySelectorAll('.cm-editor').length,
    };
  });
}

let docName: string;
test.beforeEach(async ({ page, api }) => {
  docName = `qa-author-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror');
});

// These canaries are the field oracle for the source-typing
// duplication/re-indent race in the authoritative Y.Text: a source-mode-hidden
// WYSIWYG editor issuing an autonomous structural fragment replace of a
// <Steps>/<Step> span while server Observer B re-derives that span per
// keystroke, both inserts surviving the CRDT merge (duplicated bytes read from
// `provider.document.getText('source')`, never the DOM). The fix is symmetric:
// the client no longer mints the autonomous structural write from a hidden
// editor, and the server refuses to persist a provenance-confirmed doubled
// span. The race only surfaces under CPU contention (client apply-lag vs typing
// cadence), so validate these under load, not single-file.
test.describe('QA canary — authoring <Steps> across both modes', () => {
  // T1 — SOURCE: author the whole nested <Steps> from EMPTY, char-by-char, through
  // the unclosed-container transient, landing valid. Surrounding heading preserved.
  test('source: author nested <Steps> from empty; no whole-doc collapse, recovers to valid', async ({
    page,
    api,
  }) => {
    await api.replaceDoc(docName, '## Guide\n\nIntro paragraph.\n');
    await page.waitForFunction(
      () => document.querySelector('.ProseMirror')?.textContent?.includes('Guide'),
      null,
      { timeout: 10_000 },
    );
    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content');
    await page.locator('.cm-content:visible').click();
    await page.keyboard.press('ControlOrMeta+End');
    // Author the construct character-by-character (Enter via \n, real per-key delay).
    await page.keyboard.type('\n<Steps>\n\n<Step>\n\nStep one body.\n\n', { delay: 12 });
    // PAUSE mid-build: <Steps> + <Step> both unclosed — transient invalid.
    const mid = await readSource(page);
    expect(mid).toContain('<Steps>');
    expect(mid).toContain('Step one body.'); // live source shows what was typed
    // Finish closing both tags.
    await page.keyboard.type('</Step>\n\n</Steps>\n', { delay: 12 });
    await page.waitForFunction(
      () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('</Steps>'),
      null,
      { timeout: 10_000 },
    );
    const src = await readSource(page);
    expect(src).toContain('## Guide'); // surrounding heading NOT collapsed/lost
    expect((src.match(/Step one body\./g) ?? []).length).toBe(1); // body present, once (no dup)
    expect((src.match(/<Steps>/g) ?? []).length).toBe(1);
    expect((src.match(/<\/Steps>/g) ?? []).length).toBe(1);
    expect((src.match(/<Step>/g) ?? []).length).toBe(1);
    // NOTE: CM source-mode auto-indents tags on Enter while authoring nested JSX.
    // The indented shape is a stable serialize fixed point (parses as jsxComponent,
    // lossless) and the bridge never re-indents. So we assert structure + content
    // integrity, NOT flush-left tags — asserting flush-left here would be a false
    // oracle (indentation = CM UX, not corruption).
  });

  // T2 — WYSIWYG ProseMirror + JITTER PROBE: with a valid <Steps> + surrounding
  // prose, type a burst into a sibling paragraph; the Steps render must NOT flash
  // (fallback/CM count stable across the burst).
  test('wysiwyg: typing in prose adjacent to <Steps> does not flash the Steps render (jitter)', async ({
    page,
    api,
  }) => {
    const seed =
      '## Heading\n\nEditable paragraph.\n\n<Steps>\n\n<Step>\n\nStep body.\n\n</Step>\n\n</Steps>\n\nTrailing paragraph.\n';
    await api.replaceDoc(docName, seed);
    await page.waitForFunction(
      () => document.querySelector('.ProseMirror')?.textContent?.includes('Editable paragraph'),
      null,
      { timeout: 10_000 },
    );
    // Ensure WYSIWYG (visual) mode.
    await visualToggle(page).click();
    await page.waitForSelector('.ProseMirror:visible');
    const before = await structure(page);
    // Type into the editable paragraph (ProseMirror), char-by-char, sampling the
    // Steps render stability after each key.
    await page.getByText('Editable paragraph.', { exact: false }).first().click();
    await page.keyboard.press('End');
    let maxFallback = before.rawFallback;
    let minWildcard = before.wildcardCm;
    for (const ch of 'NEWTEXT') {
      await page.keyboard.type(ch, { delay: 60 });
      const s = await structure(page);
      maxFallback = Math.max(maxFallback, s.rawFallback);
      minWildcard = Math.min(minWildcard, s.wildcardCm);
    }
    const after = await structure(page);
    // Jitter oracle: the Steps wildcard-CM count never dropped (no unmount/flash)
    // and no NEW parse-error rawMdxFallback chrome appeared mid-burst.
    expect(minWildcard).toBe(before.wildcardCm); // Steps render never unmounted mid-type
    expect(maxFallback).toBe(before.rawFallback); // no parse-error fallback flashed in
    expect(after.h2).toBe(before.h2); // surrounding heading stable
    // Await the typed burst's settlement into authoritative Y.Text before any
    // byte assertion: the final keystrokes' server drain can lag the typing
    // loop under CPU contention, and an early read asserts a mid-flight state
    // (same settlement idiom as every sibling test in this file).
    await page.waitForFunction(
      () =>
        window.__activeProvider?.document
          ?.getText('source')
          ?.toString()
          ?.includes('Editable paragraph.NEWTEXT'),
      null,
      { timeout: 10_000 },
    );
    const src = await readSource(page);
    expect(src).toContain('Editable paragraph.NEWTEXT'); // edit landed contiguous
    expect((src.match(/<Step>/g) ?? []).length).toBe(1); // Steps intact, exactly once (no duplication)
    expect((src.match(/<Steps>/g) ?? []).length).toBe(1); // outer container intact, exactly once
    // Corruption oracle mirrors T3: reject the GLOBAL re-indent write-back
    // (the OUTER <Steps> gaining indentation) and content growth/duplication.
    // A contended drain may re-emit the user-untouched Steps span with the
    // INNER <Step> at standard nested-JSX indentation — a lossless, stable
    // serialize fixed point (parses identically, no content change), not the
    // corruption class. The strict inner flush-left byte-form is byte-stability
    // of an untouched construct — a bridge-splice concern with its own
    // dedicated coverage, not this canary's oracle.
    expect(src).not.toMatch(INDENTED_STEPS); // no write-back re-indent of the outer <Steps>
    // Slack derivation: the canonical inner re-emit adds at most 2-space
    // indentation on the 3 inner lines (+6) and drops up to 4 blank-line
    // newlines (-4) for this seed — 32 is a comfortable ceiling for any
    // cosmetic re-emit. The bound is defense-in-depth; the count assertions
    // above are the primary duplication oracle. Same constant as T3's bound.
    expect(src.length).toBeLessThan(seed.length + 'NEWTEXT'.length + 32); // no growth / duplication
  });

  // T3 — WYSIWYG wildcard CM: edit INSIDE the Step's raw-source box (the only
  // Step-editing surface in WYSIWYG), then assert it persists with no corruption.
  test('wysiwyg: editing inside the Step wildcard raw-source box persists, no corruption', async ({
    page,
    api,
  }) => {
    const seed = '## Heading\n\n<Steps>\n\n<Step>\n\nOriginal step body.\n\n</Step>\n\n</Steps>\n';
    await api.replaceDoc(docName, seed);
    await page.waitForFunction(
      () => document.querySelector('.ProseMirror')?.textContent?.includes('Original step body'),
      null,
      { timeout: 10_000 },
    );
    await visualToggle(page).click();
    await page.waitForSelector('.ProseMirror:visible');
    // The Step renders via the wildcard raw-source CM inside WYSIWYG.
    await page.getByText('Original step body.', { exact: false }).first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' EDITED', { delay: 40 });
    // Blur to trigger any upgrade/commit, then read the source bytes.
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('EDITED'),
      null,
      { timeout: 10_000 },
    );
    const src = await readSource(page);
    expect(src).toContain('Original step body. EDITED'); // edit landed, content preserved
    expect((src.match(/<Step>/g) ?? []).length).toBe(1); // no duplication
    expect((src.match(/<Steps>/g) ?? []).length).toBe(1);
    expect(src).toContain('## Heading'); // surrounding preserved
    // Committing the wildcard raw-source box re-serializes the Step subtree; the MDX
    // serializer emits nested-JSX children with standard 2-space indentation. That is
    // a lossless, stable serialize fixed point (content + structure round-trip
    // identically) — not corruption. The corruption to reject is a GLOBAL re-indent
    // write-back (the OUTER container gaining indentation) and content growth/dup:
    expect(src).not.toMatch(INDENTED_STEPS); // no write-back re-indent of the outer <Steps>
    expect(src.length).toBeLessThan(seed.length + 32); // no growth / duplication
  });

  // T4 — MODE-FLIP mid-build: type a partial (unclosed) <Steps> in source, flip to
  // WYSIWYG while broken, flip back, finish. No collapse, no corruption, recovers.
  test('mode-flip mid-build: unclosed <Steps> survives a WYSIWYG round-trip and recovers', async ({
    page,
    api,
  }) => {
    await api.replaceDoc(docName, '## Title\n\nBefore.\n');
    await page.waitForFunction(
      () => document.querySelector('.ProseMirror')?.textContent?.includes('Title'),
      null,
      { timeout: 10_000 },
    );
    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content');
    await page.locator('.cm-content:visible').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n<Steps>\n\n<Step>\n\nMid build.\n', { delay: 12 }); // UNCLOSED
    await page.waitForFunction(
      () =>
        window.__activeProvider?.document?.getText('source')?.toString()?.includes('Mid build.'),
      null,
      { timeout: 10_000 },
    );
    // Flip to WYSIWYG while the JSX is unclosed — must not collapse the doc.
    await visualToggle(page).click();
    await page.waitForSelector('.ProseMirror:visible');
    const broken = await readSource(page);
    expect(broken).toContain('## Title'); // surrounding heading survived the flip
    expect(broken).toContain('Mid build.'); // typed content survived
    // Flip back to source and finish closing the tags.
    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content');
    await page.locator('.cm-content:visible').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n</Step>\n\n</Steps>\n', { delay: 12 });
    await page.waitForFunction(
      () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('</Steps>'),
      null,
      { timeout: 10_000 },
    );
    const src = await readSource(page);
    expect(src).toContain('## Title'); // surrounding heading survived flip + finish
    expect((src.match(/Mid build\./g) ?? []).length).toBe(1); // content present, once
    expect((src.match(/<Steps>/g) ?? []).length).toBe(1);
    expect((src.match(/<\/Steps>/g) ?? []).length).toBe(1);
    expect((src.match(/<Step>/g) ?? []).length).toBe(1);
    // CM auto-indent (stable, lossless fixed point) — assert integrity, not flush-left.
  });
});
