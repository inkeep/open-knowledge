import { randomUUID } from 'node:crypto';
import {
  expect,
  externalLinkCueSnapshot,
  hasExternalCue,
  placeCaretAtEndOfText,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

test('a remote caret inside an external link does not duplicate the external-link cue', async ({
  page,
  api,
}) => {
  const docName = `test-external-link-cue-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([
    {
      name: docName,
      markdown:
        '# Cue\n\nTicket list: [Open Knowledge Burn Down](https://linear.app/burn-down).\n\nChips [[https://a.example.com|Alpha]][[https://b.example.com|Beta]] touch.\n',
    },
  ]);

  const editorTab = await page.context().newPage();
  await Promise.all([page.goto(`/#/${docName}`), editorTab.goto(`/#/${docName}`)]);
  await Promise.all([waitForActiveProviderSynced(page), waitForActiveProviderSynced(editorTab)]);
  await expect(
    page.locator('.ProseMirror [data-link] [data-resolution-state="external"]'),
  ).toHaveText('Open Knowledge Burn Down');

  await placeCaretAtEndOfText(editorTab, 'Open Kno');

  await expect(page.locator('.ProseMirror [data-link] .collaboration-cursor__caret')).toHaveCount(
    1,
  );
  const cueSnapshot = await externalLinkCueSnapshot(page, '[data-link]');
  expect(cueSnapshot.map((entry) => entry.text)).toEqual(['Open Kno', 'wledge Burn Down']);
  expect(cueSnapshot.filter((entry) => hasExternalCue(entry.afterContent))).toHaveLength(1);
  expect(hasExternalCue(cueSnapshot.at(-1)?.afterContent ?? 'none')).toBe(true);

  const chipSnapshot = await externalLinkCueSnapshot(page, 'p:has([data-wiki-link])');
  expect(chipSnapshot.map((entry) => entry.text)).toEqual(['Alpha', 'Beta']);
  expect(chipSnapshot.every((entry) => hasExternalCue(entry.afterContent))).toBe(true);

  await editorTab.close();
});
