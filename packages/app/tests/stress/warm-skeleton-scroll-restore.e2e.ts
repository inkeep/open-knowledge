import { expect, test, waitForActiveProviderSynced } from './_helpers';

const FILLER_LINE = 'Filler paragraph to force scrollable content. '.repeat(8);
function makeScrollableDoc(headingPrefix: string): string {
  const sections = Array.from(
    { length: 120 },
    (_, i) => `## ${headingPrefix} Section ${i + 1}\n\n${FILLER_LINE}`,
  );
  return [`# ${headingPrefix} Heading`, '', ...sections].join('\n\n');
}

type ActiveEditorProbe = {
  state: { doc: { content: { size: number } }; selection: { anchor: number } };
  commands: { setTextSelection: (pos: number) => void };
};
function readActiveEditorAnchor(): number {
  const ed = (window as unknown as { __activeEditor?: ActiveEditorProbe }).__activeEditor;
  return ed?.state.selection.anchor ?? 0;
}

test.describe('warm-skeleton rename restoration', () => {
  test('scroll position and cursor selection are preserved across rename of the open doc', async ({
    page,
    api,
    baseURL,
  }) => {
    await api.seedDocs([
      { name: 'tall-doc', markdown: makeScrollableDoc('Tall') },
      { name: 'small-anchor', markdown: '# Small\n\nShort doc, no scroll.' },
    ]);

    await page.goto('/');
    const sidebar = page.locator('[data-slot="sidebar-container"]');

    await sidebar.getByRole('treeitem', { name: 'tall-doc.md', exact: true }).click({
      timeout: 10_000,
    });
    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Tall Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    const capturedAnchor = await page.evaluate(() => {
      const ed = (window as unknown as { __activeEditor?: ActiveEditorProbe }).__activeEditor;
      if (!ed) return null;
      const pos = Math.min(800, ed.state.doc.content.size - 2);
      ed.commands.setTextSelection(pos);
      return ed.state.selection.anchor;
    });
    expect(capturedAnchor).not.toBeNull();
    expect(capturedAnchor as number).toBeGreaterThan(100);

    const scrollContainer = page.locator('[data-testid="editor-scroll-container"]');
    await expect(scrollContainer).toBeVisible({ timeout: 10_000 });

    const TARGET_SCROLL = 1500;
    const scrolledTo = await scrollContainer.evaluate((el, t) => {
      el.scrollTop = t;
      return el.scrollTop;
    }, TARGET_SCROLL);

    expect(scrolledTo).toBeGreaterThan(500);

    const renameRes = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/rename-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'file', fromPath: 'tall-doc', toPath: 'tall-renamed' }),
      });
      return { status: r.status, body: await r.json() };
    }, baseURL);

    expect(renameRes.status).toBe(200);
    expect(renameRes.body.renamed).toEqual([
      { fromDocName: 'tall-doc', toDocName: 'tall-renamed' },
    ]);

    await expect(
      sidebar.getByRole('treeitem', { name: 'tall-renamed.md', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(sidebar.getByRole('treeitem', { name: 'tall-doc.md', exact: true })).toHaveCount(
      0,
      { timeout: 10_000 },
    );

    await waitForActiveProviderSynced(page);
    await expect(
      page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: 'Tall Heading' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    const newScrollContainer = page.locator('[data-testid="editor-scroll-container"]');
    await expect(newScrollContainer).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(async () => newScrollContainer.evaluate((el) => el.scrollTop), {
        timeout: 5_000,
        intervals: [50, 100, 200, 500],
      })
      .toBeGreaterThan(scrolledTo - 200);

    const restoredScrollTop = await newScrollContainer.evaluate((el) => el.scrollTop);
    expect(restoredScrollTop).toBeGreaterThan(0);

    const captured = capturedAnchor as number;
    await expect
      .poll(
        async () => {
          const anchor = await page.evaluate(readActiveEditorAnchor);
          return Math.abs(anchor - captured);
        },
        { timeout: 5_000, intervals: [50, 100, 200, 500] },
      )
      .toBeLessThan(10);
  });
});
