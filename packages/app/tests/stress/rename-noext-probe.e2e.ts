
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { expect, test } from './_helpers';

const MARKER = 'zebra-marker-noext-PROBE';
const DOC_CONTENT = `# Probe

This is a probe document. Marker: ${MARKER}.

Paragraph two.

Paragraph three.
`;

const YDOC_REHYDRATE_BUDGET_MS = 15_000;
const YDOC_POLL_INTERVAL_MS = 250;

test.describe('PROBE: sidebar rename — no-extension typed', () => {
  test('rename without .md still preserves content in Y.Doc + disk', async ({
    page,
    api,
    workerServer,
  }) => {
    const baseURL = `http://127.0.0.1:${workerServer.port}`;
    const suffix = randomUUID().slice(0, 8);
    const srcName = `probe-src-${suffix}`;
    const dstName = `probe-dst-${suffix}`;

    await api.seedDocs([{ name: srcName, markdown: DOC_CONTENT }]);
    await page.goto(`/#/${srcName}`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.ProseMirror')).toContainText(MARKER, { timeout: 15_000 });

    const srcDoc = await (await fetch(`${baseURL}/api/document?docName=${srcName}`)).json();
    console.log(`[PROBE] BEFORE rename — server Y.Doc for ${srcName}:`, {
      contentLen: (srcDoc as { content?: string }).content?.length ?? 0,
      preview: ((srcDoc as { content?: string }).content ?? '').slice(0, 80),
    });
    expect((srcDoc as { content?: string }).content?.length ?? 0).toBeGreaterThan(0);

    const sourceItem = page.getByRole('treeitem', { name: new RegExp(`${srcName}\\.md`) });
    await sourceItem.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /rename/i }).click({ timeout: 5_000 });
    const renameInput = page.getByRole('textbox', {
      name: new RegExp(`rename ${srcName}\\.md`, 'i'),
    });
    await renameInput.fill(dstName);
    await renameInput.press('Enter');

    let dstContent = '';
    const deadline = Date.now() + YDOC_REHYDRATE_BUDGET_MS;
    while (Date.now() < deadline) {
      const r = await fetch(`${baseURL}/api/document?docName=${dstName}`).catch(() => null);
      if (r) {
        const j = (await r.json().catch(() => ({}))) as { content?: string };
        dstContent = j.content ?? '';
        if (dstContent.includes(MARKER)) break;
      }
      await wait(YDOC_POLL_INTERVAL_MS);
    }

    const newDiskPath = join(workerServer.contentDir, `${dstName}.md`);
    const oldDiskPath = join(workerServer.contentDir, `${srcName}.md`);
    const diskContent = existsSync(newDiskPath) ? readFileSync(newDiskPath, 'utf-8') : null;
    console.log('[PROBE] AFTER rename — disk:', {
      newPath: newDiskPath,
      newPathExists: existsSync(newDiskPath),
      newPathLength: diskContent?.length ?? 0,
      oldPathExists: existsSync(oldDiskPath),
    });

    expect(existsSync(newDiskPath)).toBe(true);
    expect(diskContent ?? '').toContain(MARKER);
    expect(existsSync(oldDiskPath)).toBe(false);

    const dstYDocLen = dstContent.length;
    console.log(`[PROBE] AFTER rename — server Y.Doc for ${dstName}:`, {
      contentLen: dstYDocLen,
      preview: dstContent.slice(0, 120),
    });

    expect(dstYDocLen).toBeGreaterThan(0);
    expect(dstContent).toContain(MARKER);
  });
});
