import { randomUUID } from 'node:crypto';
import type { CDPSession, Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import { expect, test } from './_helpers';

interface FallbackNode {
  type: { name: string };
  attrs: Record<string, unknown>;
  textContent: string;
}

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

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

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

async function installCompositionProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __imeDepth: number };
    w.__imeDepth = 0;
    document.addEventListener('compositionstart', () => (w.__imeDepth += 1), true);
    document.addEventListener('compositionend', () => (w.__imeDepth -= 1), true);
  });
}

async function composing(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __imeDepth: number }).__imeDepth > 0);
}

async function beginComposition(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.imeSetComposition', {
    text: GLYPH,
    selectionStart: GLYPH.length,
    selectionEnd: GLYPH.length,
  });
}

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
    expect(await composing(page)).toBe(true);
    await commitComposition(cdp);

    await expect.poll(() => readYtext(page)).toContain(GLYPH);
    const yt = await readYtext(page);
    expect(occurrences(yt, GLYPH)).toBe(1);
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

  await page.evaluate(() => {
    const cm = document.querySelector('.raw-mdx-fallback-wrapper .cm-content');
    if (cm) (cm as HTMLElement).dataset.imeProbe = 'MOUNTED';
  });

  await focusCmAtEnd(page);
  await installCompositionProbe(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    await beginComposition(cdp);
    expect(await composing(page)).toBe(true);

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
    expect(occurrences(yt, GLYPH)).toBe(1);
    expect(yt.includes(MARKER)).toBe(true);
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
    expect(await composing(page)).toBe(true);

    await api.replaceDoc(docName, `<CustomWidget>\n\nAAA ${MARKER}\n\n</CustomWidget>\n`);
    await page.waitForFunction(
      (m) => window.__activeProvider?.document?.getText('source')?.toString()?.includes(m),
      MARKER,
      { timeout: 10_000 },
    );

    await commitComposition(cdp);

    await expect.poll(() => readYtext(page)).toContain(GLYPH);
    const yt = await readYtext(page);
    expect(occurrences(yt, GLYPH)).toBe(1);
    expect(yt.includes(MARKER)).toBe(true);
  } finally {
    await cdp.detach();
  }
});
