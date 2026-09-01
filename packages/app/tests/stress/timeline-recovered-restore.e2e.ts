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

    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, liveBody);

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

    await page.goto(`/#/${docName}`);
    await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
      timeout: 15_000,
    });
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    const editor = page.locator('.ProseMirror:not(.composer-prosemirror)');
    await expect(editor.getByText(liveMarker)).toBeVisible();

    await page.getByRole('tab', { name: 'Timeline' }).click();
    const recoveredRow = page
      .getByTestId('timeline-entry-open')
      .filter({ hasText: 'Recovered content' });
    await expect(recoveredRow).toBeVisible();
    await expect(page.getByText('bridge-merge-loss')).toHaveCount(0);

    await recoveredRow.getByTestId('timeline-entry-restore').click();
    await page
      .getByTestId('timeline-entry-restore-confirm')
      .click({ timeout: 4_000 })
      .catch(() => {});

    await expect(editor.getByText(rescuedMarker)).toBeVisible({ timeout: 15_000 });
    await expect(editor.getByText(liveMarker)).toHaveCount(0);
  });
});
