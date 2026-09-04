import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  expect,
  test,
  type WorkerServer,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

async function readDocumentContent(page: Page, docName: string): Promise<string> {
  const docRes = await page.request.get(`/api/document?docName=${encodeURIComponent(docName)}`);
  if (!docRes.ok()) return '';
  const body = (await docRes.json()) as { content?: string };
  return body.content ?? '';
}

function readDiskFileContent(workerServer: WorkerServer, relPath: string): string {
  const filePath = join(workerServer.contentDir, relPath);
  if (!existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf-8');
}

test.describe('asset-embed — rename stability (SPEC §6 FR-7 / P5.1 / P5.1a / D-K)', () => {
  test('P5.1: rename doc with ![alt](path) image ref rewrites path', async ({ page, api }) => {
    const suffix = randomUUID().slice(0, 8);
    const origDoc = `rename-a-${suffix}`;
    await api.createPage(`docs/${origDoc}.md`);
    await api.replaceDoc(`docs/${origDoc}`, '# First Draft\n\n![first draft](first-draft.png)\n');
    await expect
      .poll(() => readDocumentContent(page, `docs/${origDoc}`), { timeout: 10_000 })
      .toContain('![first draft](first-draft.png)');

    await page.goto(`/#/docs/${origDoc}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    const renameRes = await page.request.post('/api/rename-path', {
      data: {
        kind: 'file',
        fromPath: `docs/${origDoc}.md`,
        toPath: `archive/2026/${origDoc}.md`,
      },
    });
    expect(renameRes.ok()).toBe(true);

    await expect
      .poll(() => readDocumentContent(page, `archive/2026/${origDoc}`), { timeout: 10_000 })
      .toContain('![first draft](../../docs/first-draft.png)');
  });

  test('P5.1a: rename doc with ![[name.ext]] wiki-embed ref — body stays byte-identical', async ({
    page,
    api,
    workerServer,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const origDoc = `rename-b-${suffix}`;
    await api.createPage(`docs/${origDoc}.md`);
    const originalBody = '# First Draft\n\n![[first-draft.png]]\n';
    await api.replaceDoc(`docs/${origDoc}`, originalBody);
    await expect
      .poll(() => readDocumentContent(page, `docs/${origDoc}`), { timeout: 10_000 })
      .toContain('![[first-draft.png]]');
    await expect
      .poll(() => readDiskFileContent(workerServer, `docs/${origDoc}.md`), { timeout: 10_000 })
      .toContain('![[first-draft.png]]');

    await page.goto(`/#/docs/${origDoc}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    const renameRes = await page.request.post('/api/rename-path', {
      data: {
        kind: 'file',
        fromPath: `docs/${origDoc}.md`,
        toPath: `archive/2026/${origDoc}.md`,
      },
    });
    expect(renameRes.ok()).toBe(true);

    await expect
      .poll(() => readDiskFileContent(workerServer, `archive/2026/${origDoc}.md`), {
        timeout: 10_000,
      })
      .toContain('![[first-draft.png]]');
  });
});
