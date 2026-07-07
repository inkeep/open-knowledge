/**
 * Permanent dev-renderer companion to the desktop regression probe
 * `packages/desktop/tests/smoke/rename-divergence-probe.e2e.ts`.
 *
 * What this guards: the spine ordering invariant — disk move completes
 * before the forced-reconnect close — must hold for both renderer build
 * modes. The desktop probe pins the invariant against the production-
 * built renderer (where the regression originally surfaced because the
 * faster reconnect was able to overtake an in-flight disk move). This
 * companion pins it against the dev (Vite) renderer so a future spine
 * change cannot regress only one build mode.
 *
 * Drives the same sidebar inline-rename gesture (no `.md` extension
 * typed) against the dev server's integration harness and asserts the
 * destination's server Y.Doc — via `/api/document?docName=…`, the layer
 * where the regression manifested — still contains the original marker.
 */

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

// Bounded poll budget for the destination Y.Doc to rehydrate (mirrors the
// desktop probe). A fixed sleep risks a false-RED on a slow runner but never
// a false-GREEN: if the rename ever lost the body the marker would never
// appear and the assertion would still fail after the budget.
const YDOC_REHYDRATE_BUDGET_MS = 15_000;
const YDOC_POLL_INTERVAL_MS = 250;

test.describe('PROBE: sidebar rename — no-extension typed', () => {
  test('rename without .md still preserves content in Y.Doc + disk', async ({
    page,
    api,
    workerServer,
  }) => {
    const baseURL = `http://127.0.0.1:${workerServer.port}`;
    // Per-test unique docNames so concurrent workers (and `--repeat-each`
    // nightly runs) cannot collide on `contentDir` (matches the desktop
    // probe's randomUUID pattern + OK STOP rule for Playwright tests).
    const suffix = randomUUID().slice(0, 8);
    const srcName = `probe-src-${suffix}`;
    const dstName = `probe-dst-${suffix}`;

    await api.seedDocs([{ name: srcName, markdown: DOC_CONTENT }]);
    await page.goto(`/#/${srcName}`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText(MARKER, {
      timeout: 15_000,
    });

    // Confirm server Y.Doc has content BEFORE rename.
    const srcDoc = await (await fetch(`${baseURL}/api/document?docName=${srcName}`)).json();
    console.log(`[PROBE] BEFORE rename — server Y.Doc for ${srcName}:`, {
      contentLen: (srcDoc as { content?: string }).content?.length ?? 0,
      preview: ((srcDoc as { content?: string }).content ?? '').slice(0, 80),
    });
    expect((srcDoc as { content?: string }).content?.length ?? 0).toBeGreaterThan(0);

    // Gesture: right-click → Rename → type the new name WITHOUT .md → Enter
    const sourceItem = page.getByRole('treeitem', { name: new RegExp(`${srcName}\\.md`) });
    await sourceItem.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /rename/i }).click({ timeout: 5_000 });
    const renameInput = page.getByRole('textbox', {
      name: new RegExp(`rename ${srcName}\\.md`, 'i'),
    });
    await renameInput.fill(dstName);
    await renameInput.press('Enter');

    // Bounded poll the destination server Y.Doc until the body rehydrates or
    // the budget elapses (instead of a fixed sleep). Exits fast on the happy
    // path; on a regression it never rehydrates and the assertion still fails.
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

    // Disk: file at new path has content; no orphan at old path.
    const newDiskPath = join(workerServer.contentDir, `${dstName}.md`);
    const oldDiskPath = join(workerServer.contentDir, `${srcName}.md`);
    const diskContent = existsSync(newDiskPath) ? readFileSync(newDiskPath, 'utf-8') : null;
    console.log('[PROBE] AFTER rename — disk:', {
      newPath: newDiskPath,
      newPathExists: existsSync(newDiskPath),
      newPathLength: diskContent?.length ?? 0,
      oldPathExists: existsSync(oldDiskPath),
    });

    // ASSERTION 1: disk preserves content
    expect(existsSync(newDiskPath)).toBe(true);
    expect(diskContent ?? '').toContain(MARKER);
    expect(existsSync(oldDiskPath)).toBe(false);

    // Server Y.Doc state.
    const dstYDocLen = dstContent.length;
    console.log(`[PROBE] AFTER rename — server Y.Doc for ${dstName}:`, {
      contentLen: dstYDocLen,
      preview: dstContent.slice(0, 120),
    });

    // ASSERTION 2 (the diagnostic): server Y.Doc has the ORIGINAL body, not
    // just non-empty — a length-only check can't tell "content loaded from
    // the moved file" from "wrong/default content" (matches the desktop
    // probe's marker-presence fidelity).
    expect(dstYDocLen).toBeGreaterThan(0);
    expect(dstContent).toContain(MARKER);
  });
});
