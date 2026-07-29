/**
 * Timeline recovered-content restore — real-browser click-restore journey.
 *
 * A silent rescue checkpoint (the observer bridge writes these on a content-loss
 * event) must surface in the Timeline as an ordinary "Recovered content" version
 * and restore its content into the live editor through the same
 * `POST /api/rollback` spine as any older version. This is the browser-tier
 * proof of the timeline recovery floor: the recovered content actually lands in
 * the ProseMirror editor over a real WebSocket + real shadow-git rollback — the
 * fidelity no jsdom mount reaches. The confirm-dialog gating and the rollback
 * request shape are pinned deterministically in `TimelinePanel.dom.test.tsx`;
 * commit timing decides whether this journey hits the instant or the confirmed
 * restore path, so it handles both.
 *
 * Requires: Playwright browsers installed. Per-worker dev server (git enabled
 * via `OK_TEST_GIT_ENABLED=1`) from the `workerServer` fixture.
 */

import { randomUUID } from 'node:crypto';
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { saveInMemoryCheckpoint } from '@inkeep/open-knowledge-server';
import { expect, test } from './_helpers';

test.describe('timeline recovered-content restore', () => {
  test('a silent rescue checkpoint restores its content from the timeline', async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = `recovered-${randomUUID().slice(0, 8)}`;
    const liveMarker = `LIVE-BODY-${randomUUID().slice(0, 8)}`;
    const rescuedMarker = `RESCUED-BODY-${randomUUID().slice(0, 8)}`;
    const liveBody = `# Live heading\n\n${liveMarker}\n`;
    const rescued = `# Rescued heading\n\n${rescuedMarker}\n`;

    // Seed the live doc the user is currently editing.
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, liveBody);

    // Seed a silent bridge-merge-loss checkpoint into the SAME shadow repo the
    // dev server reads — the way the observer bridge does on a real loss. The
    // dev server (a separate process) holds the shadow writer lock, so open a
    // lock-free handle rather than initShadowRepo: a checkpoint is a single
    // atomic write to a ref keyed by its own commit sha, so it can't collide
    // with the server's WIP writes. The extension-less `contentRoot: ''` + bare
    // docName matches production's Hocuspocus doc name (the restore floor).
    const shadowDir = resolveShadowDir(workerServer.contentDir);
    const silentSha = await saveInMemoryCheckpoint(
      { gitDir: shadowDir, workTree: workerServer.contentDir },
      '',
      {
        kind: 'bridge-merge-loss',
        docName,
        contents: rescued,
        branch: 'main',
        label: 'Before concurrent merge',
        metadata: { lostSubstrings: [rescuedMarker] },
      },
    );
    expect(silentSha).toHaveLength(40);

    // Open the doc; the editor shows the live content first.
    await page.goto(`/#/${docName}`);
    await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
      timeout: 15_000,
    });
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    const editor = page.locator('.ProseMirror:not(.composer-prosemirror)');
    await expect(editor.getByText(liveMarker)).toBeVisible();

    // Open the Timeline tab — the rescue checkpoint surfaces as an ordinary
    // "Recovered content" row (internals-free label, no badge).
    await page.getByRole('tab', { name: 'Timeline' }).click();
    const recoveredRow = page
      .getByTestId('timeline-entry-open')
      .filter({ hasText: 'Recovered content' });
    await expect(recoveredRow).toBeVisible();
    // The internal checkpoint kind never leaks into the UI.
    await expect(page.getByText('bridge-merge-loss')).toHaveCount(0);

    // Restore it. Depending on commit timing the row may be newest (instant) or
    // have later edits above it (confirm dialog) — handle both; the gating
    // itself is pinned in the dom test.
    await recoveredRow.getByTestId('timeline-entry-restore').click();
    await page
      .getByTestId('timeline-entry-restore-confirm')
      .click({ timeout: 4_000 })
      .catch(() => {
        // No dialog → instant restore already fired (row was newest).
      });

    // The recovered content lands in the editor via the real rollback + CRDT
    // round-trip; the previous live body is gone.
    await expect(editor.getByText(rescuedMarker)).toBeVisible({ timeout: 15_000 });
    await expect(editor.getByText(liveMarker)).toHaveCount(0);
  });
});
