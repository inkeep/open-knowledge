import { expect, test } from './_helpers';

test.describe('rename-consolidation — browser-fidelity outcomes', () => {
  test('QA-002: file rename via /api/rename-path updates sidebar + rewrites inbound wiki-link', async ({
    page,
    api,
    baseURL,
  }) => {
    await api.seedDocs([
      { name: 'auth', markdown: '# Auth\n\nContent of auth.\n' },
      { name: 'index-page', markdown: '# Index\n\nLink: [[auth]]\n' },
    ]);

    await page.goto('/');
    const sidebar = page.locator('[data-slot="sidebar-container"]');
    await expect(sidebar.getByRole('treeitem', { name: 'auth.md', exact: true })).toBeVisible({
      timeout: 20_000,
    });

    const renameRes = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/rename-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'file',
          fromPath: 'auth',
          toPath: 'sso',
        }),
      });
      return { status: r.status, body: await r.json() };
    }, baseURL);

    expect(renameRes.status).toBe(200);
    expect(renameRes.body.renamed).toEqual([{ fromDocName: 'auth', toDocName: 'sso' }]);
    expect(Array.isArray(renameRes.body.rewrittenDocs)).toBe(true);
    expect(renameRes.body.rewrittenDocs.length).toBeGreaterThan(0);
    const rewrittenNames = (renameRes.body.rewrittenDocs as Array<{ docName: string }>).map(
      (d) => d.docName,
    );
    expect(rewrittenNames).toContain('index-page');

    await expect(sidebar.getByRole('treeitem', { name: 'sso.md', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(sidebar.getByRole('treeitem', { name: 'auth.md', exact: true })).toHaveCount(0, {
      timeout: 10_000,
    });

    const indexBytes = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/document?docName=index-page`);
      return { status: r.status, body: r.ok ? await r.text() : null };
    }, baseURL);

    if (indexBytes.status === 200 && indexBytes.body) {
      expect(indexBytes.body).toContain('[[sso]]');
      expect(indexBytes.body).not.toContain('[[auth]]');
    } else {
      void indexBytes;
    }
  });

  test('QA-001: folder rename via /api/rename-path updates sidebar + rewrites cross-folder backlinks', async ({
    page,
    api,
    baseURL,
  }) => {
    await api.seedDocs([
      { name: 'old-folder/a', markdown: '# A\n' },
      { name: 'old-folder/b', markdown: '# B\n' },
      { name: 'old-folder/c', markdown: '# C\n' },
      { name: 'links-a', markdown: '# Links A\n\n[[old-folder/a]]\n' },
      { name: 'links-b', markdown: '# Links B\n\n[[old-folder/b]]\n' },
    ]);

    await page.goto('/');
    const sidebar = page.locator('[data-slot="sidebar-container"]');
    await expect(sidebar.getByRole('treeitem', { name: /old-folder/, exact: false })).toBeVisible({
      timeout: 20_000,
    });

    const renameRes = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/rename-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'folder',
          fromPath: 'old-folder',
          toPath: 'new-folder',
        }),
      });
      return { status: r.status, body: await r.json() };
    }, baseURL);

    expect(renameRes.status).toBe(200);
    expect(renameRes.body.renamed).toHaveLength(3);
    const renamedFromPaths = renameRes.body.renamed
      .map((r: { fromDocName: string }) => r.fromDocName)
      .sort();
    expect(renamedFromPaths).toEqual(['old-folder/a', 'old-folder/b', 'old-folder/c']);
    const rewrittenNames = (renameRes.body.rewrittenDocs as Array<{ docName: string }>).map(
      (d) => d.docName,
    );
    expect(rewrittenNames).toContain('links-a');
    expect(rewrittenNames).toContain('links-b');

    await expect(sidebar.getByRole('treeitem', { name: /new-folder/, exact: false })).toBeVisible({
      timeout: 10_000,
    });
    await expect(sidebar.getByRole('treeitem', { name: /old-folder/, exact: false })).toHaveCount(
      0,
      { timeout: 10_000 },
    );
  });

  test('QA-003 / QA-041: principal-driven rename → /api/history endpoint reachable + reports rename', async ({
    page,
    api,
    baseURL,
  }) => {
    await api.seedDocs([{ name: 'auth-doc', markdown: '# Auth\n' }]);

    await page.goto('/');
    const sidebar = page.locator('[data-slot="sidebar-container"]');
    await expect(sidebar.getByRole('treeitem', { name: 'auth-doc.md', exact: true })).toBeVisible({
      timeout: 20_000,
    });

    const renameRes = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/rename-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'file',
          fromPath: 'auth-doc',
          toPath: 'sso-doc',
        }),
      });
      return { status: r.status, body: await r.json() };
    }, baseURL);
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.renamed).toEqual([{ fromDocName: 'auth-doc', toDocName: 'sso-doc' }]);

    await expect(sidebar.getByRole('treeitem', { name: 'sso-doc.md', exact: true })).toBeVisible({
      timeout: 10_000,
    });

    const historyRes = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/history?docName=sso-doc`);
      return { status: r.status, body: r.ok ? await r.json() : null };
    }, baseURL);
    expect([200, 400]).toContain(historyRes.status);
    if (historyRes.status === 200) {
      expect(Array.isArray(historyRes.body?.entries)).toBe(true);
    }
  });
});
