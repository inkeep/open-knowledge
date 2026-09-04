import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'ok-sweep-home-'));

test.use({ workerServerEnv: { HOME: ISOLATED_HOME } });

const NEVER_TRANSLATED = [
  'GitHub Enterprise Server',
  'Visual Studio Code',
  'GitHub Copilot',
  'Claude Desktop',
  'Open Knowledge',
  'OpenKnowledge',
  'Claude Agent',
  'Claude Code',
  'Claude CLI',
  'OK Desktop',
  'CodeMirror',
  'Codex CLI',
  'Antigravity',
  'OpenCode',
  'Windsurf',
  'Markdown',
  'Node.js',
  'Mermaid',
  'skills.sh',
  'DevOps',
  'OpenAI',
  'Hermes',
  'Cursor',
  'TipTap',
  'base16',
  'Claude',
  'GitHub',
  'Cline',
  'Codex',
  'KaTeX',
  'React',
];

type Sweep = { latin: string[]; visitedNodes: number; hanNodes: number };

async function sweepChrome(page: Page): Promise<Sweep> {
  return page.evaluate(
    ({ exempt }) => {
      const SKIP =
        'bdi, [dir="auto"], code, pre, kbd, samp, [data-slot$="-shortcut"], .ProseMirror, .cm-editor, script, style';
      const latin = new Set<string>();
      let visitedNodes = 0;
      let hanNodes = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest(SKIP)) continue;
        if (!parent.checkVisibility?.({ checkOpacity: false, checkVisibilityCSS: true })) continue;

        const raw = (node.textContent ?? '').trim();
        if (!raw) continue;
        visitedNodes++;
        if (/[一-鿿]/.test(raw)) hanNodes++;

        let text = raw;
        for (const term of exempt) text = text.split(term).join(' ');
        for (const match of text.matchAll(/[A-Za-z]+(?:\s+[A-Za-z]+)+/g)) {
          latin.add(match[0].trim());
        }
      }
      return { latin: [...latin], visitedNodes, hanNodes };
    },
    { exempt: NEVER_TRANSLATED },
  );
}

async function activate(page: Page, optionName: string, expectedLang: string) {
  await page.goto('/#settings');
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 15_000 });
  const trigger = page.getByRole('combobox', { name: /Language|语言|Idioma/ });
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.getByRole('option', { name: optionName }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', expectedLang, { timeout: 15_000 });
}

test.describe('zh-Hans coverage sweep', () => {
  test('the settings chrome renders no stray English prose', async ({ page }) => {
    await activate(page, '简体中文', 'zh-Hans');

    const sweep = await sweepChrome(page);
    expect(sweep.hanNodes).toBeGreaterThan(20);
    expect(sweep.latin).toEqual([]);
  });

  test('the app shell and command palette render no stray English prose', async ({ page }) => {
    await activate(page, '简体中文', 'zh-Hans');

    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans', { timeout: 15_000 });
    await expect(page.getByText('创造点了不起的东西。')).toBeVisible({ timeout: 15_000 });

    const shell = await sweepChrome(page);
    expect(shell.hanNodes).toBeGreaterThan(5);
    expect(shell.latin).toEqual([]);

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('[cmdk-root]')).toBeVisible({ timeout: 10_000 });

    const palette = await sweepChrome(page);
    expect(palette.hanNodes).toBeGreaterThan(shell.hanNodes);
    expect(palette.latin).toEqual([]);
  });

  test('the same sweep finds English prose when the locale is English', async ({ page }) => {
    await activate(page, 'English', 'en');

    const sweep = await sweepChrome(page);
    expect(sweep.hanNodes).toBe(0);
    expect(sweep.latin.length).toBeGreaterThan(20);
  });
});
