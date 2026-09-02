import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

test.describe('Skills Studio', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Deep-link project open is macOS-only in v0.');
  test.skip(!BUILD_EXISTS, `Main build missing at ${MAIN_ENTRY} — run "pnpm run build:desktop".`);

  test('installs from the first-visit intro, states what skills are for, and keeps AI tools to connections', async ({
    captureStderrFor,
  }) => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-skills-studio-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-skills-studio-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
    writeFileSync(join(projectDir, 'note.md'), '# Note\n');

    mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(tmpHome, '.claude', 'skills', 'open-knowledge-discovery'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.claude', 'skills', 'open-knowledge-discovery', 'SKILL.md'),
      '---\nname: open-knowledge-discovery\ndescription: "seeded"\n---\n',
    );

    const userDataDir = join(tmpHome, 'electron-userdata');
    mkdirSync(userDataDir, { recursive: true });
    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=note`;

    const app = await electron.launch({
      args: [MAIN_ENTRY, deepLink, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, HOME: tmpHome, OK_M6B_FORCE: '1' },
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [projectDir, tmpHome] });
    await app.firstWindow({ timeout: 15_000 });

    const page = await (async () => {
      for (let i = 0; i < 60; i++) {
        for (const w of app.windows()) {
          const hash = await w.evaluate(() => window.location.hash).catch(() => '');
          if (hash.includes('note')) return w;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('project window never mounted from the argv deep-link');
    })();

    await page.getByTestId('header-settings-button').click();

    const navItem = page.getByTestId('settings-sidebar-item-user-skills');
    await expect(navItem).toBeVisible({ timeout: 10_000 });
    expect((await navItem.textContent())?.trim()).toBe('Skills Studio');
    await navItem.click();

    const intro = page.getByTestId('skills-studio-intro');
    await expect(intro).toBeVisible({ timeout: 10_000 });
    await expect(intro).toContainText('Skills teach your AI tools repeatable tasks');
    await expect(intro).toContainText('open-knowledge-write-skill');
    await expect(intro).toContainText('How to write a new skill and install it.');
    await expect(intro).not.toContainText('open-knowledge-discovery');

    await page.getByTestId('skills-studio-intro-install').click();
    await expect(intro).toBeHidden();
    const installedPath = join(tmpHome, '.claude', 'skills', 'open-knowledge-write-skill');
    await expect(async () => {
      expect(existsSync(join(installedPath, 'SKILL.md'))).toBe(true);
    }).toPass({ timeout: 20_000 });
    await expect(
      page.getByTestId('settings-builtin-skills').getByTestId('skill-consent-row-no-hosts'),
    ).toHaveCount(0, { timeout: 15_000 });

    const section = page.getByTestId('settings-builtin-skills');
    await expect(section).toContainText('Skills from OpenKnowledge');
    await expect(section).toContainText('How to set up new projects with OpenKnowledge.');
    await expect(section).not.toContainText('Do NOT load');
    await expect(section).not.toContainText('Read when the user asks');

    const folders = page.getByTestId('settings-skill-folders');
    await expect(folders).toContainText('Share skills between AI tools');
    await expect(folders).toContainText('Each AI tool reads skills from its own folder');

    await page.keyboard.press('Escape');
    await page.getByTestId('header-settings-button').click();
    await page.getByTestId('settings-sidebar-item-user-skills').click();
    await expect(page.getByTestId('settings-builtin-skills')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('skills-studio-intro')).toBeHidden();

    await page.getByTestId('settings-sidebar-item-ai-tools').click();
    const aiTools = page.getByTestId('ai-tools-skills-moved');
    await expect(aiTools).toBeVisible();
    await expect(aiTools).toContainText('Skills Studio');
    await expect(page.getByTestId('skills-studio-skill-uninstall-write-skill')).toBeHidden();

    await page.getByTestId('settings-sidebar-item-skills').click();
    const projectSkill = page.getByTestId('settings-project-skill');
    await expect(projectSkill).toBeVisible({ timeout: 10_000 });
    await expect(projectSkill).toContainText('Skills from OpenKnowledge');
    await expect(projectSkill).toContainText('everyone who opens the project');

    const shotDir = resolve(__dirname, '..', '..', 'tmp');
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: join(shotDir, 'qa-skills-studio.png') });
  });
});
