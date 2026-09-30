import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';

interface ParagraphCue {
  fragments: number;
  cues: number;
  html: string;
}

async function readParagraphCue(page: Page, needle: string): Promise<ParagraphCue> {
  return page.evaluate((text: string) => {
    const editor = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
    const para = Array.from(editor?.querySelectorAll('p') ?? []).find((p) =>
      (p.textContent ?? '').includes(text),
    );
    if (!para) return { fragments: 0, cues: 0, html: 'no paragraph' };
    const cues = [para, ...Array.from(para.querySelectorAll('*'))].filter((el) =>
      (window.getComputedStyle(el, '::after').content || '').includes('↗'),
    ).length;
    return {
      fragments: para.querySelectorAll('[data-resolution-state="external"]').length,
      cues,
      html: para.innerHTML,
    };
  }, needle);
}

test.describe('the leaves-the-workspace cue marks the end of a link, once', () => {
  test('a peer caret standing inside an autolinked URL does not multiply the cue', async ({
    browser,
    api,
    baseURL,
  }) => {
    const docName = `test-link-cue-caret-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);

    const ctxA = await browser.newContext({ baseURL });
    const ctxB = await browser.newContext({ baseURL });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await Promise.all([pageA.goto(`/#/${docName}`), pageB.goto(`/#/${docName}`)]);
      await Promise.all([waitForActiveProviderSynced(pageA), waitForActiveProviderSynced(pageB)]);
      await Promise.all([pageA.waitForSelector(EDITOR), pageB.waitForSelector(EDITOR)]);

      await pageA.locator(EDITOR).click();
      await pageA.keyboard.type('http://www.google.com ');
      await pageA.waitForFunction(
        () =>
          JSON.stringify(window.__activeEditor?.state.doc.toJSON() ?? {}).includes('"type":"link"'),
        null,
        { timeout: 10_000 },
      );

      await pageB.waitForFunction(
        () =>
          (
            document.querySelector('.ProseMirror:not(.composer-prosemirror)')?.textContent ?? ''
          ).includes('www.google.com'),
        null,
        { timeout: 10_000 },
      );
      await pageB.locator(EDITOR).click();
      await pageB.waitForFunction(() => window.__activeEditor?.isFocused === true);
      await pageB.evaluate(() => window.__activeEditor?.commands.setTextSelection(12));

      await pageA.waitForSelector(`${EDITOR} span[data-link] .collaboration-cursor__caret`, {
        timeout: 15_000,
      });

      const seen = await readParagraphCue(pageA, 'google.com');
      expect(
        seen.fragments,
        `link was not split, the guard is vacuous: ${seen.html}`,
      ).toBeGreaterThan(1);
      expect(seen.cues, `cue rendered ${seen.cues} times: ${seen.html}`).toBe(1);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('every external link in a paragraph keeps its own cue', async ({ page, api }) => {
    const docName = `test-link-cue-many-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(
      docName,
      'Go [one](https://one.example.com) and [two](https://two.example.com), then [three](https://three.example.com)[four](https://four.example.com).\n',
    );
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await page.waitForSelector(EDITOR);
    await page.waitForFunction(
      () =>
        (
          document.querySelector('.ProseMirror:not(.composer-prosemirror)')?.textContent ?? ''
        ).includes('four'),
      null,
      { timeout: 10_000 },
    );

    await expect
      .poll(async () => (await readParagraphCue(page, 'four')).fragments, { timeout: 10_000 })
      .toBe(4);
    const seen = await readParagraphCue(page, 'four');
    expect(seen.cues, `cues: ${seen.html}`).toBe(4);
  });
});
