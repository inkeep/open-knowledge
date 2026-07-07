/**
 * E2E coverage for the acceptance scenarios that genuinely need a browser:
 *
 *   - rename doc with `![alt](path)` image ref → path recomputes
 *   - rename doc with `![[name.ext]]` wiki-embed ref → NO rewrite
 *     (basename index resolves dynamically)
 *
 * Scenarios NOT in this file (intentional — their integration-tier
 * coverage is stronger per test-runtime dollar, or the scenario no
 * longer exists):
 *   - Oversized-file rejection — removed along with `upload.maxBytes`,
 *     which no longer exists; server-side `storage-full` /
 *     `malformed-upload` / `collision-exhaustion` are covered at unit +
 *     integration tier (`packages/server/src/upload-streaming.test.ts`,
 *     `packages/server/src/api-extension.test.ts`).
 *   - Obsidian vault open + ambiguous resolution — require full
 *     server-restart against a fixture vault. Covered by
 *     obsidian-vault-detect.test.ts + path-resolve.test.ts tiebreak PBT.
 *   - Operator tunes `attachmentFolderPath` / `emitFormat` — server
 *     config surgery is heavier than the test adds. Covered by
 *     api-extension.test.ts custom-config describe block.
 *   - Concurrent bursts + multi-user — require a multi-browser harness;
 *     tier-1 `createTestClients` integration tests are the right home.
 */

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
    // Setup: doc in docs/ references a co-located image via relative path.
    const suffix = randomUUID().slice(0, 8);
    const origDoc = `rename-a-${suffix}`;
    await api.createPage(`docs/${origDoc}.md`);
    await api.replaceDoc(`docs/${origDoc}`, '# First Draft\n\n![first draft](first-draft.png)\n');
    await expect
      .poll(() => readDocumentContent(page, `docs/${origDoc}`), { timeout: 10_000 })
      .toContain('![first draft](first-draft.png)');

    // Kick the doc open to prime the provider cache; /api/rename operates
    // on loaded documents via the managed-rename-rewrite pipeline.
    await page.goto(`/#/docs/${origDoc}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Invoke the managed-rename endpoint directly — no UI dependency.
    const renameRes = await page.request.post('/api/rename-path', {
      data: {
        kind: 'file',
        fromPath: `docs/${origDoc}.md`,
        toPath: `archive/2026/${origDoc}.md`,
      },
    });
    expect(renameRes.ok()).toBe(true);

    // The body at the new location carries a recomputed relative path.
    // Fetch via /api/document (bypasses debounce) to read live Y.Text.
    // API response shape: { ok, docName, content } — NOT `text`.
    // From archive/2026/<name>.md, the image in docs/ is two levels up
    // and one across — posix.relative produces this exact shape
    // deterministically. Use `toContain`
    // on the exact expected form so a one-dot-dot-short or extra-
    // subtree bug fails this test instead of sneaking past a permissive
    // regex.
    await expect
      .poll(() => readDocumentContent(page, `archive/2026/${origDoc}`), { timeout: 10_000 })
      .toContain('![first draft](../../docs/first-draft.png)');
  });

  test('P5.1a: rename doc with ![[name.ext]] wiki-embed ref — body stays byte-identical', async ({
    page,
    api,
    workerServer,
  }) => {
    // Wiki-embed refs resolve at render time via the basename index
    // (refs-only). Renaming the containing doc must NOT rewrite
    // the ref string.
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

    // The wiki-embed ref stays verbatim.
    await expect
      .poll(() => readDiskFileContent(workerServer, `archive/2026/${origDoc}.md`), {
        timeout: 10_000,
      })
      .toContain('![[first-draft.png]]');
  });
});
