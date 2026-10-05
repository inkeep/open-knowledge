import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  expect,
  externalLinkCueSnapshot,
  hasExternalCue,
  placeCaretAtEndOfText,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

interface DeferredEditorMountWindow {
  __externalLinkEditorRead?: 'getter-missing' | 'pending' | 'empty' | 'mounted';
}

async function deferEditorMountUntilRead(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = window as typeof window & DeferredEditorMountWindow;
    const yieldToBrowser = scheduler.yield.bind(scheduler);
    scheduler.yield = () => {
      scheduler.yield = yieldToBrowser;
      const descriptor = Object.getOwnPropertyDescriptor(window, '__activeEditor');
      const readEditor = descriptor?.get;
      if (!descriptor || !readEditor) {
        probe.__externalLinkEditorRead = 'getter-missing';
        return yieldToBrowser();
      }
      const gate = Promise.withResolvers<void>();
      probe.__externalLinkEditorRead = 'pending';
      Object.defineProperty(window, '__activeEditor', {
        ...descriptor,
        get() {
          const editor = readEditor.call(window);
          probe.__externalLinkEditorRead = editor ? 'mounted' : 'empty';
          Object.defineProperty(window, '__activeEditor', descriptor);
          gate.resolve();
          return editor;
        },
      });
      return gate.promise.then(yieldToBrowser);
    };
  });
}

function firstEditorRead(
  page: Page,
): Promise<DeferredEditorMountWindow['__externalLinkEditorRead']> {
  return page.evaluate(
    () => (window as typeof window & DeferredEditorMountWindow).__externalLinkEditorRead,
  );
}

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
  await deferEditorMountUntilRead(editorTab);
  await Promise.all([page.goto(`/#/${docName}`), editorTab.goto(`/#/${docName}`)]);
  await Promise.all([waitForActiveProviderSynced(page), waitForActiveProviderSynced(editorTab)]);
  await expect(
    page.locator('.ProseMirror [data-link] [data-resolution-state="external"]'),
  ).toHaveText('Open Knowledge Burn Down');

  await expect
    .poll(
      () => firstEditorRead(editorTab),
      "mount gate armed at the editor tab's first scheduler.yield",
    )
    .not.toBeUndefined();
  expect(
    await firstEditorRead(editorTab),
    'active editor getter existed when the mount gate armed',
  ).toBe('pending');
  await expect.poll(() => editorTab.evaluate(() => Boolean(window.__activeEditor))).toBe(true);
  await placeCaretAtEndOfText(editorTab, 'Open Kno');
  expect(
    await firstEditorRead(editorTab),
    'first active editor read came while the mount gate held the mount',
  ).toBe('empty');

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
