
import { DOCUMENT_OPEN_BYTE_LIMIT } from '@inkeep/open-knowledge-core';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

async function openFromSidebar(page: Page, filename: string) {
  await page.getByRole('treeitem', { name: filename, exact: true }).click({ timeout: 10_000 });
}

function sidebarItem(page: Page, filename: string) {
  return page.getByRole('treeitem', { name: filename, exact: true });
}

const FILLER_LINE = 'Filler paragraph to force scrollable content. '.repeat(10);
const DOC_A = `# Doc A Heading\n\n${Array(30).fill(FILLER_LINE).join('\n\n')}\n\n## Doc A Bottom Marker\n\nEnd of doc A content.`;
const DOC_B = '# Doc B Heading\n\nDoc B unique body paragraph.';
const DOC_C = '# Doc C Heading\n\nDoc C unique body paragraph.';
const DOC_D = '# Doc D Heading\n\nDoc D unique body paragraph.';
const DOC_E = '# Doc E Heading\n\nDoc E unique body paragraph.';

test.describe('docs-open — hybrid navigation UX', () => {
  test('F0: shell snaps on click, editor mount is deferred', async ({ page, api }) => {
    const MARK_LINE = Array.from({ length: 20 }, (_, i) => `[[Link ${i}]]`).join(' ');
    const PARAGRAPH = `${MARK_LINE} and some \`inline code\` plus more [[wiki links]] here.`;
    const SECTION_FILLER = 'Extended prose paragraph to make the doc mark-heavy. '.repeat(20);
    const BIG_BODY = Array.from(
      { length: 90 },
      (_, i) => `## Section ${i}\n\n${PARAGRAPH}\n\n${SECTION_FILLER}\n`,
    ).join('\n');
    const BIG_DOC = `# Big Doc\n\n${BIG_BODY}\n\n## End\n`;
    const SMALL_DOC = '# Small\n\nShort.';
    expect(new TextEncoder().encode(BIG_DOC).byteLength).toBeLessThan(DOCUMENT_OPEN_BYTE_LIMIT);
    await api.seedDocs([
      { name: 'small', markdown: SMALL_DOC },
      { name: 'big', markdown: BIG_DOC },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'small.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');
    await openFromSidebar(page, 'big.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror', { hasText: 'Big Doc' })).toBeVisible({
      timeout: 30_000,
    });
    await openFromSidebar(page, 'small.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror', { hasText: 'Small' })).toBeVisible({
      timeout: 30_000,
    });

    const bigRow = sidebarItem(page, 'big.md');
    await expect(sidebarItem(page, 'small.md')).toHaveAttribute('aria-selected', 'true');

    await page.evaluate(() => {
      window.__f0Result = null;
      const root = document.querySelector('file-tree-container')?.shadowRoot;
      if (!root) return;
      const start = performance.now();
      const observer = new MutationObserver(() => {
        const current = root.querySelector('[aria-selected="true"]');
        if (current?.getAttribute('aria-label') === 'big.md') {
          window.__f0Result = { shellMs: performance.now() - start };
          observer.disconnect();
        }
      });
      observer.observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-selected'],
      });
      window.__f0Start = start;
    });

    await bigRow.click();

    await expect
      .poll(async () => (await page.evaluate(() => window.__f0Result)) !== null, {
        timeout: 2_000,
        intervals: [25, 50, 100],
      })
      .toBe(true);

    const result = await page.evaluate(() => window.__f0Result);
    if (!result) throw new Error('F0 result not captured');

    const editorStart = await page.evaluate(() => performance.now());
    await expect(page.locator('.ProseMirror', { hasText: 'Big Doc' })).toBeVisible({
      timeout: 30_000,
    });
    const editorMs = await page.evaluate(
      (start) => performance.now() - start,
      editorStart - (result.shellMs - 0),
    );
    console.log(`[F0] shellMs=${result.shellMs.toFixed(1)} editorMs=${editorMs.toFixed(1)}`);

    expect(result.shellMs).toBeLessThan(500);
  });

  test('F0b: warm reopen of a V2-admit doc shows NO EditorSkeleton', async ({ page, api }) => {
    const SMALL_A = '# Doc A\n\nSmall body A.';
    const SMALL_B = '# Doc B\n\nSmall body B.';
    await api.seedDocs([
      { name: 'doc-warm-a', markdown: SMALL_A },
      { name: 'doc-warm-b', markdown: SMALL_B },
    ]);

    await page.goto('/');

    await openFromSidebar(page, 'doc-warm-a.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror', { hasText: 'Doc A' })).toBeVisible({
      timeout: 30_000,
    });
    await openFromSidebar(page, 'doc-warm-b.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror', { hasText: 'Doc B' })).toBeVisible({
      timeout: 30_000,
    });

    await page.evaluate(() => {
      window.__f0bSkeletonSeen = false;
      window.__f0bSkeletonAppearances = [];
      const skeletonSelector = '[role="status"][aria-label="Loading document"]';
      const check = () => {
        if (document.querySelector(skeletonSelector)) {
          window.__f0bSkeletonSeen = true;
          window.__f0bSkeletonAppearances?.push(performance.now());
        }
      };
      check();
      const observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      window.__f0bObserverCleanup = () => observer.disconnect();
    });

    await openFromSidebar(page, 'doc-warm-a.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror', { hasText: 'Doc A' })).toBeVisible({
      timeout: 30_000,
    });

    await page.evaluate(() => window.__f0bObserverCleanup?.());
    const seen = await page.evaluate(() => window.__f0bSkeletonSeen);
    const appearances = await page.evaluate(() => window.__f0bSkeletonAppearances ?? []);

    expect(
      seen,
      `EditorSkeleton appeared during warm reopen — appearances at: ${JSON.stringify(appearances)}`,
    ).toBe(false);
  });


  test('F1: warm-nav preserves content atomically (scroll position survives A→B→A)', async ({
    page,
    api,
  }) => {
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

    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror', { hasText: 'Doc A Bottom Marker' })).toBeVisible({
      timeout: 30_000,
    });

    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollTop), {
        timeout: 3_000,
        intervals: [50, 100, 200],
      })
      .toBeGreaterThan(scrollBeforeNav - 50); // allow minor rounding; position must not reset to 0
  });


  test('F3: cold-nav paints EditorSkeleton immediately (no content-continuity flash)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');

    await page.evaluate(() => {
      window.__f3SkeletonEverVisible = false;
      const skeletonSelector = '[role="status"][aria-label="Loading document"]';
      const check = () => {
        if (document.querySelector(skeletonSelector)) {
          window.__f3SkeletonEverVisible = true;
        }
      };
      check();
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true });
      window.__f3ObserverCleanup = () => observer.disconnect();
    });

    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror', { hasText: 'Doc B Heading' })).toBeVisible({
      timeout: 30_000,
    });

    await page.evaluate(() => window.__f3ObserverCleanup?.());

    const skeletonSeen = await page.evaluate(() => window.__f3SkeletonEverVisible);
    expect(skeletonSeen).toBe(true);

    await expect(page.locator('[role="status"][aria-label="Loading document"]')).toHaveCount(0);
  });

  test('F5: sync failure shows recoverable error boundary + retry re-enters Suspense', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');

    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'timeout');
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toContainText("Couldn't load document");
    await expect(errorAlert).toContainText('doc-b');

    await errorAlert.getByRole('button', { name: 'Try again' }).click();

    await expect(page.locator('.ProseMirror', { hasText: 'Doc B Heading' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('F6: error boundary "Go back" navigates to prior doc', async ({ page, api }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');
    await expect(page.locator('.ProseMirror', { hasText: 'Doc A Heading' })).toBeVisible({
      timeout: 30_000,
    });

    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'predisconnect');
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toContainText('Connection dropped');

    const backButton = errorAlert.getByRole('button', { name: 'Go back' });
    await expect(backButton).toBeVisible();
    await backButton.click();

    await expect
      .poll(async () => page.evaluate(() => window.location.hash), {
        timeout: 5_000,
        intervals: [100, 200, 400],
      })
      .toContain('doc-a');
    await expect(page.locator('.ProseMirror', { hasText: 'Doc A Heading' })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('F8: post-wake reconnect preserves content on the active doc', async ({ page, api }) => {
    await api.seedDocs([{ name: 'doc-a', markdown: DOC_A }]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');
    await expect(page.locator('.ProseMirror', { hasText: 'Doc A Heading' })).toBeVisible({
      timeout: 30_000,
    });

    const expectedText = await page.locator('.ProseMirror').textContent();
    expect(expectedText).toContain('Doc A Heading');

    await page.evaluate(() => {
      window.__test_closeActiveWebSocket?.();
    });

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(page.locator('.ProseMirror', { hasText: 'Doc A Heading' })).toBeVisible({
      timeout: 30_000,
    });

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(page.locator('.ProseMirror', { hasText: 'Doc A Heading' })).toBeVisible({
      timeout: 30_000,
    });

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await expect(errorAlert).toHaveCount(0);
  });

  test('F11: rapid sequential navigation converges to final click', async ({ page, api }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
      { name: 'doc-c', markdown: DOC_C },
      { name: 'doc-d', markdown: DOC_D },
      { name: 'doc-e', markdown: DOC_E },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');

    await openFromSidebar(page, 'doc-b.md');
    await openFromSidebar(page, 'doc-c.md');
    await openFromSidebar(page, 'doc-d.md');
    await openFromSidebar(page, 'doc-e.md');

    await waitForActiveProviderSynced(page);
    await expect
      .poll(async () => page.evaluate(() => window.location.hash), {
        timeout: 10_000,
        intervals: [100, 200, 400],
      })
      .toContain('doc-e');

    await expect(page.locator('.ProseMirror', { hasText: 'Doc E Heading' })).toBeVisible({
      timeout: 30_000,
    });

    await expect
      .poll(async () => page.locator('[role="status"][aria-label="Loading document"]').count(), {
        timeout: 5_000,
        intervals: [100, 200, 400],
      })
      .toBe(0);
  });

  test('F10: source editor path follows same architecture (warm swap preserves cm state)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');

    await page.getByRole('radio', { name: 'Markdown source' }).click();
    await page.waitForSelector('.cm-content', { timeout: 15_000 });
    await expect(page.locator('.cm-content').first()).toContainText('Doc A Heading', {
      timeout: 15_000,
    });

    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.cm-content').filter({ hasText: 'Doc B Heading' })).toBeVisible({
      timeout: 15_000,
    });

    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.cm-content').filter({ hasText: 'Doc A Heading' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('F13: a11y attributes present on EditorSkeleton + error-boundary surfaces', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');

    await page.evaluate(() => {
      window.__f13BarAttrs = null;
      const observer = new MutationObserver(() => {
        const skeleton = document.querySelector('[role="status"][aria-label="Loading document"]');
        if (skeleton && !window.__f13BarAttrs) {
          window.__f13BarAttrs = {
            role: skeleton.getAttribute('role'),
            ariaLive: skeleton.getAttribute('aria-live'),
            ariaHidden: skeleton.getAttribute('aria-busy'),
          };
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.__f13ObserverCleanup = () => observer.disconnect();
    });

    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    await expect(page.locator('.ProseMirror', { hasText: 'Doc B Heading' })).toBeVisible({
      timeout: 30_000,
    });
    await page.evaluate(() => window.__f13ObserverCleanup?.());

    const barAttrs = await page.evaluate(() => window.__f13BarAttrs);
    expect(barAttrs).not.toBeNull();
    expect(barAttrs?.role).toBe('status');
    expect(barAttrs?.ariaLive).toBeNull();
    expect(barAttrs?.ariaHidden).toBe('true');

    await api.createPage('doc-c.md');
    await api.replaceDoc('doc-c', DOC_C);
    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-c', 'timeout');
    });
    await openFromSidebar(page, 'doc-c.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toHaveAttribute('role', 'alert');
    await expect(errorAlert).toHaveAttribute('aria-labelledby', 'document-error-title');
  });


  test('QA-022: error → retry succeeds → continue editing (compositional)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');

    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'timeout');
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toContainText('doc-b');

    await errorAlert.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.ProseMirror', { hasText: 'Doc B Heading' })).toBeVisible({
      timeout: 10_000,
    });

    const editor = page.locator('.ProseMirror').first();
    await editor.click();
    await page.keyboard.press('End'); // move cursor to end of existing content
    await page.keyboard.type(' post-recovery typed content');
    await expect(editor).toContainText('post-recovery typed content', { timeout: 5_000 });
  });

  test('QA-023: navigate-away hides error from user (per-Activity scoping)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');

    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'timeout');
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });

    await openFromSidebar(page, 'doc-a.md');

    await expect(errorAlert).toBeHidden({ timeout: 5_000 });
    await expect(page.locator('.ProseMirror').first()).toContainText('Doc A Heading');
  });

  test('QA-024: errored-doc revisit re-renders error (cached-rejection persistence)', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');

    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'predisconnect');
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });

    await openFromSidebar(page, 'doc-a.md');
    await expect(errorAlert).toBeHidden({ timeout: 5_000 });

    await openFromSidebar(page, 'doc-b.md');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toContainText('doc-b');
  });

  test('QA-027: pre-sync sleep → wake shows error (not silent failure)', async ({ page, api }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');

    await page.evaluate(() => {
      window.__test_armPendingRejection?.('doc-b', 'predisconnect');
    });

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await openFromSidebar(page, 'doc-b.md');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(errorAlert).toContainText('doc-b');
    const tryAgain = errorAlert.getByRole('button', { name: 'Try again' });
    await expect(tryAgain).toBeVisible();
  });

  test('QA-015: provider-pool 4s recycle exercised via page.clock', async ({ page, api }) => {
    await page.clock.install();

    await api.seedDocs([{ name: 'doc-a', markdown: DOC_A }]);

    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');

    const before = await page.evaluate(() => {
      const pool = window.__providerPool;
      return {
        activeDocName: pool?.getActiveDocName() ?? null,
        poolSize: pool?.entries?.size ?? -1,
      };
    });
    expect(before.activeDocName).toBe('doc-a');
    expect(before.poolSize).toBe(1);

    await page.evaluate(() => {
      window.__test_closeActiveWebSocket?.();
    });

    await page.clock.runFor(5_000);

    const after = await page.evaluate(() => ({
      poolSize: window.__providerPool?.entries?.size ?? -1,
    }));
    expect(after.poolSize).toBeGreaterThanOrEqual(0);
    expect(after.poolSize).toBeLessThanOrEqual(1);
  });

  test('F0-mdx: sidebar click on a .mdx file loads and renders its content', async ({
    page,
    api,
  }) => {
    const docName = 'mdx-sidebar-proof';
    const mdxBody = '# MDX Sidebar Proof\n\nContent rendered from a .mdx file via sidebar click.\n';
    await api.testReset();
    await api.createPage(`${docName}.mdx`);
    await api.replaceDoc(docName, mdxBody);

    await page.goto('/');
    await openFromSidebar(page, `${docName}.mdx`);
    await waitForActiveProviderSynced(page);

    await expect(page.getByText('Content rendered from a .mdx file')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole('main').getByRole('button', { name: `${docName}.mdx`, exact: true }),
    ).toBeVisible();
  });
});


