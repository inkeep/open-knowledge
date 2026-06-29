import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

function uniqueDocName(label: string): string {
  return `test-find-replace-${label}-${randomUUID().slice(0, 8)}`;
}

function replaceShortcut(): string {
  return process.platform === 'darwin' ? 'Meta+Alt+F' : 'Control+H';
}

async function getYText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

function visibleScrollContainer(page: Page) {
  return page.locator('[data-testid="editor-scroll-container"]:visible');
}

async function activeFindMatchIsInsideScrollport(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const scrollContainer = Array.from(
      document.querySelectorAll('[data-testid="editor-scroll-container"]'),
    ).find((element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      return element.getClientRects().length > 0;
    });
    const activeMatch = scrollContainer?.querySelector('.ok-find-match-active');
    if (!scrollContainer || !(activeMatch instanceof HTMLElement)) return false;

    const scrollRect = scrollContainer.getBoundingClientRect();
    const matchRect = activeMatch.getBoundingClientRect();
    return matchRect.top >= scrollRect.top && matchRect.bottom <= scrollRect.bottom;
  });
}

async function activeElementIsEditor(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.classList.contains('ProseMirror') ?? false);
}

async function externalLinkCueSnapshot(page: Page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('.ProseMirror [data-resolution-state="external"]'),
    ).map((element) => ({
      text: element.textContent ?? '',
      afterContent: window.getComputedStyle(element, '::after').content,
    })),
  );
}

function hasExternalCue(afterContent: string): boolean {
  return !['none', 'normal', '""', "''"].includes(afterContent);
}

test('TipTap find/replace highlights, navigates, replaces current, and replaces all', async ({
  page,
  api,
}) => {
  const docName = uniqueDocName('active-doc');
  await api.seedDocs([
    {
      name: docName,
      markdown:
        '# Find Replace\n\nneedle one needle two.\n\nKeep this paragraph unchanged.\n\nneedle three.',
    },
  ]);

  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.ProseMirror')).toContainText('needle one');

  await page.keyboard.press(replaceShortcut());
  const bar = page.getByTestId('find-replace-bar');
  await expect(bar).toBeVisible();

  const findInput = bar.getByRole('textbox', { name: 'Find' });
  await expect(findInput).toBeFocused();
  await findInput.fill('needle');

  await expect(bar).toContainText('1 / 3');
  await expect(page.locator('.ok-find-match')).toHaveCount(3);
  await expect(page.locator('.ok-find-match-active')).toHaveCount(1);

  await page.keyboard.press('Enter');
  await expect(bar).toContainText('2 / 3');
  await expect(page.locator('[data-testid="bubble-menu-bar"]:visible')).toHaveCount(0);

  await bar.getByRole('textbox', { name: 'Replace' }).fill('marker');
  await bar.getByRole('button', { name: 'Replace current match' }).click();
  await expect.poll(() => getYText(page)).toContain('needle one marker two');
  await expect(bar).toContainText('2 / 2');

  await bar.getByRole('button', { name: 'Replace all matches' }).click();
  await expect.poll(() => getYText(page)).toContain('marker one marker two');
  await expect.poll(() => getYText(page)).toContain('marker three');
  await expect.poll(() => getYText(page)).toContain('Keep this paragraph unchanged.');
  await expect.poll(() => getYText(page)).not.toContain('needle');

  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  await expect.poll(() => activeElementIsEditor(page)).toBe(true);

  await page.keyboard.press('ControlOrMeta+f');
  await expect(bar).toBeVisible();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(bar).toBeHidden();
  await expect.poll(() => activeElementIsEditor(page)).toBe(true);
});

test('TipTap find navigation scrolls an off-screen active match into view', async ({
  page,
  api,
}) => {
  const docName = uniqueDocName('scroll');
  const filler = Array.from(
    { length: 80 },
    (_, index) =>
      `Filler paragraph ${index + 1} with enough plain text to create a real scroll distance.`,
  ).join('\n\n');

  await api.seedDocs([
    {
      name: docName,
      markdown: `# Find Scroll\n\nscrollneedle first\n\n${filler}\n\nscrollneedle second`,
    },
  ]);

  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.ProseMirror')).toContainText('scrollneedle first');

  const scrollContainer = visibleScrollContainer(page);
  await expect(scrollContainer).toHaveCount(1);
  await scrollContainer.evaluate((element) => {
    if (element instanceof HTMLElement) element.scrollTop = 0;
  });

  await page.keyboard.press('ControlOrMeta+f');
  const bar = page.getByTestId('find-replace-bar');
  await expect(bar).toBeVisible();

  const findInput = bar.getByRole('textbox', { name: 'Find' });
  await findInput.fill('scrollneedle');
  await expect(bar).toContainText('1 / 2');

  await page.keyboard.press('Enter');
  await expect(bar).toContainText('2 / 2');
  await expect
    .poll(() =>
      scrollContainer.evaluate((element) =>
        element instanceof HTMLElement ? element.scrollTop : 0,
      ),
    )
    .toBeGreaterThan(0);
  await expect.poll(() => activeFindMatchIsInsideScrollport(page)).toBe(true);
});

test('TipTap find navigation does not show table controls inside table matches', async ({
  page,
  api,
}) => {
  const docName = uniqueDocName('table-controls');
  await api.seedDocs([
    {
      name: docName,
      markdown: [
        '# Find Table Controls',
        '',
        '| Project | Command |',
        '| --- | --- |',
        '| open-knowledge clean | ok clean |',
        '| open-knowledge stop | ok stop |',
        '| open-knowledge ui | ok ui |',
      ].join('\n'),
    },
  ]);

  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.ProseMirror table')).toHaveCount(1);

  await page.keyboard.press('ControlOrMeta+f');
  const bar = page.getByTestId('find-replace-bar');
  await expect(bar).toBeVisible();

  const findInput = bar.getByRole('textbox', { name: 'Find' });
  await findInput.fill('open-knowledge');
  await expect(bar).toContainText('1 / 3');

  await page.keyboard.press('Enter');
  await expect(bar).toContainText('2 / 3');
  await expect(page.locator('[data-testid="table-cell-handle"]:visible')).toHaveCount(0);
});

test('TipTap find does not duplicate the external-link cue across split link matches', async ({
  page,
  api,
}) => {
  const docName = uniqueDocName('external-link-cue');
  await api.seedDocs([
    {
      name: docName,
      markdown: '# External Link\n\n[https://nextra.site](https://nextra.site)\n',
    },
  ]);

  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.ProseMirror [data-resolution-state="external"]')).toContainText(
    'https://nextra.site',
  );
  const baseline = await externalLinkCueSnapshot(page);
  expect(baseline).toHaveLength(1);
  expect(hasExternalCue(baseline[0]?.afterContent ?? 'none')).toBe(true);

  await page.keyboard.press('ControlOrMeta+f');
  const bar = page.getByTestId('find-replace-bar');
  await expect(bar).toBeVisible();
  await bar.getByRole('textbox', { name: 'Find' }).fill('nextra');
  await expect(bar).toContainText('1 / 1');

  const cueSnapshot = await externalLinkCueSnapshot(page);
  expect(cueSnapshot.map((entry) => entry.text)).toEqual(['https://', 'nextra', '.site']);
  expect(cueSnapshot.filter((entry) => hasExternalCue(entry.afterContent))).toHaveLength(1);
  expect(hasExternalCue(cueSnapshot.at(-1)?.afterContent ?? 'none')).toBe(true);
});
