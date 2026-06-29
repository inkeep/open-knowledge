
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

async function openFromSidebar(page: Page, filename: string) {
  await page.getByRole('treeitem', { name: filename, exact: true }).click({ timeout: 10_000 });
}

const FILLER_LINE = 'Filler paragraph to force scrollable content. '.repeat(10);
const DOC_A = `# Doc A Heading\n\n${Array(30).fill(FILLER_LINE).join('\n\n')}\n\n## Doc A Bottom Marker\n\nEnd of doc A content.`;
const DOC_B = '# Doc B Heading\n\nDoc B unique body paragraph.';

const PORTAL_APPEND_DELAY_PATCH = () => {
  const origAppendChild = Node.prototype.appendChild;
  let fireCount = 0;
  Node.prototype.appendChild = function <T extends Node>(this: Node, child: T): T {
    if (
      child instanceof HTMLElement &&
      typeof child.getAttribute === 'function' &&
      child.getAttribute('data-ok-editor-portal') !== null
    ) {
      fireCount += 1;
      (
        window as Window & { __okScrollRestoreTest_patchFireCount?: number }
      ).__okScrollRestoreTest_patchFireCount = fireCount;
      setTimeout(() => {
        origAppendChild.call(this, child);
      }, 250);
      return child;
    }
    return origAppendChild.call(this, child) as T;
  } as typeof Node.prototype.appendChild;
};

test.describe('docs-open-scroll-restore — F1 RED (deterministic via portal-append delay)', () => {
  test('F1-race: warm-nav scroll position survives A→B→A under content-late ordering', async ({
    page,
    api,
  }) => {
    await page.addInitScript(PORTAL_APPEND_DELAY_PATCH);

    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');

    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');
    await expect(page.locator('.ProseMirror', { hasText: 'Doc A Bottom Marker' })).toBeVisible({
      timeout: 30_000,
    });

    const scroller = page
      .getByTestId('editor-scroll-container')
      .filter({ hasText: 'Doc A Bottom Marker' });
    await scroller.evaluate((el) => {
      el.scrollTo({ top: 1500, behavior: 'instant' });
    });
    const scrollBeforeNav = await scroller.evaluate((el) => el.scrollTop);
    expect(scrollBeforeNav).toBeGreaterThan(500);

    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror', { hasText: 'Doc B Heading' })).toBeVisible({
      timeout: 30_000,
    });

    await page.evaluate(() => {
      (
        window as Window & { __okScrollRestoreTest_patchFireCount?: number }
      ).__okScrollRestoreTest_patchFireCount = 0;
    });

    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror', { hasText: 'Doc A Bottom Marker' })).toBeVisible({
      timeout: 30_000,
    });

    const patchFireCount = await page.evaluate(
      () =>
        (window as Window & { __okScrollRestoreTest_patchFireCount?: number })
          .__okScrollRestoreTest_patchFireCount ?? 0,
    );
    expect(
      patchFireCount,
      'monkey-patch never fired on the warm-nav path — `data-ok-editor-portal` attribute / portal append path changed in production code; this test no longer reproduces the F1 race deterministically. Re-check `EditorActivityPool.ActivityEntry`s portalTarget useState initializer and `TiptapEditor.portalSlotRef` useLayoutEffect.',
    ).toBeGreaterThan(0);

    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollTop), {
        timeout: 450,
        intervals: [25, 50, 100],
      })
      .toBeGreaterThan(scrollBeforeNav - 50); // allow minor rounding; position must not reset to 0

    const phase2SuccessMarkCount = await page.evaluate(
      () => performance.getEntriesByName('ok/scroll-restore/phase2-success').length,
    );
    expect(
      phase2SuccessMarkCount,
      'ok/scroll-restore/phase2-success mark not emitted — rAF-poll did not execute the restore. STEP 8 may have passed via Phase 1 sync write or some other mechanism; this test is specifically scoped to the rAF-poll path.',
    ).toBeGreaterThan(0);
  });
});
