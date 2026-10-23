import { randomUUID } from 'node:crypto';
import { expect, simulateCopyAndRead, test, waitForActiveProviderSynced } from './_helpers';

test('mixed task lists keep ordinary bullet markers at every nesting level', async ({
  page,
  api,
}) => {
  const docName = `mixed-list-markers-${randomUUID()}`;
  await api.seedDocs([
    {
      name: docName,
      markdown: [
        '# Mixed list markers',
        '',
        '- One',
        '- [ ] Two',
        '- Three',
        '  - Nested one',
        '  - [x] Nested two',
        '  - Nested three',
        '    - Deep one',
        '    - [ ] Deep two',
        '    - Deep three',
        '',
        '## Task-only list',
        '',
        '- [ ] Task only one',
        '- [x] Task only two',
        '',
      ].join('\n'),
    },
  ]);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)');
  await expect(editor).toBeVisible();

  for (const [text, marker] of [
    ['One', 'disc'],
    ['Nested one', 'circle'],
    ['Deep one', 'square'],
  ] as const) {
    const item = editor.locator('li').filter({ hasText: new RegExp(`^${text}$`) });
    await expect(item).toHaveCSS('display', 'list-item');
    await expect(item).toHaveCSS('list-style-type', marker);
  }

  const tasks = editor.locator('ul').filter({ hasText: 'Task only one' });
  await expect(tasks).toHaveCSS('padding-left', '0px');
  const checkbox = editor.getByRole('checkbox').first();
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await expect(editor.locator('li').filter({ hasText: /^One$/ })).toHaveCSS(
    'list-style-type',
    'disc',
  );

  const copied = await simulateCopyAndRead(page);
  const copiedTaskMarkers = await page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(
      document.querySelectorAll<HTMLLIElement>('li[data-type="taskItem"]'),
      (item) => item.style.listStyleType,
    );
  }, copied.html);
  expect(copiedTaskMarkers).toEqual(Array(5).fill('none'));
});