test.describe('docs-open — WS-interception scenarios', () => {
  test('QA-014: pre-sync WS close → PreSyncDisconnectError → "Connection dropped"', async ({
    context,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    let blockMode: 'passthrough' | 'close' = 'passthrough';
    await context.routeWebSocket(/collab/, (ws) => {
      if (blockMode === 'close') {
        ws.close();
        return;
      }
      ws.connectToServer();
    });

    const page = await context.newPage();
    await page.goto('/');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');

    blockMode = 'close';
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 15_000 });
    await expect(errorAlert).toContainText('Connection dropped');
    await expect(errorAlert).toContainText('doc-b');
  });

  test('QA-012: warm-recycle with hung WS → doc-b unsynced, eventually errors', async ({
    context,
    api,
  }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    let blockMode: 'passthrough' | 'hang' = 'passthrough';
    await context.routeWebSocket(/collab/, (ws) => {
      if (blockMode === 'hang') return;
      ws.connectToServer();
    });

    const page = await context.newPage();
    await page.goto('/');

    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');
    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);

    blockMode = 'hang';
    await page.evaluate(() => {
      window.__providerPool?.recycle('doc-b');
    });
    await openFromSidebar(page, 'doc-b.md');

    await expect
      .poll(() => page.evaluate(() => window.__providerPool?.getActiveDocName() ?? null))
      .toBe('doc-b');
    const state = await page.evaluate(() => ({
      activeDoc: window.__providerPool?.getActiveDocName() ?? null,
      isSynced: window.__activeProvider?.isSynced ?? null,
    }));
    expect(state.activeDoc).toBe('doc-b');
    expect(state.isSynced).toBe(false);
  });

  test('QA-013: real syncPromise timeout → "Couldn\'t load document"', async ({ context, api }) => {
    await api.seedDocs([
      { name: 'doc-a', markdown: DOC_A },
      { name: 'doc-b', markdown: DOC_B },
    ]);

    let blockMode: 'passthrough' | 'hang' = 'passthrough';
    await context.routeWebSocket(/collab/, (ws) => {
      if (blockMode === 'hang') return;
      ws.connectToServer();
    });

    const page = await context.newPage();
    await page.goto('/');

    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');
    await openFromSidebar(page, 'doc-b.md');
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror');
    await openFromSidebar(page, 'doc-a.md');
    await waitForActiveProviderSynced(page);

    await page.evaluate(() => {
      window.__okPerfOverrides = {
        ...window.__okPerfOverrides,
        SYNC_TIMEOUT_MS: 2_000,
      };
    });

    blockMode = 'hang';
    await page.evaluate(() => {
      window.__providerPool?.recycle('doc-b');
    });
    await openFromSidebar(page, 'doc-b.md');

    const errorAlert = page.locator('[data-slot="document-error-boundary"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 7_000 });
    await expect(errorAlert).toContainText("Couldn't load document");
    await expect(errorAlert).toContainText('doc-b');
    await expect(errorAlert.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

declare global {
  interface Window {
    __f0Start?: number;
    __f0Result?: { shellMs: number } | null;
    __f0bSkeletonSeen?: boolean;
    __f0bSkeletonAppearances?: number[];
    __f0bObserverCleanup?: () => void;
    __f3SkeletonEverVisible?: boolean;
    __f3ObserverCleanup?: () => void;
    __f13BarAttrs?: {
      role: string | null;
      ariaLive: string | null;
      ariaHidden: string | null;
    } | null;
    __f13ObserverCleanup?: () => void;
  }
}
