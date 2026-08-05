/**
 * The Simplified-Chinese coverage sweep, run by a machine.
 *
 * Both an unwrapped string and an untranslated one fall back to English, so in a
 * Han-script UI every gap shows up as conspicuous Latin text. That is what makes
 * `zh-Hans` the coverage instrument rather than a quality one: finding the gaps
 * needs no Chinese at all, only the ability to notice Latin letters.
 *
 * The completeness gate (`scripts/check-i18n-picker-completeness.mjs`) already
 * proves the *untranslated* half is empty. What only a running app can show is
 * the *unwrapped* half — copy that never entered the catalog and therefore never
 * appears in it as missing.
 *
 * The discriminator is the one measured for `no-unwrapped-user-facing-string.grit`:
 * two letter-runs separated by whitespace, at the documented cost of single-word
 * copy, which a screen full of Han script would surface to a human reviewer
 * anyway. Note "run", not "word": the pattern accepts a one-letter second run,
 * so `Ctrl N` reads as prose to it.
 *
 * That is why the Latin token families the chrome legitimately renders are NOT
 * excluded by the pattern itself. `Cmd+K` and `guides/**\/*` merely happen to
 * carry a non-space separator; anything that spells its token with a space needs
 * an explicit exemption in `SKIP` below. Key chords are the case that proved it.
 *
 * Runnable via `pnpm exec playwright test tests/stress/zh-hans-coverage-sweep.e2e.ts`;
 * wired into the CI `test:e2e` subset (packages/app/package.json).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'ok-sweep-home-'));

test.use({ workerServerEnv: { HOME: ISOLATED_HOME } });

/**
 * Latin runs that are correct in any locale.
 *
 * Proper nouns, product names, and format names carry through every catalog
 * byte-for-byte per `src/locales/GLOSSARY.md`; a sweep that flagged them would
 * be reporting the glossary working as designed. Longest form first, so
 * `Claude Code` is consumed before the bare `Claude` can split it.
 */
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

/**
 * Chrome text, with the subtrees that legitimately hold Latin removed.
 *
 * User-authored text is skipped by its own isolation markers rather than by a
 * hand-list of selectors: `UserText` renders `<bdi>` and the remaining sites
 * carry `dir="auto"`, so the same markup that keeps a filename from being
 * bidi-reordered also identifies it as not-ours-to-translate here.
 *
 * `hanNodes` comes back so an empty `latin` can be shown to mean "the chrome
 * rendered in Chinese and held no English" rather than "the walker reached
 * nothing".
 */
async function sweepChrome(page: Page): Promise<Sweep> {
  return page.evaluate(
    ({ exempt }) => {
      // `[data-slot$="-shortcut"]` covers the four shadcn chips (command,
      // menubar, dropdown-menu, context-menu) that render a key chord. Key names
      // are the physical keys and stay Latin in every locale, which is why the
      // header calls them an excluded token family — but that exclusion had been
      // resting on the `+` in `Cmd+K` keeping a word-space-word match from
      // forming. The registry writes its labels space-separated (`Ctrl J`, `⌘ J`),
      // so on Windows and Linux they read as prose to the matcher. macOS hides
      // this: `⌘ J` has no second Latin word, so the glyph alone kept the sweep
      // quiet on a developer's machine and only CI ever saw it.
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
  // The whole file shares one server and therefore one stored preference, so the
  // control's accessible name is whatever the previous test left behind.
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

    // Navigate rather than dismissing the dialog: this file opens settings by
    // hash from a fresh context, so Escape pops history back to `about:blank`,
    // where a sweep finds nothing and reports it as a clean bill of health.
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

  // Same walker, same page, one locale apart: this is what makes an empty result
  // above evidence rather than an artifact of a sweep that reaches nothing.
  test('the same sweep finds English prose when the locale is English', async ({ page }) => {
    await activate(page, 'English', 'en');

    const sweep = await sweepChrome(page);
    expect(sweep.hanNodes).toBe(0);
    expect(sweep.latin.length).toBeGreaterThan(20);
  });
});
