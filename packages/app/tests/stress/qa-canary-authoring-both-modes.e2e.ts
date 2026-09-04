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

test.describe('QA canary — authoring <Steps> across both modes', () => {
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
    await page.keyboard.type('\n<Steps>\n\n<Step>\n\nStep one body.\n\n', { delay: 12 });
    const mid = await readSource(page);
    expect(mid).toContain('<Steps>');
    expect(mid).toContain('Step one body.');
    await page.keyboard.type('</Step>\n\n</Steps>\n', { delay: 12 });
    await page.waitForFunction(
      () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('</Steps>'),
      null,
      { timeout: 10_000 },
    );
    const src = await readSource(page);
    expect(src).toContain('## Guide');
    expect((src.match(/Step one body\./g) ?? []).length).toBe(1);
    expect((src.match(/<Steps>/g) ?? []).length).toBe(1);
    expect((src.match(/<\/Steps>/g) ?? []).length).toBe(1);
    expect((src.match(/<Step>/g) ?? []).length).toBe(1);
  });

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
    await visualToggle(page).click();
    await page.waitForSelector('.ProseMirror:visible');
    const before = await structure(page);
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
    expect(minWildcard).toBe(before.wildcardCm);
    expect(maxFallback).toBe(before.rawFallback);
    expect(after.h2).toBe(before.h2);
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
    expect(src).toContain('Editable paragraph.NEWTEXT');
    expect((src.match(/<Step>/g) ?? []).length).toBe(1);
    expect((src.match(/<Steps>/g) ?? []).length).toBe(1);
    expect(src).not.toMatch(INDENTED_STEPS);
    expect(src.length).toBeLessThan(seed.length + 'NEWTEXT'.length + 32);
  });

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
    await page.getByText('Original step body.', { exact: false }).first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' EDITED', { delay: 40 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('EDITED'),
      null,
      { timeout: 10_000 },
    );
    const src = await readSource(page);
    expect(src).toContain('Original step body. EDITED');
    expect((src.match(/<Step>/g) ?? []).length).toBe(1);
    expect((src.match(/<Steps>/g) ?? []).length).toBe(1);
    expect(src).toContain('## Heading');
    expect(src).not.toMatch(INDENTED_STEPS);
    expect(src.length).toBeLessThan(seed.length + 32);
  });

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
    await page.keyboard.type('\n<Steps>\n\n<Step>\n\nMid build.\n', { delay: 12 });
    await page.waitForFunction(
      () =>
        window.__activeProvider?.document?.getText('source')?.toString()?.includes('Mid build.'),
      null,
      { timeout: 10_000 },
    );
    await visualToggle(page).click();
    await page.waitForSelector('.ProseMirror:visible');
    const broken = await readSource(page);
    expect(broken).toContain('## Title');
    expect(broken).toContain('Mid build.');
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
    expect(src).toContain('## Title');
    expect((src.match(/Mid build\./g) ?? []).length).toBe(1);
    expect((src.match(/<Steps>/g) ?? []).length).toBe(1);
    expect((src.match(/<\/Steps>/g) ?? []).length).toBe(1);
    expect((src.match(/<Step>/g) ?? []).length).toBe(1);
  });
});
