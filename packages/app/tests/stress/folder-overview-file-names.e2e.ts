import { expect, test } from './_helpers';

test.describe('folder overview file names', () => {
  test('each row shows its title, with the file name under a title that differs from it', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'overview-names/burndown', markdown: '# Burndown\n\nRemaining work.\n' },
      {
        name: 'overview-names/do-performance',
        markdown: '---\ntitle: DO performance & capacity\n---\n\nLoad numbers.\n',
      },
      {
        name: 'overview-names/plain-notes',
        markdown: 'Notes with no frontmatter and no heading.\n',
      },
      { name: 'overview-names/ui-tracker', markdown: '# OK Cloud features\n\nWhat to build.\n' },
    ]);

    await page.goto('/#/overview-names/');

    await expect(page.getByRole('table').getByRole('link')).toHaveText(
      [
        'Burndown',
        'DO performance & capacity\ndo-performance.md',
        'OK Cloud features\nui-tracker.md',
        'plain-notes',
      ],
      { useInnerText: true, timeout: 20_000 },
    );
  });
});
